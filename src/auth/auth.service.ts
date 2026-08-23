import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Email atau kata sandi tidak valid');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Email atau kata sandi tidak valid');
    }

    // Update last login timestamp
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(payload);

    return {
      access_token: accessToken,
      role: user.role,
      expires_in: 3600,
    };
  }

  async validateUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
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
