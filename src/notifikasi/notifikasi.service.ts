import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { KanalNotifikasi, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface KirimNotifikasi {
  kanal: KanalNotifikasi;
  /** Penerima internal (`in_app`). */
  userId?: string | null;
  /** Tujuan eksternal (`sms_mock`): referensi penerima / wallet. */
  tujuan?: string | null;
  judul: string;
  pesan: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Notifikasi mock — 01-PRD.md menetapkan SMS/WA produksi di luar cakupan ("cukup
 * mock/log"). Semua notifikasi dicatat ke tabel `notifikasi` + log server; tidak ada
 * yang dikirim keluar. Kegagalan menulis notifikasi TIDAK boleh menggagalkan aksi
 * bisnis yang memicunya, jadi setiap galat hanya di-log.
 */
@Injectable()
export class NotifikasiService {
  private readonly logger = new Logger('Notifikasi');

  constructor(private readonly prisma: PrismaService) {}

  async kirim(data: KirimNotifikasi | KirimNotifikasi[]) {
    const daftar = (Array.isArray(data) ? data : [data]).filter((n) => n.kanal === 'sms_mock' || n.userId);
    if (daftar.length === 0) return;
    try {
      await this.prisma.notifikasi.createMany({
        data: daftar.map((n) => ({
          kanal: n.kanal,
          userId: n.userId ?? null,
          tujuan: n.tujuan ?? null,
          judul: n.judul,
          pesan: n.pesan,
          entityType: n.entityType ?? null,
          entityId: n.entityId ?? null,
        })),
      });
      for (const n of daftar) {
        this.logger.log(`[${n.kanal}] → ${n.userId ?? n.tujuan}: ${n.judul} — ${n.pesan}`);
      }
    } catch (err) {
      this.logger.warn(`Gagal mencatat ${daftar.length} notifikasi: ${err}`);
    }
  }

  /** Kirim `in_app` ke semua user aktif dengan salah satu role ini. */
  async kirimKeRole(roles: UserRole[], n: Omit<KirimNotifikasi, 'kanal' | 'userId' | 'tujuan'>, kecualiUserId?: string) {
    const users = await this.prisma.user.findMany({
      where: { role: { in: roles }, isActive: true, ...(kecualiUserId ? { id: { not: kecualiUserId } } : {}) },
      select: { id: true },
    });
    await this.kirim(users.map((u) => ({ ...n, kanal: 'in_app' as const, userId: u.id })));
  }

  /** Kirim `in_app` ke admin + verifikator yang berwenang atas wilayah ini. */
  async kirimKePeninjauWilayah(wilayahId: string, n: Omit<KirimNotifikasi, 'kanal' | 'userId' | 'tujuan'>, kecualiUserId?: string) {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        ...(kecualiUserId ? { id: { not: kecualiUserId } } : {}),
        OR: [
          { role: 'admin' },
          { role: 'verifikator', OR: [{ wilayahId }, { wilayahAkses: { some: { wilayahId } } }] },
        ],
      },
      select: { id: true },
    });
    await this.kirim(users.map((u) => ({ ...n, kanal: 'in_app' as const, userId: u.id })));
  }

  /** Pembuat data rumah tangga, dibaca dari jejak audit (tabelnya tidak menyimpan kolom pembuat). */
  async pembuatRumahTangga(rumahTanggaId: string): Promise<string | null> {
    const log = await this.prisma.auditLog.findFirst({
      where: { entityType: 'rumah_tangga', entityId: rumahTanggaId, action: { in: ['CREATE_RUMAH_TANGGA', 'IMPORT_CSV_RUMAH_TANGGA'] } },
      orderBy: { createdAt: 'asc' },
      select: { actorId: true },
    });
    return log?.actorId ?? null;
  }

  async milikSaya(userId: string, hanyaBelumDibaca: boolean, page: number, limit: number) {
    const where: Prisma.NotifikasiWhereInput = { userId, kanal: 'in_app', ...(hanyaBelumDibaca ? { dibacaAt: null } : {}) };
    const [data, total, belumDibaca] = await Promise.all([
      this.prisma.notifikasi.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.notifikasi.count({ where }),
      this.prisma.notifikasi.count({ where: { userId, kanal: 'in_app', dibacaAt: null } }),
    ]);
    return { data, total, belum_dibaca: belumDibaca, page, limit };
  }

  /** Outbox SMS mock — untuk admin memeriksa apa yang "akan" dikirim ke warga. */
  async outboxSms(page: number, limit: number) {
    const where: Prisma.NotifikasiWhereInput = { kanal: 'sms_mock' };
    const [data, total] = await Promise.all([
      this.prisma.notifikasi.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.notifikasi.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async tandaiDibaca(id: string, userId: string) {
    const { count } = await this.prisma.notifikasi.updateMany({
      where: { id, userId, dibacaAt: null },
      data: { dibacaAt: new Date() },
    });
    if (count === 0) {
      const ada = await this.prisma.notifikasi.findFirst({ where: { id, userId }, select: { id: true } });
      if (!ada) throw new NotFoundException({ code: 'TIDAK_DITEMUKAN', message: 'Notifikasi tidak ditemukan' });
    }
    return { id, dibaca: true };
  }

  async tandaiSemuaDibaca(userId: string) {
    const { count } = await this.prisma.notifikasi.updateMany({
      where: { userId, kanal: 'in_app', dibacaAt: null },
      data: { dibacaAt: new Date() },
    });
    return { ditandai: count };
  }
}
