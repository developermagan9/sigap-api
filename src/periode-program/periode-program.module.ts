import { Module } from '@nestjs/common';
import { PeriodeProgramController } from './periode-program.controller';
import { PeriodeProgramService } from './periode-program.service';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuditModule, PrismaModule],
  controllers: [PeriodeProgramController],
  providers: [PeriodeProgramService],
  exports: [PeriodeProgramService],
})
export class PeriodeProgramModule {}
