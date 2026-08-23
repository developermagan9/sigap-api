import { IsNumber, IsOptional, IsArray, IsObject, IsString } from 'class-validator';

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
  @IsString()
  skemaAlokasi: string;

  @IsNumber()
  nominalDasar: number;

  @IsNumber()
  biayaOperasional: number;
}

export class FinalizeRankingDto {
  @IsString()
  approvedBy: string;

  @IsString()
  catatan: string;
}
