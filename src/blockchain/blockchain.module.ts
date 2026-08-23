import { Module } from '@nestjs/common';
import { MerkleService } from './merkle.service';
import { BlockchainService } from './blockchain.service';
import { BlockchainController } from './blockchain.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [BlockchainController],
  providers: [MerkleService, BlockchainService],
  exports: [BlockchainService],
})
export class BlockchainModule {}
