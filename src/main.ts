import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { validateEnv } from './common/env.validation';

async function bootstrap() {
  // Dijalankan sebelum apa pun dilayani: berjalan dengan pepper/kunci/JWT secret
  // bawaan yang tertulis di source code jauh lebih berbahaya daripada gagal start.
  validateEnv();

  const app = await NestFactory.create(AppModule);

  // Global prefix
  app.setGlobalPrefix('v1', { exclude: ['health'] });

  // CORS. `CORS_ORIGIN` boleh berisi beberapa origin dipisah koma, mis.
  // "http://localhost:3000,http://43.133.144.108:3000" — supaya FE lokal dan FE
  // yang di-deploy di VPS sama-sama diizinkan tanpa ganti konfigurasi.
  app.enableCors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('SIGAP-Bansos API')
    .setDescription('Sistem Distribusi Bantuan Sosial Tepat Sasaran Berbasis Data Mining & Blockchain')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`🚀 SIGAP-API running on http://localhost:${port}`);
  console.log(`📖 Swagger docs at http://localhost:${port}/docs`);
}
bootstrap();
