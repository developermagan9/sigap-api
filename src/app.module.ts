import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WilayahModule } from './wilayah/wilayah.module';
import { RumahTanggaModule } from './rumah-tangga/rumah-tangga.module';
import { PeriodeProgramModule } from './periode-program/periode-program.module';
import { MiningModule } from './mining/mining.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { PublicModule } from './public/public.module';
import { AuditModule } from './audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    WilayahModule,
    RumahTanggaModule,
    PeriodeProgramModule,
    MiningModule,
    BlockchainModule,
    PublicModule,
    AuditModule,
  ],
})
export class AppModule {}
