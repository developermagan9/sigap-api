import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreatePeriodeDto } from './dto/create-periode.dto';
import { UpdatePeriodeDto } from './dto/update-periode.dto';
import { ProgramStatus, SkemaAlokasi } from '@prisma/client';

@Injectable()
export class PeriodeProgramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Create new periode program.
   * Validates that criteria weights sum to 1.0 (tolerance 1e-9).
   * Default status is 'draft'.
   */
  async create(dto: CreatePeriodeDto, actorId?: string) {
    // 1. Validate bobot_kriteria sums to 1.0
    if ((dto as any).bobot_kriteria) {
      const sumBobot = Number( Object.values((dto as any).bobot_kriteria).reduce(
        (acc: number, val: any) => acc + Number(val), 0
      ));
      if (Math.abs(sumBobot - 1.0) > 1e-9) {
        throw new HttpException(
          {
            error: {
              code: 'BOBOT_TIDAK_VALID',
              message: 'Total bobot kriteria harus sama dengan 1.0',
              details: { sum: sumBobot, expected: 1.0 },
            },
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // 2. Create PeriodeProgram in database
    const periode = await (this.prisma as any).periodeProgram.create({
      data: {
        namaProgram: dto.nama_program,
        anggaranTotal: dto.anggaran_total,
        biayaOperasional: dto.biaya_operasional ?? 0,
        kCluster: (dto as any).k_cluster ?? 4,
        clusterPrioritas: [0, 1],
        bobotKriteria: (dto as any).bobot_kriteria,
        skemaAlokasi: ((dto as any).skema_alokasi as SkemaAlokasi) || 'flat',
        nominalDasar: (dto as any).nominal_dasar ?? 500000,
        status: 'draft',
      },
    });

    // 3. Log to audit trail
    if (actorId) {
      await this.audit.log({
        action: 'CREATE_PERIODE_PROGRAM',
        actorId,
        entityId: periode.id,
        entityType: 'periode_program',
        afterState: periode,
      });
    }

    return periode;
  }

  /**
   * Return all periodes ordered by createdAt desc.
   */
  async findAll() {
    return (this.prisma as any).periodeProgram.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            clusterResults: true,
            rankingResults: true,
            rumahTangga: true,
            disbursementRecords: true,
          },
        },
      },
    });
  }

  /**
   * Find single periode by id with includes for clusterResults and rankingResults count.
   * Throws 404 if not found.
   */
  async findOne(id: string) {
    const periode = await (this.prisma as any).periodeProgram.findUnique({
      where: { id },
      include: {
        clusterResults: {
          orderBy: { clusterIndex: 'asc' },
        },
        _count: {
          select: {
            rankingResults: true,
            rumahTangga: true,
            disbursementRecords: true,
          },
        },
      },
    });

    if (!periode) {
      throw new HttpException(
        {
          error: {
            code: 'TIDAK_DITEMUKAN',
            message: `Periode program dengan ID '${id}' tidak ditemukan`,
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }

    return periode;
  }

  /**
   * Update periode if status is 'draft'.
   * Throws 422 PERIODE_TERKUNCI if locked.
   * Re-validates bobot if changed.
   */
  async update(id: string, dto: UpdatePeriodeDto, actorId?: string) {
    const existing = await (this.prisma as any).periodeProgram.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new HttpException(
        {
          error: {
            code: 'TIDAK_DITEMUKAN',
            message: `Periode program dengan ID '${id}' tidak ditemukan`,
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }

    // Only allow update when status is 'draft'
    if (existing.status !== 'draft') {
      throw new HttpException(
        {
          error: {
            code: 'PERIODE_TERKUNCI',
            message: `Periode program tidak dapat diubah karena berstatus '${existing.status}' (hanya periode dengan status 'draft' yang dapat diubah)`,
            details: { currentStatus: existing.status },
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Re-validate bobot if changed
    if ((dto as any).bobot_kriteria !== undefined) {
      const sumBobot = Number( Object.values((dto as any).bobot_kriteria).reduce(
        (acc: number, val: any) => acc + Number(val), 0
      ));
      if (Math.abs(sumBobot - 1.0) > 1e-9) {
        throw new HttpException(
          {
            error: {
              code: 'BOBOT_TIDAK_VALID',
              message: 'Total bobot kriteria harus sama dengan 1.0',
              details: { sum: sumBobot, expected: 1.0 },
            },
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const updateData: any = {};
    if (dto.nama_program !== undefined) updateData.namaProgram = dto.nama_program;
    if (dto.anggaran_total !== undefined) updateData.anggaranTotal = dto.anggaran_total;
    if (dto.biaya_operasional !== undefined) updateData.biayaOperasional = dto.biaya_operasional;
    if ((dto as any).k_cluster !== undefined) updateData.kCluster = (dto as any).k_cluster;
    if ((dto as any).bobot_kriteria !== undefined) updateData.bobotKriteria = (dto as any).bobot_kriteria;
    if ((dto as any).skema_alokasi !== undefined) updateData.skemaAlokasi = (dto as any).skema_alokasi as SkemaAlokasi;
    if ((dto as any).nominal_dasar !== undefined) updateData.nominalDasar = (dto as any).nominal_dasar;

    const updated = await (this.prisma as any).periodeProgram.update({
      where: { id },
      data: updateData,
    });

    if (actorId) {
      await this.audit.log({
        action: 'UPDATE_PERIODE_PROGRAM',
        actorId,
        entityId: id,
        entityType: 'periode_program',
        beforeState: existing,
        afterState: updated,
      });
    }

    return updated;
  }

  /**
   * Validate status transition per the state machine:
   * draft -> clustering -> ranking -> alokasi -> reviewed -> approved -> disbursed
   * Throws 422 if invalid transition.
   */
  async updateStatus(
    id: string,
    newStatus: ProgramStatus | string,
    actorId?: string,
  ) {
    const existing = await (this.prisma as any).periodeProgram.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new HttpException(
        {
          error: {
            code: 'TIDAK_DITEMUKAN',
            message: `Periode program dengan ID '${id}' tidak ditemukan`,
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }

    const validTransitions: Record<string, string[]> = {
      draft: ['clustering'],
      clustering: ['ranking'],
      ranking: ['alokasi'],
      alokasi: ['reviewed'],
      reviewed: ['approved'],
      approved: ['disbursed'],
      disbursed: [],
    };

    const allowed = validTransitions[existing.status] || [];
    if (!allowed.includes(newStatus)) {
      throw new HttpException(
        {
          error: {
            code: 'TRANSISI_TIDAK_VALID',
            message: `Transisi status dari '${existing.status}' ke '${newStatus}' tidak valid. Alur status: draft -> clustering -> ranking -> alokasi -> reviewed -> approved -> disbursed`,
            details: {
              currentStatus: existing.status,
              targetStatus: newStatus,
              allowedTransitions: allowed,
            },
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const updated = await (this.prisma as any).periodeProgram.update({
      where: { id },
      data: { status: newStatus as ProgramStatus },
    });

    if (actorId) {
      await this.audit.log({
        action: 'UPDATE_PERIODE_STATUS',
        actorId,
        entityId: id,
        entityType: 'periode_program',
        beforeState: { status: existing.status },
        afterState: { status: updated.status },
      });
    }

    return updated;
  }

  /**
   * Return aggregated stats:
   * total rumah tangga, total verified, total clusters, total ranked, total selected (terpilih), total claimed.
   */
  async getSummary(id: string) {
    const periode = await (this.prisma as any).periodeProgram.findUnique({
      where: { id },
    });

    if (!periode) {
      throw new HttpException(
        {
          error: {
            code: 'TIDAK_DITEMUKAN',
            message: `Periode program dengan ID '${id}' tidak ditemukan`,
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }

    const [
      totalRumahTangga,
      totalVerified,
      totalClusters,
      totalRanked,
      totalSelected,
      totalClaimed,
    ] = await Promise.all([
      (this.prisma as any).rumahTangga.count({
        where: { periodeId: id },
      }),
      (this.prisma as any).rumahTangga.count({
        where: { periodeId: id, statusVerifikasi: 'verified' },
      }),
      (this.prisma as any).clusterResult.count({
        where: { periodeId: id },
      }),
      (this.prisma as any).rankingResult.count({
        where: { periodeId: id },
      }),
      (this.prisma as any).rankingResult.count({
        where: { periodeId: id, terpilih: true },
      }),
      (this.prisma as any).disbursementRecord.count({
        where: { periodeId: id, status: 'claimed' },
      }),
    ]);

    return {
      periode_id: periode.id,
      nama_program: periode.namaProgram,
      status: periode.status,
      anggaran_total: Number(periode.anggaranTotal),
      biaya_operasional: Number(periode.biayaOperasional),
      nominal_dasar: Number(periode.nominalDasar),
      k_cluster: periode.kCluster,
      kuota_penerima: periode.kuotaPenerima,
      total_alokasi: periode.totalAlokasi ? Number(periode.totalAlokasi) : null,
      sisa_anggaran: periode.sisaAnggaran ? Number(periode.sisaAnggaran) : null,
      total_rumah_tangga: totalRumahTangga,
      total_verified: totalVerified,
      total_clusters: totalClusters,
      total_ranked: totalRanked,
      total_terpilih: totalSelected,
      total_claimed: totalClaimed,
    };
  }
}
