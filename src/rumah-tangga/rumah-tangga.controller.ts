import { Controller, Post, Body, Get, Patch, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RumahTanggaService } from './rumah-tangga.service';
import { CreateRumahTanggaDto } from './dto/create-rumah-tangga.dto';
import { VerifikasiDto } from './dto/verifikasi.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Rumah Tangga')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('rumah-tangga') // prefix v1 is applied globally
export class RumahTanggaController {
  constructor(private readonly rumahTanggaService: RumahTanggaService) {}

  @Post()
  @Roles('petugas', 'admin')
  create(@Body() dto: CreateRumahTanggaDto, @Request() req: any) {
    return this.rumahTanggaService.create(dto, req.user?.id);
  }

  @Post('import')
  @Roles('petugas', 'admin')
  importCsv() {
    return {
      message: 'CSV Import Stub',
    };
  }

  @Patch(':id/verifikasi')
  @Roles('verifikator', 'admin')
  verifikasi(
    @Param('id') id: string,
    @Body() dto: VerifikasiDto,
    @Request() req: any,
  ) {
    return this.rumahTanggaService.verifikasi(id, dto, req.user?.id);
  }

  @Get()
  @Roles('admin', 'verifikator', 'petugas')
  findAll(
    @Request() req: any,
    @Query('wilayah_id') wilayah_id?: string,
    @Query('periode_id') periode_id?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rumahTanggaService.findAll(
      {
        wilayah_id,
        periode_id,
        status,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 10,
      },
      req.user,
    );
  }
}
