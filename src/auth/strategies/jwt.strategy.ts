import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
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
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Pengguna tidak ditemukan atau tidak aktif');
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      wilayahId: user.wilayahId,
      nama: user.nama,
    };
  }
}
