import { IsEnum, IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifikasiDto {
  @ApiProperty({ enum: ['verified', 'rejected'] })
  @IsEnum(['verified', 'rejected'] as const)
  status_verifikasi: 'verified' | 'rejected';

  @ApiProperty({ required: false, example: 'Sesuai hasil kunjungan lapangan' })
  @IsString()
  @IsOptional()
  catatan?: string;
}
