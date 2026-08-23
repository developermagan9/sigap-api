import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWilayahDto {
  @ApiProperty({
    example: 'Jawa Barat',
    description: 'Nama provinsi',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  provinsi: string;

  @ApiProperty({
    example: 'Bandung',
    description: 'Nama kabupaten atau kota',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  kabupaten: string;

  @ApiProperty({
    example: 'Coblong',
    description: 'Nama kecamatan',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  kecamatan: string;

  @ApiProperty({
    example: 'Dago',
    description: 'Nama kelurahan atau desa',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  desa: string;
}
