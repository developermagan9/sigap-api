import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PeriodeProgramService } from './periode-program.service';
import { CreatePeriodeDto } from './dto/create-periode.dto';
import { UpdatePeriodeDto } from './dto/update-periode.dto';

@ApiTags('Periode Program')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('periode-program')
export class PeriodeProgramController {
  constructor(private readonly periodeProgramService: PeriodeProgramService) {}

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Buat periode program bansos baru' })
  @ApiResponse({ status: 201, description: 'Periode program berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Bobot kriteria tidak valid (Σ ≠ 1.0)' })
  create(@Body() dto: CreatePeriodeDto, @Request() req: any) {
    return this.periodeProgramService.create(dto, req.user?.id);
  }

  @Get()
  @Roles('admin', 'verifikator', 'petugas')
  @ApiOperation({ summary: 'Daftar semua periode program' })
  @ApiResponse({ status: 200, description: 'Daftar periode program berhasil diambil' })
  findAll() {
    return this.periodeProgramService.findAll();
  }

  @Get(':id')
  @Roles('admin', 'verifikator', 'petugas')
  @ApiOperation({ summary: 'Detail satu periode program' })
  @ApiResponse({ status: 200, description: 'Detail periode program berhasil diambil' })
  @ApiResponse({ status: 404, description: 'Periode program tidak ditemukan' })
  findOne(@Param('id') id: string) {
    return this.periodeProgramService.findOne(id);
  }

  @Patch(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update periode program (hanya saat draft)' })
  @ApiResponse({ status: 200, description: 'Periode program berhasil diupdate' })
  @ApiResponse({ status: 400, description: 'Bobot kriteria tidak valid' })
  @ApiResponse({ status: 404, description: 'Periode program tidak ditemukan' })
  @ApiResponse({ status: 422, description: 'Periode terkunci (status bukan draft)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePeriodeDto,
    @Request() req: any,
  ) {
    return this.periodeProgramService.update(id, dto, req.user?.id);
  }

  @Get(':id/summary')
  @Roles('admin', 'verifikator', 'petugas')
  @ApiOperation({ summary: 'Ringkasan statistik agregat periode program' })
  @ApiResponse({ status: 200, description: 'Statistik periode berhasil diambil' })
  @ApiResponse({ status: 404, description: 'Periode program tidak ditemukan' })
  getSummary(@Param('id') id: string) {
    return this.periodeProgramService.getSummary(id);
  }
}
