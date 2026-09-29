import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  /** tokenVersion user saat token ditandatangani. */
  tv?: number;
  jti?: string;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Harus nilai yang sama persis dengan yang dipakai JwtModule saat
      // menandatangani (lihat auth.module.ts) — keduanya lewat ConfigService.
      secretOrKey: config.get<string>('JWT_SECRET') || 'sigap-secret',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      // Wilayah akses ikut ditarik di sini — sekali per request yang sudah
      // melakukan findUnique ini — supaya tiap service tidak perlu query sendiri
      // hanya untuk tahu batas kewenangan pemanggil.
      include: { wilayahAkses: { select: { wilayahId: true } } },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Pengguna tidak ditemukan atau tidak aktif');
    }
    // Token dicabut (logout, ganti/reset password, dinonaktifkan) dengan menaikkan
    // tokenVersion. Token lama tanpa `tv` diperlakukan sebagai versi 0.
    if ((payload.tv ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException('Sesi sudah berakhir, silakan login ulang');
    }
    if (payload.jti && (await this.prisma.revokedToken.findUnique({ where: { jti: payload.jti }, select: { jti: true } }))) {
      throw new UnauthorizedException('Sesi sudah berakhir, silakan login ulang');
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      wilayahId: user.wilayahId,
      // Kewenangan efektif = wilayah utama + seluruh wilayah tambahan.
      wilayahIds: [
        ...new Set([user.wilayahId, ...user.wilayahAkses.map((w) => w.wilayahId)].filter(Boolean)),
      ] as string[],
      nama: user.nama,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
