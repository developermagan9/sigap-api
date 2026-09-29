import { Controller, Post, Get, Param, Query, UseGuards, Request, Body } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { BlockchainService } from './blockchain.service';
import { BatasKlaimDto, TarikSisaDto } from './dto/penutupan-klaim.dto';

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

  /** Deposit token dari wallet admin ke kontrak disbursement sebesar kekurangan periode ini. */
  @Post(':id/danai-kontrak')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin' as any)
  danaiKontrak(@Param('id') id: string, @Request() req: any) {
    return this.blockchainService.danaiKontrak(id, req.user?.id);
  }

  /** Tarik event `FundDisbursed` sekarang juga, tanpa menunggu poller berikutnya. */
  @Post(':id/sync-klaim')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin' as any)
  syncKlaim(@Param('id') id: string) {
    return this.blockchainService.syncKlaim(id);
  }

  /** Tetapkan/perpanjang batas waktu klaim on-chain. */
  @Post(':id/batas-klaim')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin' as any)
  setBatasKlaim(@Param('id') id: string, @Body() dto: BatasKlaimDto, @Request() req: any) {
    return this.blockchainService.setBatasKlaim(id, new Date(dto.batas_klaim), req.user?.id);
  }

  /** Tarik sisa dana setelah batas klaim; penerima yang belum klaim ditandai `failed`. */
  @Post(':id/tarik-sisa')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin' as any)
  tarikSisa(@Param('id') id: string, @Body() dto: TarikSisaDto, @Request() req: any) {
    return this.blockchainService.tarikSisaDana(id, dto.tujuan, req.user?.id);
  }

  @Get(':id/disbursement-status')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin' as any)
  getDisbursementStatus(@Param('id') id: string) {
    return this.blockchainService.getDisbursementStatus(id);
  }
}
