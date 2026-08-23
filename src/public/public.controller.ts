import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiQuery } from '@nestjs/swagger';
import { PublicService } from './public.service';

@ApiTags('Public')
@Controller('public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get('disbursement-summary')
  getDisbursementSummary() {
    return this.publicService.getDisbursementSummary();
  }

  @Get('claim-status')
  @ApiQuery({ name: 'q', required: true, description: 'Wallet address (0x...) atau referensi (REC-XXXX)' })
  checkClaimStatus(@Query('q') query: string) {
    return this.publicService.checkClaimStatus(query);
  }
}
