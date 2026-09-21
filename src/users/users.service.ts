import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const PILIH_WILAYAH = { id: true, desa: true, kecamatan: true, kabupaten: true, provinsi: true } as const;

/**
 * Kelola wilayah akses TAMBAHAN seorang user (`user_wilayah`). Penegakannya sudah
 * penuh di `common/wilayah-scope.ts`; sebelum modul ini ada, satu-satunya cara
 * memberi verifikator kecamatan akses ke desa kedua adalah `INSERT` manual ke DB.
 *
 * Wilayah UTAMA (`users.wilayah_id`) sengaja tidak diubah dari sini — ia juga
 * dipakai sebagai default form & label, dan bukan bagian dari b1.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll() {
    const users = await this.prisma.user.findMany({
      orderBy: [{ role: 'asc' }, { username: 'asc' }],
      select: {
        id: true,
        username: true,
        nama: true,
        role: true,
        isActive: true,
        wilayah: { select: PILIH_WILAYAH },
        wilayahAkses: { select: { wilayah: { select: PILIH_WILAYAH } } },
      },
    });
    return users.map(({ wilayahAkses, ...u }) => ({
      ...u,
      wilayah_tambahan: wilayahAkses.map((a) => a.wilayah).sort((a, b) => a.desa.localeCompare(b.desa)),
    }));
  }

  async tambahWilayah(userId: string, wilayahId: string, actorId?: string) {
    const [user, wilayah] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, wilayahId: true } }),
      this.prisma.wilayah.findUnique({ where: { id: wilayahId }, select: { id: true } }),
    ]);
    if (!user) throw new NotFoundException({ code: 'TIDAK_DITEMUKAN', message: 'User tidak ditemukan' });
    if (!wilayah) throw new NotFoundException({ code: 'TIDAK_DITEMUKAN', message: 'Wilayah tidak ditemukan' });
    if (user.role === 'admin') {
      // Admin tidak dibatasi wilayah sama sekali (tanpaBatasWilayah) — baris akses
      // untuknya tidak berefek dan hanya menyesatkan pembaca daftar.
      throw new HttpException(
        { code: 'TIDAK_RELEVAN', message: 'Admin sudah berwenang atas seluruh wilayah' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (user.wilayahId === wilayahId) {
      throw new HttpException(
        { code: 'SUDAH_WILAYAH_UTAMA', message: 'Wilayah ini sudah menjadi wilayah utama user' },
        HttpStatus.CONFLICT,
      );
    }

    // Idempoten: menambah wilayah yang sudah ada tidak dianggap galat.
    await this.prisma.userWilayah.upsert({
      where: { userId_wilayahId: { userId, wilayahId } },
      create: { userId, wilayahId },
      update: {},
    });
    await this.audit.log({
      actorId,
      action: 'tambah_wilayah_akses',
      entityType: 'users',
      entityId: userId,
      afterState: { wilayahId },
    });
    return this.satu(userId);
  }

  async hapusWilayah(userId: string, wilayahId: string, actorId?: string) {
    const { count } = await this.prisma.userWilayah.deleteMany({ where: { userId, wilayahId } });
    if (count === 0) {
      throw new NotFoundException({ code: 'TIDAK_DITEMUKAN', message: 'User tidak punya akses tambahan ke wilayah ini' });
    }
    await this.audit.log({
      actorId,
      action: 'hapus_wilayah_akses',
      entityType: 'users',
      entityId: userId,
      beforeState: { wilayahId },
    });
    return this.satu(userId);
  }

  private async satu(userId: string) {
    return (await this.findAll()).find((u) => u.id === userId)!;
  }
}
