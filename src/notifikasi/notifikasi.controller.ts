import { Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { NotifikasiService } from './notifikasi.service';

function halaman(page?: string, limit?: string) {
  const p = Math.max(1, parseInt(page ?? '1', 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20));
  return [p, l] as const;
}

@ApiTags('Notifikasi')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('notifikasi')
export class NotifikasiController {
  constructor(private readonly notifikasi: NotifikasiService) {}

  @Get()
  @ApiOperation({ summary: 'Notifikasi in-app milik user yang login' })
  @ApiQuery({ name: 'belum_dibaca', required: false, example: 'true' })
  milikSaya(@Request() req: any, @Query('belum_dibaca') belumDibaca?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.notifikasi.milikSaya(req.user.id, belumDibaca === 'true', ...halaman(page, limit));
  }

  @Get('outbox-sms')
  @Roles('admin')
  @ApiOperation({ summary: 'Outbox SMS mock ke warga (Admin) — tidak benar-benar dikirim' })
  outboxSms(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.notifikasi.outboxSms(...halaman(page, limit));
  }

  @Patch(':id/dibaca')
  @ApiOperation({ summary: 'Tandai satu notifikasi sudah dibaca' })
  tandaiDibaca(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.notifikasi.tandaiDibaca(id, req.user.id);
  }

  @Post('dibaca-semua')
  @ApiOperation({ summary: 'Tandai semua notifikasi sudah dibaca' })
  tandaiSemuaDibaca(@Request() req: any) {
    return this.notifikasi.tandaiSemuaDibaca(req.user.id);
  }
}
