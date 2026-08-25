import { IsString, IsNumber, IsBoolean, IsOptional, Min, Max, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Subset field `RumahTangga` yang boleh diusulkan berubah lewat jalur sanggahan.
 * Sengaja TIDAK memuat skor TOPSIS/cluster apa pun — sanggahan cuma mengoreksi data
 * mentah, re-kalkulasi skor terjadi otomatis di run berikutnya (lihat catatan di
 * schema.prisma model SanggahanRequest). `anggota` (jumlah_tanggungan dkk.) belum
 * bisa dikoreksi lewat jalur ini karena field itu di-derive dari daftar anggota
 * keluarga, bukan kolom langsung — di luar scope task ini.
 */
export class DataBaruDto {
  @ApiProperty({ required: false, example: 450000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  pendapatan_per_kapita?: number;

  @ApiProperty({ required: false, example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  skor_kondisi_rumah?: number;

  @ApiProperty({ required: false, example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  skor_akses_pendidikan?: number;

  @ApiProperty({ required: false, example: false })
  @IsOptional()
  @IsBoolean()
  riwayat_bansos_sebelumnya?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  wilayah_id?: string;
}

export class CreateSanggahanDto {
  @ApiProperty({ example: 'Pendapatan sudah turun sejak suami kehilangan pekerjaan bulan lalu, belum sesuai data awal.' })
  @IsString()
  alasan: string;

  @ApiProperty({ type: DataBaruDto })
  @ValidateNested()
  @Type(() => DataBaruDto)
  data_baru: DataBaruDto;
}
