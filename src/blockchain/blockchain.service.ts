import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MerkleService, MerkleLeaf } from './merkle.service';
import { keccak256, toUtf8Bytes } from 'ethers';

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private merkle: MerkleService,
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
            disbursementRecords: {
              where: { periodeId },
              select: { walletAddress: true },
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

    // Build leaves
    const periodeIdNum = parseInt(periodeId.replace(/-/g, '').substring(0, 8), 16) % 1_000_000;
    const leaves: MerkleLeaf[] = [];

    for (const r of rankings) {
      // Use existing disbursement wallet or generate a mock custodial wallet
      let walletAddress = r.rumahTangga.disbursementRecords?.[0]?.walletAddress;
      if (!walletAddress) {
        // Generate a deterministic mock wallet from nikKkHash
        walletAddress = '0x' + r.rumahTangga.nikKkHash.substring(0, 40);
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
    let refCounter = await this.prisma.disbursementRecord.count();

    for (const leaf of leaves) {
      const rt = rankings.find((r) => '0x' + r.rumahTangga.nikKkHash.substring(0, 40) === leaf.recipient
        || r.rumahTangga.disbursementRecords?.[0]?.walletAddress === leaf.recipient);

      if (rt) {
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
            jenisWallet: 'custodial',
            amount: Number(leaf.amount),
            merkleLeafHash: leaf.leafHash,
            status: 'pending',
          },
          update: {
            merkleLeafHash: leaf.leafHash,
          },
        });
      }
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
      contract_address: periode?.contractAddress || process.env.DISBURSEMENT_CONTRACT_ADDRESS || '0x...',
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

    // Simulate tx hash (in production, use ethers.js to submit to contract)
    const mockTxHash = '0x' + keccak256(toUtf8Bytes(`tx-${periodeId}-${Date.now()}`)).substring(2);
    const contractAddress = process.env.REGISTRY_CONTRACT_ADDRESS || '0x7a1c9F4b2E8d3A5c6B0f1D8e4C2a9B7d3E5f0A16';

    await this.prisma.periodeProgram.update({
      where: { id: periodeId },
      data: {
        txHash: mockTxHash,
        contractAddress,
        status: 'disbursed',
      },
    });

    await this.audit.log({
      actorId,
      action: 'submit_onchain',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: { txHash: mockTxHash, contractAddress, network: 'polygon-amoy' },
    });

    return {
      tx_hash: mockTxHash,
      contract_address: contractAddress,
      network: 'polygon-amoy',
    };
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
      explorer_url: `https://amoy.polygonscan.com/address/${periode.contractAddress || '0x...'}`,
    };
  }
}
