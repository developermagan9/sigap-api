import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LoginDto } from './dto/login.dto';
import { GantiPasswordDto } from './dto/ganti-password.dto';
import { LoginLimiter } from './login-limiter';

@Injectable()
export class AuthService {
  private readonly limiter = new LoginLimiter(
    Number(process.env.LOGIN_MAKS_GAGAL ?? 5),
    Number(process.env.LOGIN_KUNCI_MENIT ?? 15) * 60_000,
  );

  /** Hash sungguhan untuk dibandingkan saat username tidak ada (lihat login()). */
  private readonly hashDummy = bcrypt.hashSync('bukan-password-siapa-pun', 10);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto) {
    const sisa = this.limiter.sisaKunci(dto.username);
    if (sisa > 0) {
      throw new HttpException(
        {
          code: 'LOGIN_TERKUNCI',
          message: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${Math.ceil(sisa / 60)} menit.`,
          details: { retry_after_detik: sisa },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });

    // Password tetap dibandingkan walau user tidak ada/nonaktif, supaya waktu
    // respons tidak membocorkan username mana yang terdaftar.
    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? this.hashDummy,
    );
    if (!user || !user.isActive || !isPasswordValid) {
      this.limiter.catatGagal(dto.username);
      throw new UnauthorizedException('Email atau kata sandi tidak valid');
    }
    this.limiter.reset(dto.username);

    // Update last login timestamp
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      // Versi token saat ditandatangani — lihat JwtStrategy.validate().
      tv: user.tokenVersion,
    };

    const accessToken = this.jwtService.sign(payload, { jwtid: randomUUID() });

    return {
      access_token: accessToken,
      role: user.role,
      expires_in: 3600,
    };
  }

  /**
   * Cabut token yang dipakai request ini saja. Sengaja bukan `tokenVersion`: akun
   * demo dipakai bersama, dan logout satu orang tidak boleh mengeluarkan yang lain.
   */
  async logout(userId: string, jti?: string, exp?: number) {
    if (jti) {
      await this.prisma.revokedToken.upsert({
        where: { jti },
        create: { jti, expiresAt: new Date((exp ?? Math.floor(Date.now() / 1000) + 86_400) * 1000) },
        update: {},
      });
      // Bersih-bersih oportunistis — tidak perlu cron untuk skala dev.
      await this.prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    }
    await this.audit.log({ actorId: userId, action: 'LOGOUT', entityType: 'users', entityId: userId });
    return { success: true };
  }

  async gantiPassword(userId: string, dto: GantiPasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await bcrypt.compare(dto.password_lama, user.passwordHash))) {
      throw new HttpException(
        { code: 'PASSWORD_LAMA_SALAH', message: 'Password lama tidak cocok' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (dto.password_lama === dto.password_baru) {
      throw new HttpException(
        { code: 'PASSWORD_SAMA', message: 'Password baru harus berbeda dari password lama' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      // Token lama (termasuk sesi ini) ikut dicabut — pengguna login ulang dengan password baru.
      data: { passwordHash: await bcrypt.hash(dto.password_baru, 10), tokenVersion: { increment: 1 } },
    });
    await this.audit.log({ actorId: userId, action: 'GANTI_PASSWORD', entityType: 'users', entityId: userId });
    return { success: true };
  }
}
