import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WilayahModule } from './wilayah/wilayah.module';
import { RumahTanggaModule } from './rumah-tangga/rumah-tangga.module';
import { PeriodeProgramModule } from './periode-program/periode-program.module';
import { MiningModule } from './mining/mining.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { PublicModule } from './public/public.module';
import { AuditModule } from './audit/audit.module';
import { SanggahanModule } from './sanggahan/sanggahan.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting untuk API publik (07-Security-Privacy-Ethics.md §3) — mencegah
    // scraping data agregat / DDoS. Diterapkan lewat ThrottlerGuard di
    // PublicController (endpoint tanpa auth). Endpoint ber-JWT tidak dibatasi.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PrismaModule,
    AuthModule,
    WilayahModule,
    RumahTanggaModule,
    PeriodeProgramModule,
    MiningModule,
    BlockchainModule,
    PublicModule,
    AuditModule,
    SanggahanModule,
    UsersModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
