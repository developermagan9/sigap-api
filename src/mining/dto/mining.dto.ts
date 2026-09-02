import { IsNumber, IsOptional, IsArray, IsObject, IsString, IsEnum, IsUUID, Min } from 'class-validator';

export class RunClusteringDto {
  @IsNumber()
  @IsOptional()
  k?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  fitur?: string[];
}

export class RunTopsisDto {
  @IsArray()
  @IsNumber({}, { each: true })
  clusterIndexTarget: number[];

  @IsObject()
  bobotKriteria: Record<string, number>;
}

export class RunAlokasiDto {
  @IsEnum(['flat', 'berjenjang', 'proporsional'] as const)
  skemaAlokasi: string;

  @IsNumber()
  nominalDasar: number;

  @IsNumber()
  biayaOperasional: number;

  /** Skema `berjenjang` saja — pengali nominal per label cluster, mis.
   *  `{ "Sangat Rentan": 1.25, "Rentan": 1.0 }` (05-Algorithm-Design.md §5.2-B).
   *  Kalau tidak dikirim, dipakai `periode_program.faktor_cluster`, lalu default sistem. */
  @IsObject()
  @IsOptional()
  faktorCluster?: Record<string, number>;

  /** Skema `proporsional` saja — batas bawah/atas nominal per penerima (§5.2-C).
   *  Default: 0.5x dan 2x nominalDasar. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  nominalMin?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  nominalMax?: number;
}

export class FinalizeRankingDto {
  /**
   * ID user (UUID) yang menyetujui — bukan username. Divalidasi `@IsUUID()`
   * supaya nilai salah ditolak `400` sebelum menyentuh DB sama sekali: tanpa
   * ini, `finalizeRanking()` sempat meng-commit transisi status
   * `alokasi -> reviewed` lebih dulu, lalu baru gagal saat `audit.log()`
   * menulis `actorId` ke kolom UUID — API melaporkan 500 (dengan detail Prisma
   * ikut bocor ke response) padahal status periode sudah terlanjur berubah.
   */
  @IsUUID()
  approvedBy: string;

  @IsString()
  catatan: string;
}
