import { Controller, Post, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { BlockchainService } from './blockchain.service';

@ApiTags('Blockchain')
@Controller('periode-program')
export class BlockchainController {
  constructor(private readonly blockchainService: BlockchainService) {}

  @Post(':id/build-merkle')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin' as any)
  buildMerkle(@Param('id') id: string) {
    return this.blockchainService.buildMerkle(id);
  }

  @Get(':id/claim-proof')
  @ApiQuery({ name: 'wallet', required: true, example: '0xabc...' })
  getClaimProof(@Param('id') id: string, @Query('wallet') wallet: string) {
    return this.blockchainService.getClaimProof(id, wallet);
  }

  @Post(':id/submit-onchain')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin' as any)
  submitOnchain(@Param('id') id: string, @Request() req: any) {
    return this.blockchainService.submitOnchain(id, req.user?.id);
  }

  @Get(':id/disbursement-status')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin' as any)
  getDisbursementStatus(@Param('id') id: string) {
    return this.blockchainService.getDisbursementStatus(id);
  }
}
