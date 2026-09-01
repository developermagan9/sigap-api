import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ReferensiQueryDto {
  @ApiPropertyOptional({
    example: '34',
    description:
      'Kode induk. Kosong -> daftar provinsi; `34` -> kabupaten/kota di DIY; ' +
      '`34.04` -> kecamatan di Sleman; `34.04.01` -> desa di Gamping.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}(\.\d{2}){0,2}$/, {
    message: 'induk harus kode provinsi/kabupaten/kecamatan (PP, PP.KK, atau PP.KK.CC)',
  })
  induk?: string;
}
