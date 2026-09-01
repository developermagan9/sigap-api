import { Module } from '@nestjs/common';
import { RumahTanggaService } from './rumah-tangga.service';
import { RumahTanggaController } from './rumah-tangga.controller';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WilayahModule } from '../wilayah/wilayah.module';

@Module({
  // WilayahModule dipakai untuk membuat baris `wilayah` dari kode desa saat
  // pendataan — lihat WilayahService.pastikanWilayahKerja.
  imports: [AuditModule, PrismaModule, WilayahModule],
  controllers: [RumahTanggaController],
  providers: [RumahTanggaService],
  exports: [RumahTanggaService],
})
export class RumahTanggaModule {}
