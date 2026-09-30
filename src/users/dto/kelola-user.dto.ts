import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'petugas.balecatur' })
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{3,50}$/, { message: 'Username 3–50 karakter: huruf, angka, titik, garis bawah, atau strip' })
  username: string;

  @ApiProperty({ example: 'Siti Aminah' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  nama: string;

  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password minimal 8 karakter' })
  @MaxLength(72)
  password: string;

  @ApiPropertyOptional({ description: 'Wilayah kerja utama (wajib untuk petugas & verifikator)' })
  @IsOptional()
  @IsUUID()
  wilayah_id?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  nama?: string;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ nullable: true, description: 'null = lepas wilayah utama' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  wilayah_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class ResetPasswordDto {
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password minimal 8 karakter' })
  @MaxLength(72)
  password_baru: string;
}
