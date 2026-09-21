import {
  IsString, IsNumber, IsBoolean, IsOptional, Min, Max, IsUUID,
  ValidateNested, IsArray, ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { AnggotaDto } from '../../rumah-tangga/dto/create-rumah-tangga.dto';

/**
 * Subset field `RumahTangga` yang boleh diusulkan berubah lewat jalur sanggahan.
 * Sengaja TIDAK memuat skor TOPSIS/cluster apa pun — sanggahan cuma mengoreksi data
 * mentah, re-kalkulasi skor terjadi otomatis di run berikutnya (lihat catatan di
 * schema.prisma model SanggahanRequest).
 *
 * `jumlah_tanggungan` dan `jumlah_disabilitas_lansia` juga tidak ada di sini, dan
 * itu disengaja: keduanya **di-derive** dari daftar anggota keluarga, jadi
 * menerimanya sebagai angka lepas akan membuat kolom turunan tidak lagi cocok
 * dengan datanya sendiri. Yang dikoreksi adalah `anggota` — daftar lengkapnya —
 * dan kedua kolom itu dihitung ulang server lewat `hitungTurunanAnggota()`, fungsi
 * yang sama persis dengan yang dipakai jalur pendataan.
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

  /**
   * Daftar anggota keluarga PENGGANTI — dikirim utuh, bukan tambal-sulam per baris.
   *
   * Penggantian penuh dipilih supaya usulan koreksi bisa dibaca apa adanya sebagai
   * "beginilah susunan keluarga yang benar": patch parsial (tambah/hapus/ubah satu
   * anggota) butuh id anggota yang stabil di sisi klien, sementara justru anggota
   * yang salah input itulah yang sering perlu dihapus. Aturan yang berlaku sama
   * dengan form pendataan — tepat satu `kepala`, NIK 16 digit, tidak boleh ada NIK
   * ganda — dan diverifikasi ulang saat sanggahan DITERIMA, bukan saat diajukan.
   */
  @ApiProperty({ required: false, type: [AnggotaDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AnggotaDto)
  anggota?: AnggotaDto[];
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
