import { Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MiningService } from './mining.service';
import { RunClusteringDto, RunTopsisDto, RunAlokasiDto, FinalizeRankingDto } from './dto/mining.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('periode-program')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class MiningController {
  constructor(private readonly miningService: MiningService) {}

  @Post(':id/run-clustering')
  async runClustering(
    @Param('id') periodeId: string,
    @Body() dto: RunClusteringDto
  ) {
    return this.miningService.runClustering(periodeId, dto.k, dto.fitur);
  }

  @Get(':id/clustering-result')
  async getClusteringResult(@Param('id') periodeId: string) {
    return this.miningService.getClusteringResult(periodeId);
  }

  @Post(':id/run-topsis')
  async runTopsis(
    @Param('id') periodeId: string,
    @Body() dto: RunTopsisDto
  ) {
    return this.miningService.runTopsis(periodeId, dto.clusterIndexTarget, dto.bobotKriteria);
  }

  @Get(':id/ranking-result')
  async getRankingResult(
    @Param('id') periodeId: string,
    @Query('status') status?: string
  ) {
    return this.miningService.getRankingResult(periodeId, status);
  }

  @Post(':id/run-alokasi')
  async runAlokasi(
    @Param('id') periodeId: string,
    @Body() dto: RunAlokasiDto
  ) {
    return this.miningService.runAlokasi(periodeId, dto.skemaAlokasi, dto.nominalDasar, dto.biayaOperasional);
  }

  @Post(':id/finalize-ranking')
  async finalizeRanking(
    @Param('id') periodeId: string,
    @Body() dto: FinalizeRankingDto
  ) {
    return this.miningService.finalizeRanking(periodeId, dto.approvedBy, dto.catatan);
  }
}
