import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto, UpdateUserDto } from './dto/kelola-user.dto';

/** Role yang kewenangannya dibatasi wilayah — tanpa wilayah mereka tidak melihat apa pun. */
const ROLE_BERWILAYAH: UserRole[] = ['petugas', 'verifikator'];

const PILIH_WILAYAH = { id: true, desa: true, kecamatan: true, kabupaten: true, provinsi: true } as const;

/**
 * Kelola wilayah akses TAMBAHAN seorang user (`user_wilayah`). Penegakannya sudah
 * penuh di `common/wilayah-scope.ts`; sebelum modul ini ada, satu-satunya cara
 * memberi verifikator kecamatan akses ke desa kedua adalah `INSERT` manual ke DB.
 *
 * Juga membuat user, mengubah role/wilayah utama/status aktif, dan reset password.
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
        lastLoginAt: true,
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

  async create(dto: CreateUserDto, actorId?: string) {
    if (ROLE_BERWILAYAH.includes(dto.role) && !dto.wilayah_id) {
      throw new HttpException(
        { code: 'WILAYAH_WAJIB', message: `Role ${dto.role} wajib punya wilayah kerja utama` },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.pastikanWilayahAda(dto.wilayah_id);
    try {
      const user = await this.prisma.user.create({
        data: {
          username: dto.username,
          nama: dto.nama,
          role: dto.role,
          wilayahId: dto.role === 'admin' ? null : dto.wilayah_id ?? null,
          passwordHash: await bcrypt.hash(dto.password, 10),
        },
      });
      await this.audit.log({
        actorId,
        action: 'CREATE_USER',
        entityType: 'users',
        entityId: user.id,
        afterState: { username: user.username, nama: user.nama, role: user.role, wilayahId: user.wilayahId },
      });
      return this.satu(user.id);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: 'USERNAME_SUDAH_ADA', message: `Username '${dto.username}' sudah dipakai` });
      }
      throw err;
    }
  }

  async update(userId: string, dto: UpdateUserDto, actorId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: 'TIDAK_DITEMUKAN', message: 'User tidak ditemukan' });

    // Admin tidak boleh mengunci dirinya sendiri keluar — kalau ia satu-satunya
    // admin, tidak ada lagi yang bisa memulihkannya dari UI.
    if (userId === actorId && (dto.is_active === false || (dto.role && dto.role !== 'admin'))) {
      throw new HttpException(
        { code: 'TIDAK_BOLEH_DIRI_SENDIRI', message: 'Tidak bisa menonaktifkan atau menurunkan role akun sendiri' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const role = dto.role ?? user.role;
    let wilayahId = dto.wilayah_id !== undefined ? dto.wilayah_id : user.wilayahId;
    if (role === 'admin') wilayahId = null;
    if (ROLE_BERWILAYAH.includes(role) && !wilayahId) {
      throw new HttpException(
        { code: 'WILAYAH_WAJIB', message: `Role ${role} wajib punya wilayah kerja utama` },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.pastikanWilayahAda(wilayahId);

    // Perubahan yang mengubah kewenangan (role, aktif) mencabut token lama supaya
    // berlaku seketika, bukan setelah token kedaluwarsa.
    const cabutToken = (dto.role !== undefined && dto.role !== user.role) || dto.is_active === false;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        nama: dto.nama ?? undefined,
        role,
        wilayahId,
        isActive: dto.is_active ?? undefined,
        ...(cabutToken ? { tokenVersion: { increment: 1 } } : {}),
      },
    });
    if (role === 'admin') {
      await this.prisma.userWilayah.deleteMany({ where: { userId } });
    }
    await this.audit.log({
      actorId,
      action: 'UPDATE_USER',
      entityType: 'users',
      entityId: userId,
      beforeState: { nama: user.nama, role: user.role, wilayahId: user.wilayahId, isActive: user.isActive },
      afterState: { nama: updated.nama, role: updated.role, wilayahId: updated.wilayahId, isActive: updated.isActive },
    });
    return this.satu(userId);
  }

  async resetPassword(userId: string, passwordBaru: string, actorId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException({ code: 'TIDAK_DITEMUKAN', message: 'User tidak ditemukan' });
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(passwordBaru, 10), tokenVersion: { increment: 1 } },
    });
    // Password baru sengaja TIDAK dicatat di audit.
    await this.audit.log({ actorId, action: 'RESET_PASSWORD', entityType: 'users', entityId: userId });
    return { success: true };
  }

  private async pastikanWilayahAda(wilayahId?: string | null) {
    if (!wilayahId) return;
    const ada = await this.prisma.wilayah.findUnique({ where: { id: wilayahId }, select: { id: true } });
    if (!ada) throw new NotFoundException({ code: 'TIDAK_DITEMUKAN', message: 'Wilayah tidak ditemukan' });
  }

  private async satu(userId: string) {
    return (await this.findAll()).find((u) => u.id === userId)!;
  }
}
