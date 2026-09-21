import { Injectable, HttpException, HttpStatus, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MerkleService, MerkleLeaf } from './merkle.service';
import { PeriodeProgramService } from '../periode-program/periode-program.service';
import { keccak256, toUtf8Bytes, Contract, EventLog, Wallet, JsonRpcProvider, NonceManager } from 'ethers';
import { deriveCustodialWallet } from '../common/crypto.util';

const CHAIN_ID_HARDHAT = 31337;

/** Chain id aktif; default Polygon Amoy sesuai 06-Smart-Contract-Design.md §2. */
function chainIdAktif(): number {
  const n = Number(process.env.CHAIN_ID);
  return Number.isInteger(n) && n > 0 ? n : 80002;
}

/**
 * Basis URL block explorer; jaringan bisa berganti, jadi tidak di-hardcode.
 * Chain lokal Hardhat tidak punya explorer — `null` supaya tidak ada tautan
 * Polygonscan ke alamat yang hanya ada di laptop developer.
 */
export function explorerBase(): string | null {
  if (process.env.EXPLORER_BASE_URL) return process.env.EXPLORER_BASE_URL;
  return chainIdAktif() === CHAIN_ID_HARDHAT ? null : 'https://amoy.polygonscan.com';
}

/** Nama jaringan untuk respons API & audit log, diturunkan dari CHAIN_ID. */
export function namaJaringan(chainId: number = chainIdAktif()): string {
  switch (chainId) {
    case 80002:
      return 'polygon-amoy';
    case 137:
      return 'polygon';
    case CHAIN_ID_HARDHAT:
      return 'hardhat-local';
    default:
      return `chain-${chainId}`;
  }
}

/**
 * periodeId (UUID) -> uint256 numerik yang dipakai kontrak. Leaf Merkle,
 * `registerPeriode()`, dan event `FundDisbursed` semuanya memakai angka ini —
 * ketiganya HARUS memakai derivasi yang sama persis.
 */
export function periodeIdNumerik(periodeId: string): number {
  return parseInt(periodeId.replace(/-/g, '').substring(0, 8), 16) % 1_000_000;
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
const DISBURSEMENT_ABI = [
  'event FundDisbursed(uint256 indexed periodeId, address indexed recipient, address indexed submitter, uint256 amount, bytes32 nikHash)',
  'function saldoPeriode(uint256 periodeId) view returns (uint256)',
  'function depositDana(uint256 periodeId, uint256 amount) external',
];
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

/** Rentang blok per `eth_getLogs` — RPC publik Amoy menolak rentang yang terlalu lebar. */
const RENTANG_BLOK_LOG = 5_000;

@Injectable()
export class BlockchainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlockchainService.name);

  /**
   * periodeId -> blok pertama yang belum dipindai untuk event klaim, terikat pada tx
   * registrasinya: kalau periode diregistrasi ulang (chain lokal di-reset), kursor
   * lama tidak boleh dipakai karena blok registrasi yang baru bisa lebih rendah.
   * Hilang saat restart; dipindai ulang dari blok registrasi.
   */
  private readonly kursorKlaim = new Map<string, { txHash: string; blok: number }>();
  private timerSinkron?: NodeJS.Timeout;
  private sedangSinkron = false;
  /** Pesan gagal terakhir per periode — supaya poller tidak mengulang peringatan yang sama tiap tick. */
  private readonly galatSinkronTerakhir = new Map<string, string>();

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private merkle: MerkleService,
    private periodeProgramService: PeriodeProgramService,
  ) {}

  /**
   * Poller sinkronisasi klaim. Klaim dikirim langsung ke kontrak oleh warga/relayer,
   * bukan lewat API, jadi satu-satunya cara backend tahu ada klaim adalah membaca
   * event `FundDisbursed`. `CLAIM_SYNC_INTERVAL_MS=0` mematikannya.
   */
  onModuleInit() {
    const interval = Number(process.env.CLAIM_SYNC_INTERVAL_MS ?? 30_000);
    if (!this.getClaimChainConfig() || !(interval > 0)) return;
    this.timerSinkron = setInterval(() => void this.sinkronSemuaPeriode(), interval);
    this.timerSinkron.unref();
    this.logger.log(`Sinkronisasi klaim on-chain aktif, tiap ${interval} ms`);
  }

  onModuleDestroy() {
    if (this.timerSinkron) clearInterval(this.timerSinkron);
  }

  private async sinkronSemuaPeriode() {
    if (this.sedangSinkron) return;
    this.sedangSinkron = true;
    try {
      const periodes = await this.prisma.periodeProgram.findMany({
        where: { status: 'disbursed', txHash: { not: null }, contractAddress: { not: null } },
        select: { id: true },
      });
      for (const { id } of periodes) {
        try {
          await this.syncKlaim(id);
          this.galatSinkronTerakhir.delete(id);
        } catch (err) {
          const pesan = err instanceof HttpException ? JSON.stringify(err.getResponse()) : String(err);
          if (this.galatSinkronTerakhir.get(id) !== pesan) {
            this.logger.warn(`Sinkronisasi klaim periode ${id} gagal: ${pesan}`);
            this.galatSinkronTerakhir.set(id, pesan);
          }
        }
      }
    } finally {
      this.sedangSinkron = false;
    }
  }

  /**
   * Tarik event `FundDisbursed` periode ini dari kontrak disbursement dan tandai
   * `disbursement_record` yang cocok sebagai `claimed`. Idempoten: record yang sudah
   * `claimed` dilewati, jadi aman dipanggil berulang (poller + tombol manual).
   */
  async syncKlaim(periodeId: string) {
    const chain = this.getClaimChainConfig();
    if (!chain) {
      throw new HttpException(
        {
          code: 'KONTRAK_BELUM_DIKONFIGURASI',
          message: 'RPC_URL / DISBURSEMENT_CONTRACT_ADDRESS belum diisi — tidak ada kontrak untuk dibaca',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const periode = await this.prisma.periodeProgram.findUnique({ where: { id: periodeId } });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }
    if (!alamatKontrakValid(periode.contractAddress) || !periode.txHash) {
      throw new HttpException(
        { code: 'BELUM_ONCHAIN', message: 'Periode ini belum diregistrasi on-chain (masih simulasi atau belum disubmit)' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const provider = new JsonRpcProvider(chain.rpcUrl, undefined, { staticNetwork: true });

    // Klaim tidak mungkin terjadi sebelum root diregistrasi, jadi pemindaian
    // dimulai dari blok transaksi `registerPeriode()` — tidak perlu env blok deploy.
    const kursor = this.kursorKlaim.get(periodeId);
    let dariBlok = kursor?.txHash === periode.txHash ? kursor.blok : undefined;
    if (dariBlok === undefined) {
      const receipt = await provider.getTransactionReceipt(periode.txHash);
      if (!receipt) {
        throw new HttpException(
          {
            code: 'TX_REGISTRASI_TIDAK_DITEMUKAN',
            message: `Transaksi registrasi ${periode.txHash} tidak ada di chain ${namaJaringan()} — chain lokal sudah di-reset, atau RPC menunjuk jaringan lain`,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      dariBlok = receipt.blockNumber;
    }

    const blokTerbaru = await provider.getBlockNumber();
    const kontrak = new Contract(chain.disbursementAddress, DISBURSEMENT_ABI, provider);
    const filter = kontrak.filters.FundDisbursed(periodeIdNumerik(periodeId));
    let klaimBaru = 0;

    for (let awal = dariBlok; awal <= blokTerbaru; awal += RENTANG_BLOK_LOG) {
      const akhir = Math.min(awal + RENTANG_BLOK_LOG - 1, blokTerbaru);
      const logs = await kontrak.queryFilter(filter, awal, akhir);

      for (const log of logs) {
        if (!(log instanceof EventLog)) continue;
        const recipient: string = log.args.recipient;
        const amount: bigint = log.args.amount;

        const record = await this.prisma.disbursementRecord.findFirst({
          where: { periodeId, walletAddress: { equals: recipient, mode: 'insensitive' } },
        });
        if (!record) {
          // Kontrak hanya menerima leaf yang ada di root, jadi ini berarti DB sudah
          // berubah setelah root dikunci. Jangan mengarang record — cukup laporkan.
          this.logger.warn(`FundDisbursed ${log.transactionHash}: penerima ${recipient} tidak ada di disbursement_record periode ${periodeId}`);
          continue;
        }
        if (record.status === 'claimed') continue;
        if (BigInt(Math.round(Number(record.amount))) !== amount) {
          this.logger.warn(
            `FundDisbursed ${log.transactionHash}: nominal on-chain ${amount} ≠ nominal DB ${record.amount} (${record.reference}) — nilai on-chain yang berlaku`,
          );
        }

        const blok = await log.getBlock();
        await this.prisma.disbursementRecord.update({
          where: { id: record.id },
          data: { status: 'claimed', txHash: log.transactionHash, claimedAt: new Date(blok.timestamp * 1000) },
        });
        await this.audit.log({
          action: 'klaim_tersinkron',
          entityType: 'disbursement_record',
          entityId: record.id,
          beforeState: { status: record.status },
          afterState: { status: 'claimed', txHash: log.transactionHash, submitter: log.args.submitter, amount: amount.toString() },
        });
        klaimBaru += 1;
      }

      this.kursorKlaim.set(periodeId, { txHash: periode.txHash, blok: akhir + 1 });
    }

    const totalClaimed = await this.prisma.disbursementRecord.count({ where: { periodeId, status: 'claimed' } });
    return {
      periode_id: periodeId,
      network: namaJaringan(),
      disbursement_contract: chain.disbursementAddress,
      dipindai_sampai_blok: blokTerbaru,
      klaim_baru: klaimBaru,
      total_claimed: totalClaimed,
    };
  }

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
    const periodeIdNum = periodeIdNumerik(periodeId);
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
      // Kontrak yang punya `claim()` adalah BansosDisbursement. `periode.contractAddress`
      // berisi alamat BansosRegistry (hasil `submit-onchain`) — dulu dipakai di sini lebih
      // dulu, sehingga wallet yang mengikuti respons ini memanggil `claim()` ke Registry
      // dan selalu revert. Registry tetap dikembalikan terpisah untuk verifikasi root.
      contract_address: alamatKontrakValid(process.env.DISBURSEMENT_CONTRACT_ADDRESS),
      registry_address: alamatKontrakValid(periode?.contractAddress),
      periode_id_onchain: periodeIdNumerik(periodeId),
      chain_id: chainIdAktif(),
      network: namaJaringan(),
      jenis_wallet: disbursement.jenisWallet,
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
    const periodeIdNum = periodeIdNumerik(periodeId);

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
      afterState: { txHash, contractAddress, network: namaJaringan(), simulated },
    });

    return {
      tx_hash: txHash,
      contract_address: contractAddress,
      network: namaJaringan(),
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
   * Danai kontrak disbursement untuk periode ini dari wallet admin: approve +
   * `depositDana()` sebesar kekurangannya. Kebutuhan = Σ nominal penerima yang belum
   * klaim − saldo periode on-chain; klaim disinkronkan dulu supaya klaim yang belum
   * tercatat tidak membuat kontrak didanai dua kali.
   */
  async danaiKontrak(periodeId: string, actorId?: string) {
    const chain = this.getChainConfig();
    const claimChain = this.getClaimChainConfig();
    const tokenAddress = alamatKontrakValid(process.env.DANA_TOKEN_ADDRESS);
    if (!chain || !claimChain || !tokenAddress) {
      throw new HttpException(
        {
          code: 'KONTRAK_BELUM_DIKONFIGURASI',
          message: 'Butuh RPC_URL, ADMIN_PRIVATE_KEY, DISBURSEMENT_CONTRACT_ADDRESS, dan DANA_TOKEN_ADDRESS',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Sekaligus memvalidasi periode sudah diregistrasi on-chain (melempar kalau belum).
    await this.syncKlaim(periodeId);

    const provider = new JsonRpcProvider(chain.rpcUrl, undefined, { staticNetwork: true });
    // approve lalu depositDana dikirim berurutan dari wallet yang sama. Tanpa
    // NonceManager, ethers membaca ulang nonce dari cache request provider yang
    // belum kedaluwarsa dan transaksi kedua ditolak "nonce too low".
    const wallet = new NonceManager(new Wallet(chain.privateKey, provider));
    const alamatAdmin = await wallet.getAddress();
    const kontrak = new Contract(claimChain.disbursementAddress, DISBURSEMENT_ABI, wallet);
    const token = new Contract(tokenAddress, ERC20_ABI, wallet);
    const idOnchain = periodeIdNumerik(periodeId);

    const { saldo, kebutuhan } = await this.hitungDanaOnchain(periodeId, kontrak);
    const kekurangan = kebutuhan - saldo;
    if (kekurangan <= 0n) {
      return { periode_id: periodeId, sudah_cukup: true, deposit: 0, saldo_kontrak: Number(saldo), kebutuhan: Number(kebutuhan), tx_hash: null };
    }

    const saldoAdmin: bigint = await token.balanceOf(alamatAdmin);
    if (saldoAdmin < kekurangan) {
      throw new HttpException(
        {
          code: 'SALDO_TOKEN_KURANG',
          message: `Wallet admin ${alamatAdmin} hanya memegang ${saldoAdmin} token, butuh ${kekurangan}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const allowance: bigint = await token.allowance(alamatAdmin, claimChain.disbursementAddress);
    if (allowance < kekurangan) {
      await (await token.approve(claimChain.disbursementAddress, kekurangan)).wait();
    }
    const receipt = await (await kontrak.depositDana(idOnchain, kekurangan)).wait();

    await this.audit.log({
      actorId,
      action: 'danai_kontrak',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: { txHash: receipt.hash, amount: kekurangan.toString(), network: namaJaringan() },
    });

    return {
      periode_id: periodeId,
      sudah_cukup: true,
      deposit: Number(kekurangan),
      saldo_kontrak: Number(saldo + kekurangan),
      kebutuhan: Number(kebutuhan),
      tx_hash: receipt.hash,
    };
  }

  /** Saldo periode di kontrak vs Σ nominal penerima yang belum klaim (unit token). */
  private async hitungDanaOnchain(periodeId: string, kontrak: Contract) {
    const saldo: bigint = await kontrak.saldoPeriode(periodeIdNumerik(periodeId));
    const pending = await this.prisma.disbursementRecord.findMany({
      where: { periodeId, status: 'pending' },
      select: { amount: true },
    });
    const kebutuhan = pending.reduce((s, r) => s + BigInt(Math.round(Number(r.amount))), 0n);
    return { saldo, kebutuhan };
  }

  /** Cukup untuk MEMBACA event klaim — tidak butuh private key. */
  private getClaimChainConfig(): { rpcUrl: string; disbursementAddress: string } | null {
    const rpcUrl = process.env.RPC_URL;
    const disbursementAddress = alamatKontrakValid(process.env.DISBURSEMENT_CONTRACT_ADDRESS);
    if (!rpcUrl || !/^https?:\/\/.+/.test(rpcUrl) || !disbursementAddress) return null;
    return { rpcUrl, disbursementAddress };
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

    // Saldo on-chain hanya bermakna untuk periode yang benar-benar diregistrasi;
    // RPC mati tidak boleh membuat endpoint status ikut gagal.
    let danaOnchain: { saldo_kontrak: number; kebutuhan: number; cukup: boolean } | null = null;
    const claimChain = this.getClaimChainConfig();
    if (claimChain && alamatKontrakValid(periode.contractAddress)) {
      try {
        const provider = new JsonRpcProvider(claimChain.rpcUrl, undefined, { staticNetwork: true });
        const kontrak = new Contract(claimChain.disbursementAddress, DISBURSEMENT_ABI, provider);
        const { saldo, kebutuhan } = await this.hitungDanaOnchain(periodeId, kontrak);
        danaOnchain = { saldo_kontrak: Number(saldo), kebutuhan: Number(kebutuhan), cukup: saldo >= kebutuhan };
      } catch (err) {
        this.logger.warn(`Gagal membaca saldo kontrak periode ${periodeId}: ${err}`);
      }
    }

    const explorer = explorerBase();
    return {
      dana_onchain: danaOnchain,
      total_recipients: totalRecipients,
      total_claimed: totalClaimed,
      total_pending: totalRecipients - totalClaimed,
      // Tanpa alamat kontrak (periode masih mode simulasi) atau tanpa explorer
      // (chain lokal), tidak ada URL yang bermakna — `null` supaya UI tidak
      // memasang tautan yang pasti mati.
      explorer_url:
        explorer && alamatKontrakValid(periode.contractAddress)
          ? `${explorer}/address/${periode.contractAddress}`
          : null,
    };
  }
}
