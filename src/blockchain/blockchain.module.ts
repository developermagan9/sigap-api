import { Module } from '@nestjs/common';
import { MerkleService } from './merkle.service';
import { BlockchainService } from './blockchain.service';
import { BlockchainController } from './blockchain.controller';
import { AuditModule } from '../audit/audit.module';
import { PeriodeProgramModule } from '../periode-program/periode-program.module';

@Module({
  // PeriodeProgramModule diimpor demi `updateStatus()` — satu-satunya jalur sah
  // untuk mengubah `periode_program.status` (lihat catatan FSM di service-nya).
  imports: [AuditModule, PeriodeProgramModule],
  controllers: [BlockchainController],
  providers: [MerkleService, BlockchainService],
  exports: [BlockchainService],
})
export class BlockchainModule {}
