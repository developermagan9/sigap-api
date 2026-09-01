import { Controller, Get, Param, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { WilayahService } from './wilayah.service';
import { ReferensiQueryDto } from './dto/cari-wilayah.dto';

@ApiTags('Wilayah')
@Controller('wilayah')
export class WilayahController {
  constructor(private readonly wilayahService: WilayahService) {}

  @Get()
  @ApiOperation({ summary: 'Dapatkan semua wilayah kerja program' })
  @ApiResponse({ status: 200, description: 'Daftar wilayah berhasil didapatkan' })
  async findAll() {
    return this.wilayahService.findAll();
  }

  // CATATAN URUTAN: dua rute `referensi` HARUS dideklarasikan sebelum `:id`.
  // Nest mencocokkan rute sesuai urutan deklarasi, dan `:id` memakai
  // ParseUUIDPipe — kalau ia lebih dulu, `/wilayah/referensi` akan ditangkap
  // olehnya dan ditolak 400 "bukan UUID" alih-alih sampai ke handler ini.
  @Get('referensi/cari')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.admin, UserRole.petugas)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cari desa/kelurahan lintas provinsi (Admin & Petugas)',
    description:
      'Jalan pintas untuk pengguna yang tahu nama desanya tapi belum tentu kabupatennya. ' +
      'Hasil selalu memuat jalur lengkap karena nama desa tidak unik di Indonesia.',
  })
  @ApiQuery({ name: 'q', required: true, example: 'balecatur', description: 'Minimal 3 karakter' })
  async cari(@Query('q') q: string) {
    return this.wilayahService.cariDesa(q);
  }

  @Get('referensi')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.admin, UserRole.petugas)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Referensi wilayah administratif Indonesia, satu tingkat (Admin & Petugas)',
    description:
      'Kepmendagri No. 300.2.2-2138 Tahun 2025: 38 provinsi, 514 kabupaten/kota, ' +
      '7.285 kecamatan, 83.762 desa/kelurahan. Dipakai dropdown alamat bertingkat ' +
      'di form pendataan KK — karena itu petugas ikut diberi akses, bukan admin saja.',
  })
  @ApiResponse({ status: 200, description: 'Daftar anak dari kode induk' })
  @ApiResponse({ status: 404, description: 'Kode induk tidak ada di referensi' })
  async referensi(@Query() query: ReferensiQueryDto) {
    return this.wilayahService.referensi(query.induk);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Dapatkan detail wilayah kerja berdasarkan ID' })
  @ApiResponse({ status: 200, description: 'Detail wilayah ditemukan' })
  @ApiResponse({ status: 404, description: 'Wilayah tidak ditemukan' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.wilayahService.findOne(id);
  }
}
