import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UsersService } from './users.service';
import { TambahWilayahDto } from './dto/tambah-wilayah.dto';
import { CreateUserDto, ResetPasswordDto, UpdateUserDto } from './dto/kelola-user.dto';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Daftar user beserta wilayah utama & wilayah akses tambahan (Admin)' })
  findAll() {
    return this.usersService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Buat user baru (Admin)' })
  create(@Body() dto: CreateUserDto, @Request() req: any) {
    return this.usersService.create(dto, req.user?.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Ubah nama, role, wilayah utama, atau status aktif user (Admin)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @Request() req: any) {
    return this.usersService.update(id, dto, req.user?.id);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Setel password baru untuk user; token lamanya dicabut (Admin)' })
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto, @Request() req: any) {
    return this.usersService.resetPassword(id, dto.password_baru, req.user?.id);
  }

  @Post(':id/wilayah')
  @ApiOperation({ summary: 'Beri user akses ke satu wilayah kerja tambahan (Admin)' })
  tambahWilayah(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TambahWilayahDto, @Request() req: any) {
    return this.usersService.tambahWilayah(id, dto.wilayah_id, req.user?.id);
  }

  @Delete(':id/wilayah/:wilayahId')
  @ApiOperation({ summary: 'Cabut akses tambahan user ke satu wilayah kerja (Admin)' })
  hapusWilayah(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('wilayahId', ParseUUIDPipe) wilayahId: string,
    @Request() req: any,
  ) {
    return this.usersService.hapusWilayah(id, wilayahId, req.user?.id);
  }
}
