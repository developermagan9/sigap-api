import { IsString, IsNumber, IsOptional, IsObject, IsEnum, IsArray, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePeriodeDto {
  @ApiProperty({ example: 'BLT Desa — Kecamatan Sukamaju' })
  @IsString()
  nama_program: string;

  @ApiProperty({ example: 92750000 })
  @IsNumber()
  @Min(0)
  anggaran_total: number;

  @ApiProperty({ example: 0, required: false })
  @IsNumber()
  @IsOptional()
  biaya_operasional?: number;

  @ApiProperty({ example: 4, required: false })
  @IsNumber()
  @IsOptional()
  k_cluster?: number;

  @ApiProperty({ example: { pendapatan_per_kapita: 0.35, jumlah_tanggungan: 0.25, jumlah_disabilitas_lansia: 0.2, skor_kondisi_rumah: 0.2 } })
  @IsObject()
  bobot_kriteria: Record<string, number>;

  @ApiProperty({ enum: ['flat', 'berjenjang', 'proporsional'], required: false })
  @IsEnum(['flat', 'berjenjang', 'proporsional'] as const)
  @IsOptional()
  skema_alokasi?: string;

  @ApiProperty({ example: 500000, required: false })
  @IsNumber()
  @IsOptional()
  nominal_dasar?: number;
}
