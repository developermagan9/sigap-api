import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiQuery, ApiOperation } from '@nestjs/swagger';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { PublicService } from './public.service';

@ApiTags('Public')
@Controller('public')
// Endpoint publik tanpa auth — dibatasi rate-nya (default 60 req/menit/IP dari
// ThrottlerModule.forRoot) agar tidak bisa dipakai men-scrape data agregat.
@UseGuards(ThrottlerGuard)
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get('disbursement-summary')
  getDisbursementSummary() {
    return this.publicService.getDisbursementSummary();
  }

  @Get('programs')
  @ApiOperation({ summary: 'Daftar program/periode yang sudah disahkan' })
  getPrograms() {
    return this.publicService.getPrograms();
  }

  @Get('programs/:id')
  @ApiOperation({ summary: 'Detail satu program: agregat dana, bobot kriteria, cutoff, sebaran wilayah' })
  getProgramDetail(@Param('id') id: string) {
    return this.publicService.getProgramDetail(id);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Daftar transaksi pencairan (anonim, ber-pagination)' })
  @ApiQuery({ name: 'periode_id', required: false })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'claimed', 'failed'] })
  getTransactions(
    @Query('periode_id') periodeId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.publicService.getTransactions({
      periodeId,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      status,
    });
  }

  @Get('claim-status')
  @ApiQuery({ name: 'q', required: true, description: 'Wallet address (0x...) atau referensi (REC-XXXX)' })
  // Pencarian lebih ketat — 20 req/menit/IP sudah cukup untuk pemakaian wajar.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  checkClaimStatus(@Query('q') query: string) {
    return this.publicService.checkClaimStatus(query);
  }
}
