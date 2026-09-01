import { Type } from 'class-transformer';
import {
  IsString, IsNumber, IsBoolean, IsUUID, IsArray,
  ValidateNested, IsEnum, IsDateString, Min, Max,
  Length, ArrayMinSize, IsOptional, Matches, ValidateIf,
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

  /**
   * Alamat administratif rumah tangga: kirim `kode_wilayah` (kode desa
   * Kepmendagri) ATAU `wilayah_id` (UUID baris wilayah yang sudah ada).
   *
   * `kode_wilayah` adalah jalur utama sejak menu "Wilayah Kerja" dihapus —
   * petugas memilih provinsi → kabupaten/kota → kecamatan → desa langsung di
   * form pendataan, dan baris `wilayah`-nya dibuat server pada penyimpanan
   * pertama untuk desa itu (WilayahService.pastikanWilayahKerja). `wilayah_id`
   * dipertahankan untuk importer CSV dan integrasi lama yang sudah memegang UUID.
   */
  @ApiProperty({ required: false, example: '34.04.01.2001', description: 'Kode desa Kepmendagri PP.KK.CC.DDDD' })
  @ValidateIf((o: CreateRumahTanggaDto) => !o.wilayah_id)
  @IsString()
  @Matches(/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/, {
    message: 'kode_wilayah harus berbentuk PP.KK.CC.DDDD, mis. 34.04.01.2001',
  })
  kode_wilayah?: string;

  @ApiProperty({ required: false, description: 'UUID wilayah yang sudah terdaftar; alternatif dari kode_wilayah' })
  @ValidateIf((o: CreateRumahTanggaDto) => !o.kode_wilayah)
  @IsUUID()
  wilayah_id?: string;

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
  @IsOptional()
  @IsUUID()
  @ApiProperty({ required: false })
  periode_id?: string;

  // Wallet penerima — dikumpulkan di sini alih-alih di-derive palsu saat build-merkle
  // (lihat blockchain.service.ts). 'mandiri' butuh wallet_address; kalau kosong dan
  // jenis_wallet dikirim 'custodial', backend generate wallet deterministik sebagai
  // placeholder pendamping desa (lihat rumah-tangga.service.ts create()).
  @IsOptional()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'wallet_address harus alamat Ethereum 0x + 40 hex char' })
  @ApiProperty({ required: false, example: '0x1234567890abcdef1234567890abcdef12345678' })
  wallet_address?: string;

  @IsOptional()
  @IsEnum(['mandiri', 'custodial'] as const)
  @ApiProperty({ required: false, enum: ['mandiri', 'custodial'] })
  jenis_wallet?: string;
}
