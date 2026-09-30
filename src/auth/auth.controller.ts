import { Body, Controller, HttpCode, HttpStatus, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { GantiPasswordDto } from './dto/ganti-password.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login dan dapatkan token autentikasi JWT' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Login berhasil, mengembalikan token akses JWT',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Email atau kata sandi tidak valid',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: 'Terlalu banyak percobaan gagal untuk username ini (LOGIN_TERKUNCI)',
  })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Cabut token yang sedang dipakai (logout)' })
  logout(@Request() req: any) {
    return this.authService.logout(req.user.id, req.user.jti, req.user.exp);
  }

  @Post('ganti-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Ganti password sendiri; semua token lama dicabut' })
  gantiPassword(@Request() req: any, @Body() dto: GantiPasswordDto) {
    return this.authService.gantiPassword(req.user.id, dto);
  }
}
