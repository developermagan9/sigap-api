import { Global, Module } from '@nestjs/common';
import { NotifikasiService } from './notifikasi.service';
import { NotifikasiController } from './notifikasi.controller';

/** Global seperti AuditModule — dipakai dari banyak modul sebagai efek samping aksi. */
@Global()
@Module({
  controllers: [NotifikasiController],
  providers: [NotifikasiService],
  exports: [NotifikasiService],
})
export class NotifikasiModule {}
