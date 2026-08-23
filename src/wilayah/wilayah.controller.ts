import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { WilayahService } from './wilayah.service';
import { CreateWilayahDto } from './dto/create-wilayah.dto';

@ApiTags('Wilayah')
@Controller('wilayah')
export class WilayahController {
  constructor(private readonly wilayahService: WilayahService) {}

  @Get()
  @ApiOperation({ summary: 'Dapatkan semua data wilayah' })
  @ApiResponse({ status: 200, description: 'Daftar wilayah berhasil didapatkan' })
  async findAll() {
    return this.wilayahService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Dapatkan detail wilayah berdasarkan ID' })
  @ApiResponse({ status: 200, description: 'Detail wilayah ditemukan' })
  @ApiResponse({ status: 404, description: 'Wilayah tidak ditemukan' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.wilayahService.findOne(id);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.admin)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Tambah wilayah baru (Khusus Admin)' })
  @ApiResponse({ status: 201, description: 'Wilayah berhasil dibuat' })
  @ApiResponse({ status: 401, description: 'Tidak terautentikasi' })
  @ApiResponse({ status: 403, description: 'Akses ditolak' })
  async create(@Body() createWilayahDto: CreateWilayahDto) {
    return this.wilayahService.create(createWilayahDto);
  }
}
