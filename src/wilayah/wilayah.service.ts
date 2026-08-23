import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWilayahDto } from './dto/create-wilayah.dto';

@Injectable()
export class WilayahService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.wilayah.findMany({
      orderBy: [
        { provinsi: 'asc' },
        { kabupaten: 'asc' },
        { kecamatan: 'asc' },
        { desa: 'asc' },
      ],
    });
  }

  async findOne(id: string) {
    const wilayah = await this.prisma.wilayah.findUnique({
      where: { id },
    });

    if (!wilayah) {
      throw new NotFoundException({
        code: 'TIDAK_DITEMUKAN',
        message: `Wilayah dengan ID '${id}' tidak ditemukan`,
      });
    }

    return wilayah;
  }

  async create(data: CreateWilayahDto) {
    return this.prisma.wilayah.create({
      data: {
        provinsi: data.provinsi,
        kabupaten: data.kabupaten,
        kecamatan: data.kecamatan,
        desa: data.desa,
      },
    });
  }
}
