import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateSanggahanDto } from './dto/create-sanggahan.dto';
import { ReviewSanggahanDto } from './dto/review-sanggahan.dto';

// snake_case (DTO/API) -> camelCase (kolom Prisma RumahTangga)
const FIELD_MAP: Record<string, string> = {
  pendapatan_per_kapita: 'pendapatanPerKapita',
  skor_kondisi_rumah: 'skorKondisiRumah',
  skor_akses_pendidikan: 'skorAksesPendidikan',
  riwayat_bansos_sebelumnya: 'riwayatBansosSebelumnya',
  wilayah_id: 'wilayahId',
};

@Injectable()
export class SanggahanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(rumahTanggaId: string, dto: CreateSanggahanDto, actorId: string) {
    const rt = await this.prisma.rumahTangga.findUnique({ where: { id: rumahTanggaId } });
    if (!rt) {
      throw new HttpException(
        { error: { code: 'TIDAK_DITEMUKAN', message: 'Rumah tangga tidak ditemukan' } },
        HttpStatus.NOT_FOUND,
      );
    }

    if (Object.keys(dto.data_baru).length === 0) {
      throw new HttpException(
        { error: { code: 'DATA_BARU_KOSONG', message: 'Sanggahan harus mengusulkan minimal satu perubahan field' } },
        HttpStatus.BAD_REQUEST,
      );
    }

    const request = await this.prisma.sanggahanRequest.create({
      data: {
        rumahTanggaId,
        diajukanOlehId: actorId,
        alasan: dto.alasan,
        dataBaru: dto.data_baru as any,
        status: 'pending',
      },
    });

    await this.audit.log({
      action: 'AJUKAN_SANGGAHAN',
      actorId,
      entityType: 'sanggahan_request',
      entityId: request.id,
      afterState: request,
    });

    return request;
  }

  async findAll(status?: string) {
    return this.prisma.sanggahanRequest.findMany({
      where: status ? { status: status as any } : undefined,
      include: {
        rumahTangga: { select: { id: true, wilayahId: true, statusVerifikasi: true, periodeId: true } },
        diajukanOleh: { select: { id: true, nama: true, username: true, role: true } },
        ditinjauOleh: { select: { id: true, nama: true, username: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async review(id: string, dto: ReviewSanggahanDto, actorId: string) {
    const request = await this.prisma.sanggahanRequest.findUnique({
      where: { id },
      include: { rumahTangga: { include: { periode: true } } },
    });
    if (!request) {
      throw new HttpException(
        { error: { code: 'TIDAK_DITEMUKAN', message: 'Sanggahan tidak ditemukan' } },
        HttpStatus.NOT_FOUND,
      );
    }
    if (request.status !== 'pending') {
      throw new HttpException(
        { error: { code: 'SUDAH_DITINJAU', message: `Sanggahan ini sudah ${request.status}` } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Data yang sudah masuk tahap alokasi final tidak boleh diam-diam berubah lewat
    // jalur ini — konsisten dengan `updateStatus()` mengunci periode setelah `approved`.
    // Perbaikan tetap bisa diajukan & dicatat, tapi harus lewat proses resmi (periode baru
    // atau pembukaan kembali status secara eksplisit), bukan patch senyap ke data historis.
    const periodeStatus = request.rumahTangga.periode?.status;
    if (dto.status === 'diterima' && periodeStatus && ['approved', 'disbursed'].includes(periodeStatus)) {
      throw new HttpException(
        {
          error: {
            code: 'PERIODE_TERKUNCI',
            message: `Periode rumah tangga ini sudah berstatus '${periodeStatus}' — sanggahan tidak bisa diterapkan otomatis pada data yang sudah final. Tolak sanggahan ini dan tangani lewat proses manual bila memang perlu dikoreksi.`,
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const beforeState = request.rumahTangga;

    const updated = await this.prisma.$transaction(async (tx) => {
      const reviewed = await tx.sanggahanRequest.update({
        where: { id },
        data: {
          status: dto.status,
          catatanReview: dto.catatan,
          ditinjauOlehId: actorId,
          reviewedAt: new Date(),
        },
      });

      if (dto.status === 'diterima') {
        const dataBaru = request.dataBaru as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const [snakeKey, value] of Object.entries(dataBaru)) {
          const camelKey = FIELD_MAP[snakeKey];
          if (camelKey) patch[camelKey] = value;
        }
        await tx.rumahTangga.update({ where: { id: request.rumahTanggaId }, data: patch });
      }

      return reviewed;
    });

    await this.audit.log({
      action: dto.status === 'diterima' ? 'TERIMA_SANGGAHAN' : 'TOLAK_SANGGAHAN',
      actorId,
      entityType: 'sanggahan_request',
      entityId: id,
      beforeState,
      afterState: dto.status === 'diterima' ? request.dataBaru : { catatan: dto.catatan },
    });

    return updated;
  }
}
