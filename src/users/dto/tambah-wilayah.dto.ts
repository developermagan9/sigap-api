import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class TambahWilayahDto {
  @ApiProperty({ description: 'ID wilayah kerja (tabel `wilayah`)', example: '00000000-0000-0000-0000-000000000000' })
  @IsUUID()
  wilayah_id: string;
}
