import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SanggahanService } from './sanggahan.service';
import { CreateSanggahanDto } from './dto/create-sanggahan.dto';
import { ReviewSanggahanDto } from './dto/review-sanggahan.dto';

@ApiTags('Sanggahan')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller()
export class SanggahanController {
  constructor(private readonly sanggahanService: SanggahanService) {}

  @Post('rumah-tangga/:id/sanggahan')
  @Roles('petugas', 'admin')
  create(@Param('id') id: string, @Body() dto: CreateSanggahanDto, @Request() req: any) {
    return this.sanggahanService.create(id, dto, req.user?.id);
  }

  @Get('sanggahan')
  @Roles('verifikator', 'admin')
  findAll(@Request() req: any, @Query('status') status?: string) {
    return this.sanggahanService.findAll(status, req.user);
  }

  @Patch('sanggahan/:id/review')
  @Roles('verifikator', 'admin')
  review(@Param('id') id: string, @Body() dto: ReviewSanggahanDto, @Request() req: any) {
    return this.sanggahanService.review(id, dto, req.user?.id, req.user);
  }
}
