import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class GantiPasswordDto {
  @ApiProperty()
  @IsString()
  password_lama: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password baru minimal 8 karakter' })
  @MaxLength(72, { message: 'Password baru maksimal 72 karakter' }) // batas input bcrypt
  password_baru: string;
}
