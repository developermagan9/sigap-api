import {
  Controller, Post, Body, Get, Patch, Param, Query, UseGuards, Request,
  UploadedFile, UseInterceptors, HttpException, HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RumahTanggaService } from './rumah-tangga.service';
import { CreateRumahTanggaDto } from './dto/create-rumah-tangga.dto';
import { VerifikasiDto } from './dto/verifikasi.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

/** Batas ukuran unggahan CSV — cukup untuk puluhan ribu baris, tetap menahan file raksasa. */
const MAKS_UKURAN_CSV = 5 * 1024 * 1024;

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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAKS_UKURAN_CSV } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Import massal rumah tangga dari CSV',
    description:
      'Satu baris = satu anggota keluarga, dikelompokkan lewat kolom no_kk. ' +
      'Baris yang gagal dilaporkan per baris tanpa menggagalkan sisa file.',
  })
  @ApiQuery({ name: 'periode_id', required: false, description: 'Periode default bila CSV tidak punya kolom periode_id' })
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  importCsv(
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
    @Query('periode_id') periodeId?: string,
  ) {
    if (!file) {
      throw new HttpException(
        { error: { code: 'FILE_TIDAK_ADA', message: 'Sertakan file CSV pada field `file` (multipart/form-data)' } },
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.rumahTanggaService.importCsv(file.buffer, req.user?.id, periodeId);
  }

  @Patch(':id/verifikasi')
  @Roles('verifikator', 'admin')
  verifikasi(
    @Param('id') id: string,
    @Body() dto: VerifikasiDto,
    @Request() req: any,
  ) {
    return this.rumahTanggaService.verifikasi(id, dto, req.user?.id, req.user);
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
