import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // `registerAsync` (bukan `register`) supaya JWT_SECRET dibaca saat modul
    // di-instantiate — yaitu setelah ConfigModule memuat .env — bukan saat
    // dekorator @Module dievaluasi, yang terjadi lebih dulu. Dengan `register`,
    // token bisa DITANDATANGANI memakai secret cadangan sementara JwtStrategy
    // (yang membaca env di constructor, jadi setelah .env termuat)
    // MEMVERIFIKASI dengan secret asli — semua request terautentikasi gagal 401
    // tanpa penyebab yang jelas.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') || 'sigap-secret',
        // `expiresIn` bertipe template literal ketat di @nestjs/jwt v11; nilai
        // dari env selalu string biasa, jadi di-cast di satu titik ini saja.
        signOptions: { expiresIn: (config.get<string>('JWT_EXPIRES_IN') || '1h') as any },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
