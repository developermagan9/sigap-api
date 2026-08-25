import { IsEnum, IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReviewSanggahanDto {
  @ApiProperty({ enum: ['diterima', 'ditolak'] })
  @IsEnum(['diterima', 'ditolak'] as const)
  status: 'diterima' | 'ditolak';

  @ApiProperty({ required: false, example: 'Sesuai hasil kunjungan ulang lapangan' })
  @IsString()
  @IsOptional()
  catatan?: string;
}
