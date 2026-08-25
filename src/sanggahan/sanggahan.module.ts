import { Module } from '@nestjs/common';
import { SanggahanService } from './sanggahan.service';
import { SanggahanController } from './sanggahan.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SanggahanController],
  providers: [SanggahanService],
  exports: [SanggahanService],
})
export class SanggahanModule {}
