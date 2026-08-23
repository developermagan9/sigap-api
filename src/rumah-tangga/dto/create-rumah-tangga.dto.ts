import { Type } from 'class-transformer';
import {
  IsString, IsNumber, IsBoolean, IsUUID, IsArray,
  ValidateNested, IsEnum, IsDateString, Min, Max,
  Length, ArrayMinSize,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AnggotaDto {
  @ApiProperty({ example: '3273xxxxxxxxxxxx' })
  @IsString()
  @Length(16, 16)
  nik: string;

  @ApiProperty({ example: 'Nama Anggota' })
  @IsString()
  nama: string;

  @ApiProperty({ enum: ['kepala', 'istri_suami', 'anak', 'orang_tua', 'famili_lain'] })
  @IsEnum(['kepala', 'istri_suami', 'anak', 'orang_tua', 'famili_lain'] as const)
  hubungan: string;

  @ApiProperty({ example: '1979-04-11' })
  @IsDateString()
  tanggal_lahir: string;

  @ApiProperty({ example: false })
  @IsBoolean()
  status_disabilitas: boolean;

  @ApiProperty({ example: false })
  @IsBoolean()
  is_tanggungan: boolean;
}

export class CreateRumahTanggaDto {
  @ApiProperty({ example: '3273xxxxxxxxxxxx' })
  @IsString()
  @Length(16, 16)
  nik_kepala_keluarga: string;

  @ApiProperty({ example: '3273xxxxxxxxxxxx' })
  @IsString()
  @Length(16, 16)
  no_kk: string;

  @ApiProperty({ example: 'Nama Kepala Keluarga' })
  @IsString()
  nama_kepala_keluarga: string;

  @ApiProperty({ example: 'Jl. Contoh No. 1' })
  @IsString()
  alamat_detail: string;

  @ApiProperty()
  @IsUUID()
  wilayah_id: string;

  @ApiProperty({ example: 650000 })
  @IsNumber()
  @Min(0)
  pendapatan_per_kapita: number;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(1)
  @Max(5)
  skor_kondisi_rumah: number;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(1)
  @Max(5)
  skor_akses_pendidikan: number;

  @ApiProperty({ example: false })
  @IsBoolean()
  riwayat_bansos_sebelumnya: boolean;

  @ApiProperty({ type: [AnggotaDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AnggotaDto)
  anggota: AnggotaDto[];

  // Optional: link to a program period
  @IsUUID()
  @ApiProperty({ required: false })
  periode_id?: string;
}
