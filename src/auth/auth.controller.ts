import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

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
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
}
