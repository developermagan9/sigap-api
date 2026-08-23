import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorResponse: { code: string; message: string; details?: unknown } = {
      code: 'INTERNAL_ERROR',
      message: 'Terjadi kesalahan internal server',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        // If already in our error format
        if (resp.error && typeof resp.error === 'object') {
          errorResponse = resp.error as typeof errorResponse;
        } else {
          errorResponse = {
            code: (resp.code as string) || this.statusToCode(status),
            message: (resp.message as string) || exception.message,
            details: resp.details,
          };
        }
      } else {
        errorResponse = {
          code: this.statusToCode(status),
          message: String(exceptionResponse),
        };
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      errorResponse.message = exception.message;
    }

    response.status(status).json({ error: errorResponse });
  }

  private statusToCode(status: number): string {
    switch (status) {
      case 400: return 'VALIDASI_GAGAL';
      case 401: return 'TIDAK_TERAUTENTIKASI';
      case 403: return 'AKSES_DITOLAK';
      case 404: return 'TIDAK_DITEMUKAN';
      case 409: return 'KONFLIK_DATA';
      case 422: return 'TRANSISI_TIDAK_VALID';
      default: return 'INTERNAL_ERROR';
    }
  }
}
