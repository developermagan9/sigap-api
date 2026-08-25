import { Module } from '@nestjs/common';
import { KMeansService } from './kmeans.service';
import { TopsisService } from './topsis.service';
import { AlokasiService } from './alokasi.service';
import { MiningService } from './mining.service';
import { MiningController } from './mining.controller';
import { AuditModule } from '../audit/audit.module';
import { PeriodeProgramModule } from '../periode-program/periode-program.module';

@Module({
  imports: [AuditModule, PeriodeProgramModule],
  controllers: [MiningController],
  providers: [
    KMeansService,
    TopsisService,
    AlokasiService,
    MiningService,
  ],
  exports: [MiningService],
})
export class MiningModule {}
