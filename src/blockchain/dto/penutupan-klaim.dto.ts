import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

export class BatasKlaimDto {
  @ApiProperty({ example: '2026-12-31T23:59:00+07:00' })
  @IsISO8601({ strict: true }, { message: 'batas_klaim harus tanggal ISO 8601' })
  batas_klaim: string;
}

export class TarikSisaDto {
  @ApiPropertyOptional({ description: 'Alamat penerima sisa dana (default: wallet admin/kas)', example: '0x…' })
  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'tujuan harus alamat 0x + 40 hex' })
  tujuan?: string;
}
