import { Module } from '@nestjs/common';
import { RumahTanggaService } from './rumah-tangga.service';
import { RumahTanggaController } from './rumah-tangga.controller';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuditModule, PrismaModule],
  controllers: [RumahTanggaController],
  providers: [RumahTanggaService],
  exports: [RumahTanggaService],
})
export class RumahTanggaModule {}
