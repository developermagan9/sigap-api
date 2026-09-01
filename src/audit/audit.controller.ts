import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditService } from './audit.service';

@ApiTags('Audit Log')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('audit-log')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  // Hanya admin (dan auditor, peran read-only yang memang ada di enum UserRole)
  // yang boleh membaca jejak audit — isinya memuat before/after state entitas
  // yang bisa mengandung data rumah tangga.
  @Get()
  @Roles('admin', 'auditor')
  @ApiOperation({ summary: 'Daftar audit log (paginated, terbaru dulu)' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiResponse({ status: 200, description: 'Daftar audit log berhasil diambil' })
  @ApiResponse({ status: 403, description: 'Akses ditolak (bukan admin/auditor)' })
  findAll(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.auditService.findAll(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }
}
