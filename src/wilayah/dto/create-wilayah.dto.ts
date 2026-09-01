import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWilayahDto {
  @ApiProperty({
    example: '34.04.01.2001',
    description:
      'Kode desa/kelurahan Kepmendagri (PP.KK.CC.DDDD) dari GET /wilayah/referensi. ' +
      'Nama provinsi/kabupaten/kecamatan/desa diambil server dari tabel referensi — ' +
      'tidak dikirim klien, supaya kombinasi yang mustahil (mis. kecamatan Sleman ' +
      'di provinsi Bali) tidak bisa tersimpan.',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/, {
    message: 'kode harus berbentuk PP.KK.CC.DDDD, mis. 34.04.01.2001',
  })
  kode: string;
}
