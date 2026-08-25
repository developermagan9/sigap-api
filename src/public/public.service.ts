import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublicService {
  constructor(private prisma: PrismaService) {}

  /**
   * Public disbursement summary — no auth required.
   * Returns aggregated metrics, per-region breakdown, and recent transactions.
   */
  async getDisbursementSummary() {
    // Find latest approved/disbursed periode
    const periode = await this.prisma.periodeProgram.findFirst({
      where: { status: { in: ['approved', 'disbursed'] } },
      orderBy: { createdAt: 'desc' },
    });

    if (!periode) {
      return {
        program: null,
        total_anggaran: 0,
        total_tersalur: 0,
        jumlah_penerima: 0,
        per_wilayah: [],
        transaksi_terbaru: [],
      };
    }

    // Aggregate disbursement stats
    const disbursements = await this.prisma.disbursementRecord.findMany({
      where: { periodeId: periode.id },
      include: {
        rumahTangga: {
          select: {
            wilayahId: true,
            wilayah: { select: { desa: true } },
          },
        },
      },
    });

    // Total claimed amount
    const claimedDisbursements = disbursements.filter((d) => d.status === 'claimed');
    const totalTersalur = claimedDisbursements.reduce((sum, d) => sum + Number(d.amount), 0);

    // Per-wilayah breakdown
    const wilayahMap = new Map<string, { desa: string; jumlah_penerima: number; total_dana: number; total_cair: number }>();
    for (const d of disbursements) {
      const desa = d.rumahTangga.wilayah.desa;
      const existing = wilayahMap.get(desa) || { desa, jumlah_penerima: 0, total_dana: 0, total_cair: 0 };
      existing.jumlah_penerima++;
      existing.total_dana += Number(d.amount);
      if (d.status === 'claimed') existing.total_cair += Number(d.amount);
      wilayahMap.set(desa, existing);
    }

    // Recent transactions (last 10 claimed)
    const recentClaimed = await this.prisma.disbursementRecord.findMany({
      where: { periodeId: periode.id, status: 'claimed' },
      orderBy: { claimedAt: 'desc' },
      take: 10,
    });

    const transaksiTerbaru = recentClaimed.map((d) => ({
      tx_hash: d.txHash || '0x...',
      amount: Number(d.amount),
      timestamp: d.claimedAt?.toISOString() || d.updatedAt.toISOString(),
      recipient_ref: `${d.reference} (anonim)`,
    }));

    return {
      program: `${periode.namaProgram}`,
      total_anggaran: Number(periode.anggaranTotal),
      total_tersalur: totalTersalur,
      jumlah_penerima: disbursements.length,
      per_wilayah: Array.from(wilayahMap.values()),
      transaksi_terbaru: transaksiTerbaru,
    };
  }

  /**
   * Check claim status by wallet address or anonymized reference.
   */
  async checkClaimStatus(query: string) {
    if (!query || query.trim().length === 0) {
      throw new HttpException(
        { code: 'PARAMETER_TIDAK_VALID', message: 'Parameter q harus diisi' },
        HttpStatus.BAD_REQUEST,
      );
    }

    let disbursement;

    if (query.startsWith('0x')) {
      // Search by wallet address
      disbursement = await this.prisma.disbursementRecord.findFirst({
        where: {
          walletAddress: { equals: query, mode: 'insensitive' },
        },
        include: {
          periode: { select: { namaProgram: true, status: true } },
        },
      });
    } else {
      // Search by reference code (REC-XXXX), disimpan sekali di disbursement_record.reference
      disbursement = await this.prisma.disbursementRecord.findFirst({
        where: {
          reference: { equals: query.trim(), mode: 'insensitive' },
        },
        include: {
          periode: { select: { namaProgram: true, status: true } },
        },
      });
    }

    if (!disbursement) {
      throw new HttpException(
        { code: 'TIDAK_DITEMUKAN', message: 'Data penerima tidak ditemukan' },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      reference: disbursement.reference,
      status: disbursement.status,
      amount: Number(disbursement.amount),
      wallet: disbursement.walletAddress,
      tx_hash: disbursement.txHash,
      claimed_at: disbursement.claimedAt?.toISOString() || null,
      program: disbursement.periode.namaProgram,
      leaf_hash: disbursement.merkleLeafHash,
    };
  }
}
