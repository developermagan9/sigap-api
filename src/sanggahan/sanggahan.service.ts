import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashWithPepper, encrypt } from '../common/crypto.util';
import {
  PenggunaBerwilayah,
  filterWilayah,
  bolehAksesWilayah,
} from '../common/wilayah-scope';
import { hitungTurunanAnggota } from '../rumah-tangga/rumah-tangga.service';
import { AnggotaDto } from '../rumah-tangga/dto/create-rumah-tangga.dto';
import { CreateSanggahanDto } from './dto/create-sanggahan.dto';
import { ReviewSanggahanDto } from './dto/review-sanggahan.dto';

// snake_case (DTO/API) -> camelCase (kolom Prisma RumahTangga).
// `anggota` sengaja TIDAK di sini: ia bukan kolom, melainkan tabel terpisah yang
// diganti isinya + memicu perhitungan ulang kolom turunan (lihat terapkanAnggota).
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

  async findAll(status?: string, user?: PenggunaBerwilayah) {
    // Scoping wilayah, sejalan dengan RumahTanggaService.findAll(): verifikator
    // hanya melihat sanggahan dari wilayah kerjanya sendiri. Tanpa ini, daftar
    // sanggahan jadi jalan memutar untuk melihat (dan memutuskan) data wilayah
    // lain — persis lubang yang sudah ditutup di daftar rumah tangga.
    const where: any = {};
    if (status) where.status = status;
    const batas = filterWilayah(user);
    if (batas) {
      where.rumahTangga = { wilayahId: batas };
    }

    return this.prisma.sanggahanRequest.findMany({
      where,
      include: {
        rumahTangga: { select: { id: true, wilayahId: true, statusVerifikasi: true, periodeId: true } },
        diajukanOleh: { select: { id: true, nama: true, username: true, role: true } },
        ditinjauOleh: { select: { id: true, nama: true, username: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async review(
    id: string,
    dto: ReviewSanggahanDto,
    actorId: string,
    user?: PenggunaBerwilayah,
  ) {
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

    // Membatasi daftar saja tidak cukup: id sanggahan bisa diketahui dari tempat
    // lain, dan endpoint ini yang benar-benar mengubah data rumah tangga.
    if (!bolehAksesWilayah(user, request.rumahTangga.wilayahId)) {
      throw new HttpException(
        {
          error: {
            code: 'AKSES_DITOLAK',
            message: 'Sanggahan ini berasal dari luar wilayah kerja Anda',
          },
        },
        HttpStatus.FORBIDDEN,
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

        // Koreksi daftar anggota keluarga: ganti seluruh baris `anggota_keluarga`
        // lalu hitung ulang `jumlah_tanggungan`/`jumlah_disabilitas_lansia` dari
        // daftar barunya. Kedua kolom itu tidak pernah diterima sebagai angka
        // lepas — kalau boleh, kolom turunan bisa berbeda dari data anggotanya.
        const anggotaBaru = dataBaru.anggota as AnggotaDto[] | undefined;
        if (anggotaBaru?.length) {
          await this.terapkanAnggota(tx, request.rumahTanggaId, anggotaBaru);
          Object.assign(patch, hitungTurunanAnggota(anggotaBaru));
        }

        if (Object.keys(patch).length > 0) {
          await tx.rumahTangga.update({ where: { id: request.rumahTanggaId }, data: patch });
        }
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

  /**
   * Ganti seluruh daftar anggota keluarga satu rumah tangga.
   *
   * Aturan yang ditegakkan sama persis dengan jalur pendataan
   * (`RumahTanggaService.create()`), karena data yang lolos dari sini akan dipakai
   * pipeline mining yang sama: tepat satu `kepala`, tidak ada NIK ganda di dalam
   * usulan itu sendiri, dan tidak ada NIK yang sudah dipakai rumah tangga LAIN di
   * periode yang sama. Cek terakhir itu mengecualikan rumah tangga ini sendiri —
   * tanpa pengecualian tersebut, mengoreksi tanggal lahir satu anggota saja akan
   * ditolak sebagai "duplikat" oleh datanya sendiri.
   *
   * Divalidasi saat sanggahan DITERIMA, bukan saat diajukan: sanggahan bisa
   * menunggu berhari-hari di antrean, dan NIK yang tadinya bebas bisa keburu
   * dipakai rumah tangga lain dalam jeda itu.
   */
  private async terapkanAnggota(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    rumahTanggaId: string,
    anggota: AnggotaDto[],
  ) {
    const kepala = anggota.filter((a) => a.hubungan === 'kepala');
    if (kepala.length !== 1) {
      throw new HttpException(
        {
          error: {
            code: 'KEPALA_KELUARGA_TIDAK_TUNGGAL',
            message: `Daftar anggota harus memuat tepat satu anggota berhubungan 'kepala' (ditemukan ${kepala.length})`,
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const hashes = anggota.map((a) => hashWithPepper(a.nik));
    if (new Set(hashes).size !== hashes.length) {
      throw new HttpException(
        {
          error: {
            code: 'DUPLICATE_NIK_ANGGOTA',
            message: 'Ada NIK yang muncul lebih dari sekali di dalam daftar anggota yang diusulkan',
          },
        },
        HttpStatus.CONFLICT,
      );
    }

    const rt = await tx.rumahTangga.findUnique({
      where: { id: rumahTanggaId },
      select: { periodeId: true },
    });

    const bentrok = await tx.anggotaKeluarga.findFirst({
      where: {
        nikHash: { in: hashes },
        rumahTanggaId: { not: rumahTanggaId },
        rumahTangga: { periodeId: rt?.periodeId ?? null },
      },
    });
    if (bentrok) {
      throw new HttpException(
        {
          error: {
            code: 'DUPLICATE_NIK_ANGGOTA',
            message: 'Salah satu NIK anggota sudah terdaftar pada rumah tangga lain di periode ini',
          },
        },
        HttpStatus.CONFLICT,
      );
    }

    await tx.anggotaKeluarga.deleteMany({ where: { rumahTanggaId } });
    await tx.anggotaKeluarga.createMany({
      data: anggota.map((a) => ({
        rumahTanggaId,
        nikHash: hashWithPepper(a.nik),
        nikEnc: encrypt(a.nik),
        namaEnc: encrypt(a.nama),
        hubungan: a.hubungan as any,
        tanggalLahir: new Date(a.tanggal_lahir),
        statusDisabilitas: a.status_disabilitas,
        isTanggungan: a.is_tanggungan,
      })),
    });
  }
}
