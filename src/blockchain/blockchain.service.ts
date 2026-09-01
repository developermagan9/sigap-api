import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MerkleService, MerkleLeaf } from './merkle.service';
import { PeriodeProgramService } from '../periode-program/periode-program.service';
import { keccak256, toUtf8Bytes, Contract, Wallet, JsonRpcProvider } from 'ethers';
import { deriveCustodialWallet } from '../common/crypto.util';

/** Basis URL block explorer; jaringan bisa berganti, jadi tidak di-hardcode. */
function explorerBase(): string {
  return process.env.EXPLORER_BASE_URL || 'https://amoy.polygonscan.com';
}

/**
 * Alamat kontrak yang benar-benar bisa dibuka di explorer.
 *
 * Database yang sudah ada bisa memuat nilai sampah dari versi sebelumnya —
 * `submit-onchain` lama menyimpan `process.env.REGISTRY_CONTRACT_ADDRESS` apa
 * adanya, dan di `.env.example` isinya literal `"0x..."`. Baris seperti itu tidak
 * boleh diperlakukan sebagai alamat sungguhan hanya karena kolomnya tidak NULL.
 */
export function alamatKontrakValid(alamat: string | null | undefined): string | null {
  return alamat && /^0x[0-9a-fA-F]{40}$/.test(alamat) ? alamat : null;
}

// Cuma fragmen yang benar-benar dipanggil dari sini — ABI penuh ada di paket
// sigap-contracts (repo terpisah), sengaja tidak diimpor supaya sigap-api tidak
// bergantung pada artifact build Hardhat.
const REGISTRY_ABI = [
  'function registerPeriode(uint256 periodeId, bytes32 merkleRoot, uint256 totalAlokasi) external',
];

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private merkle: MerkleService,
    private periodeProgramService: PeriodeProgramService,
  ) {}

  /**
   * Build Merkle tree from finalized ranking results.
   */
  async buildMerkle(periodeId: string) {
    const periode = await this.prisma.periodeProgram.findUnique({
      where: { id: periodeId },
    });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }

    if (periode.status !== 'approved') {
      throw new HttpException(
        { code: 'TRANSISI_TIDAK_VALID', message: 'Periode harus dalam status approved untuk membangun Merkle tree' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Fetch final ranking results where terpilih = true
    const rankings = await this.prisma.rankingResult.findMany({
      where: { periodeId, status: 'final', terpilih: true },
      include: {
        rumahTangga: {
          select: {
            id: true,
            nikKkHash: true,
            walletAddress: true,
            jenisWallet: true,
            disbursementRecords: {
              where: { periodeId },
              select: { walletAddress: true, jenisWallet: true },
            },
          },
        },
      },
      orderBy: { rank: 'asc' },
    });

    if (rankings.length === 0) {
      throw new HttpException(
        { code: 'DATA_TIDAK_DITEMUKAN', message: 'Tidak ada data ranking final terpilih' },
        HttpStatus.NOT_FOUND,
      );
    }

    // Build leaves. Prioritas sumber wallet: record disbursement periode ini yang sudah ada
    // (build-merkle diulang) > wallet asli yang dikumpulkan saat pendataan (`rumah_tangga.wallet_address`,
    // lihat rumah-tangga.service.ts create()) > placeholder custodial deterministik untuk baris lama
    // yang dibuat sebelum kolom wallet ada. `rumahTanggaId` disimpan berdampingan (bukan re-derive dari
    // alamat) supaya pencocokan ke DisbursementRecord di bawah tidak bergantung pada skema alamat.
    const periodeIdNum = parseInt(periodeId.replace(/-/g, '').substring(0, 8), 16) % 1_000_000;
    const leaves: (MerkleLeaf & { rumahTanggaId: string; jenisWallet: 'mandiri' | 'custodial' })[] = [];

    for (const r of rankings) {
      const existing = r.rumahTangga.disbursementRecords?.[0];
      let walletAddress = existing?.walletAddress ?? r.rumahTangga.walletAddress ?? undefined;
      let jenisWallet: 'mandiri' | 'custodial' =
        (existing?.jenisWallet as 'mandiri' | 'custodial' | undefined) ??
        (r.rumahTangga.jenisWallet as 'mandiri' | 'custodial' | null) ??
        'custodial';
      if (!walletAddress) {
        walletAddress = deriveCustodialWallet(r.rumahTangga.id);
        jenisWallet = 'custodial';
      }

      const nikHash = '0x' + keccak256(toUtf8Bytes(r.rumahTangga.nikKkHash)).substring(2);
      const amount = BigInt(Math.round(Number(r.amount!) * 1e0)); // amount in token units

      const leafHash = this.merkle.computeLeafHash(walletAddress, amount, periodeIdNum, nikHash);

      leaves.push({
        recipient: walletAddress,
        amount,
        periodeId: periodeIdNum,
        nikHash,
        leafHash,
        rumahTanggaId: r.rumahTanggaId,
        jenisWallet,
      });
    }

    // Check invariants
    const totalAlokasi = Number(periode.totalAlokasi);
    const anggaranEfektif = Number(periode.anggaranTotal) - Number(periode.biayaOperasional);
    const kuotaPenerima = periode.kuotaPenerima || 0;

    const invariants = this.merkle.checkInvariants(leaves, totalAlokasi, anggaranEfektif, kuotaPenerima);
    const allPassed = invariants.every((inv) => inv.lolos);

    if (!allPassed) {
      const failedInv = invariants.find((inv) => !inv.lolos);
      throw new HttpException(
        {
          code: 'INVARIAN_ALOKASI_GAGAL',
          message: failedInv?.detail || 'Invarian alokasi gagal',
          details: Object.fromEntries(invariants.map((inv) => [inv.nama, inv.lolos])),
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Build Merkle root
    const leafHashes = leaves.map((l) => l.leafHash);
    const merkleRoot = this.merkle.buildRoot(leafHashes);

    // Create/update disbursement records. `reference` (mis. REC-0231) dibuat
    // sekali saat record pertama kali ada dan tidak pernah diubah lagi —
    // ini identitas publik yang dipakai warga untuk cek status, jadi harus stabil.
    //
    // Nomor urut diturunkan dari `reference` numerik TERTINGGI yang sudah ada,
    // bukan dari count() — count() bisa turun kalau record periode lain dihapus,
    // dan menghasilkan REC-XXXX yang bertabrakan dengan yang masih ada (kolom
    // `reference` unik -> insert gagal 500). Max + increment selalu monoton naik.
    // Buang record penerima yang TIDAK lagi terpilih pada alokasi terbaru.
    // Tanpa ini, menjalankan ulang alokasi dengan kuota lebih kecil menyisakan
    // record lama, sehingga jumlah penerima di portal publik tidak sama dengan
    // `kuota_penerima` dan Σ amount tidak lagi cocok dengan `total_alokasi`.
    // Record yang sudah `claimed` TIDAK pernah dihapus — itu jejak transaksi
    // sungguhan; kalau sampai ada yang keluar dari daftar, prosesnya dihentikan.
    const idsTerpilih = leaves.map((l) => l.rumahTanggaId);
    const usangTerklaim = await this.prisma.disbursementRecord.findMany({
      where: { periodeId, rumahTanggaId: { notIn: idsTerpilih }, status: { not: 'pending' } },
      select: { reference: true },
    });
    if (usangTerklaim.length > 0) {
      throw new HttpException(
        {
          code: 'PENERIMA_TERKLAIM_HILANG_DARI_DAFTAR',
          message: `${usangTerklaim.length} penerima yang dananya sudah cair tidak lagi ada di daftar alokasi terbaru (${usangTerklaim
            .map((r) => r.reference)
            .join(', ')}). Kembalikan parameter alokasi atau selesaikan lewat koreksi manual — jangan bangun ulang Merkle root di atas data yang tidak konsisten.`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.prisma.disbursementRecord.deleteMany({
      where: { periodeId, rumahTanggaId: { notIn: idsTerpilih }, status: 'pending' },
    });

    const semuaRef = await this.prisma.disbursementRecord.findMany({ select: { reference: true } });
    let refCounter = semuaRef.reduce((max, r) => {
      const n = parseInt(r.reference.replace(/^REC-/, ''), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);

    for (const leaf of leaves) {
      const rt = rankings.find((r) => r.rumahTanggaId === leaf.rumahTanggaId);
      if (!rt) continue;

      const existing = rt.rumahTangga.disbursementRecords?.[0];
      refCounter += existing ? 0 : 1;

      await this.prisma.disbursementRecord.upsert({
        where: {
          periodeId_rumahTanggaId: { periodeId, rumahTanggaId: rt.rumahTanggaId },
        },
        create: {
          reference: `REC-${String(refCounter).padStart(4, '0')}`,
          rumahTanggaId: rt.rumahTanggaId,
          periodeId,
          walletAddress: leaf.recipient,
          jenisWallet: leaf.jenisWallet,
          amount: Number(leaf.amount),
          merkleLeafHash: leaf.leafHash,
          status: 'pending',
        },
        update: {
          // Nominal/wallet ikut diperbarui: alokasi bisa dijalankan ulang dengan
          // skema atau nominal berbeda, dan record harus mencerminkan leaf yang
          // benar-benar masuk Merkle root. `reference` sengaja tidak ikut diubah.
          walletAddress: leaf.recipient,
          jenisWallet: leaf.jenisWallet,
          amount: Number(leaf.amount),
          merkleLeafHash: leaf.leafHash,
        },
      });
    }

    // Save merkle root to periode
    await this.prisma.periodeProgram.update({
      where: { id: periodeId },
      data: { merkleRoot },
    });

    await this.audit.log({
      action: 'build_merkle',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: { merkleRoot, totalLeaves: leaves.length },
    });

    return {
      merkle_root: merkleRoot,
      total_leaves: leaves.length,
      total_amount: totalAlokasi,
      leaf_encoding: 'keccak256(bytes.concat(keccak256(abi.encode(address,uint256,uint256,bytes32))))',
      invarian: Object.fromEntries(invariants.map((inv) => [inv.nama, inv.lolos])),
    };
  }

  /**
   * Get claim proof for a specific wallet address.
   */
  async getClaimProof(periodeId: string, wallet: string) {
    const disbursement = await this.prisma.disbursementRecord.findFirst({
      where: {
        periodeId,
        walletAddress: { equals: wallet, mode: 'insensitive' },
      },
      include: {
        rumahTangga: { select: { nikKkHash: true } },
      },
    });

    if (!disbursement) {
      throw new HttpException(
        { code: 'TIDAK_DITEMUKAN', message: 'Data penerima tidak ditemukan untuk wallet ini' },
        HttpStatus.NOT_FOUND,
      );
    }

    const periode = await this.prisma.periodeProgram.findUnique({
      where: { id: periodeId },
    });

    // Bangun ulang urutan leaf yang PERSIS sama seperti saat buildMerkle()
    // menghitung root (rank ascending pada ranking final terpilih), supaya
    // proof-nya benar-benar cocok dengan root yang sudah dikunci.
    const rankings = await this.prisma.rankingResult.findMany({
      where: { periodeId, status: 'final', terpilih: true },
      include: {
        rumahTangga: {
          include: {
            disbursementRecords: { where: { periodeId }, select: { merkleLeafHash: true } },
          },
        },
      },
      orderBy: { rank: 'asc' },
    });

    const leafHashes = rankings.map((r) => r.rumahTangga.disbursementRecords?.[0]?.merkleLeafHash ?? '');
    const targetIndex = rankings.findIndex((r) => r.rumahTanggaId === disbursement.rumahTanggaId);

    if (targetIndex === -1 || leafHashes.some((h) => !h)) {
      throw new HttpException(
        {
          code: 'MERKLE_BELUM_DIBANGUN',
          message: 'Merkle tree belum dibangun atau tidak konsisten untuk periode ini',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const proof = this.merkle.generateProof(leafHashes, targetIndex);
    const nikHash = '0x' + keccak256(toUtf8Bytes(disbursement.rumahTangga.nikKkHash)).substring(2);

    return {
      periode_id: periodeId,
      recipient: disbursement.walletAddress,
      amount: Number(disbursement.amount),
      nik_hash: nikHash,
      proof,
      sudah_diklaim: disbursement.status === 'claimed',
      contract_address:
        alamatKontrakValid(periode?.contractAddress) ??
        alamatKontrakValid(process.env.DISBURSEMENT_CONTRACT_ADDRESS) ??
        null,
    };
  }

  /**
   * Simulate on-chain submission (placeholder for demo).
   */
  async submitOnchain(periodeId: string, actorId?: string) {
    const periode = await this.prisma.periodeProgram.findUnique({
      where: { id: periodeId },
    });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }

    if (!periode.merkleRoot) {
      throw new HttpException(
        { code: 'MERKLE_BELUM_DIBANGUN', message: 'Bangun Merkle tree terlebih dahulu' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // periodeId (UUID) -> uint256 numerik: HARUS identik dengan derivasi yang dipakai
    // buildMerkle() saat menghitung leaf, karena claim() di kontrak mem-verifikasi
    // proof terhadap periodeId numerik ini, bukan UUID string-nya.
    const periodeIdNum = parseInt(periodeId.replace(/-/g, '').substring(0, 8), 16) % 1_000_000;

    // Periode yang sudah `disbursed` tidak boleh disubmit ulang: root sudah
    // terkunci on-chain, dan menimpa tx_hash akan menghapus jejak transaksi asli.
    if (periode.status === 'disbursed' && periode.txHash) {
      throw new HttpException(
        {
          code: 'SUDAH_DISUBMIT',
          message: `Periode ini sudah pernah disubmit on-chain (tx ${periode.txHash}). Membangun ulang akan menimpa jejak transaksi yang sudah tercatat.`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const chain = this.getChainConfig();
    let txHash: string;
    let contractAddress: string | null;
    let simulated: boolean;

    if (chain) {
      // Registrasi sungguhan: mengunci merkleRoot on-chain lewat BansosRegistry.registerPeriode().
      const provider = new JsonRpcProvider(chain.rpcUrl);
      const wallet = new Wallet(chain.privateKey, provider);
      const registry = new Contract(chain.registryAddress, REGISTRY_ABI, wallet);

      const tx = await registry.registerPeriode(
        periodeIdNum,
        periode.merkleRoot,
        BigInt(Math.round(Number(periode.totalAlokasi))),
      );
      const receipt = await tx.wait();

      txHash = receipt.hash;
      contractAddress = chain.registryAddress;
      simulated = false;
    } else {
      // Belum ada kontrak sungguhan yang di-deploy (lihat sigap-contracts/ — kontrak dan
      // test-nya sudah ada, tapi ADMIN_PRIVATE_KEY/REGISTRY_CONTRACT_ADDRESS di .env
      // masih placeholder). Simulasi tetap dipertahankan sesuai
      // 07-Security-Privacy-Ethics.md §7 — dinyatakan terbuka sebagai simulasi, bukan
      // disamarkan sebagai transaksi nyata.
      txHash = '0x' + keccak256(toUtf8Bytes(`tx-${periodeId}-${Date.now()}`)).substring(2);
      // JANGAN menyimpan alamat kontrak apa pun saat simulasi. Sebelumnya di sini
      // dipakai `process.env.REGISTRY_CONTRACT_ADDRESS` (yang di .env masih berisi
      // literal "0x...") dengan cadangan sebuah alamat contoh yang di-hardcode —
      // keduanya lalu tersimpan sebagai `contract_address` dan ditampilkan ke publik
      // sebagai tautan block explorer. Tautan itu mengarah ke alamat yang tidak ada
      // hubungannya dengan program ini: persis "menyamarkan simulasi sebagai transaksi
      // nyata" yang dilarang 07-Security-Privacy-Ethics.md §7 — dan yang justru
      // diklaim tidak dilakukan oleh komentar di blok ini sebelumnya.
      // `null` membuat UI menampilkan "Kontrak belum terdaftar di explorer".
      contractAddress = null;
      simulated = true;
    }

    await this.prisma.periodeProgram.update({
      where: { id: periodeId },
      data: { txHash, contractAddress },
    });

    // Perubahan status dirutekan lewat state machine resmi, bukan ditulis langsung.
    // Sebelumnya `status: 'disbursed'` di-set di update di atas, melewati
    // `updateStatus()` sepenuhnya — sama persis dengan bug yang sudah diperbaiki di
    // `finalizeRanking()`. Akibatnya submit-onchain bisa dipanggil berulang pada
    // periode yang sudah `disbursed` dan menimpa `tx_hash` transaksi sebelumnya.
    if (periode.status !== 'disbursed') {
      await this.periodeProgramService.updateStatus(periodeId, 'disbursed', actorId);
    }

    await this.audit.log({
      actorId,
      action: 'submit_onchain',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: { txHash, contractAddress, network: 'polygon-amoy', simulated },
    });

    return {
      tx_hash: txHash,
      contract_address: contractAddress,
      network: 'polygon-amoy',
      simulated,
    };
  }

  /** Kredensial chain lengkap & valid (bukan placeholder .env.example) -> null kalau belum siap. */
  private getChainConfig(): { rpcUrl: string; privateKey: string; registryAddress: string } | null {
    const rpcUrl = process.env.RPC_URL;
    const privateKey = process.env.ADMIN_PRIVATE_KEY;
    const registryAddress = process.env.REGISTRY_CONTRACT_ADDRESS;

    if (!rpcUrl || !privateKey || !registryAddress) return null;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) return null; // masih placeholder
    if (!/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) return null;

    return { rpcUrl, privateKey, registryAddress };
  }

  /**
   * Get disbursement status for a period.
   */
  async getDisbursementStatus(periodeId: string) {
    const periode = await this.prisma.periodeProgram.findUnique({
      where: { id: periodeId },
    });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }

    const totalRecipients = await this.prisma.disbursementRecord.count({
      where: { periodeId },
    });
    const totalClaimed = await this.prisma.disbursementRecord.count({
      where: { periodeId, status: 'claimed' },
    });

    return {
      total_recipients: totalRecipients,
      total_claimed: totalClaimed,
      total_pending: totalRecipients - totalClaimed,
      // Tanpa alamat kontrak (periode masih mode simulasi), tidak ada URL explorer
      // yang bermakna — `null` supaya UI tidak memasang tautan yang pasti mati.
      explorer_url: alamatKontrakValid(periode.contractAddress)
        ? `${explorerBase()}/address/${periode.contractAddress}`
        : null,
    };
  }
}
