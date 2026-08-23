import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LogAuditDto {
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: any;
  afterState?: any;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(data: LogAuditDto) {
    return this.prisma.auditLog.create({
      data: {
        actorId: data.actorId || null,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        beforeState: data.beforeState ?? undefined,
        afterState: data.afterState ?? undefined,
      },
    });
  }

  async findByEntity(entityType: string, entityId: string) {
    return this.prisma.auditLog.findMany({
      where: {
        entityType,
        entityId,
      },
      include: {
        actor: {
          select: {
            id: true,
            nama: true,
            username: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findByPeriode(periodeId: string) {
    return this.prisma.auditLog.findMany({
      where: {
        entityType: 'periode_program',
        entityId: periodeId,
      },
      include: {
        actor: {
          select: {
            id: true,
            nama: true,
            username: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findAll(page: number = 1, limit: number = 20) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Number(limit) || 20);
    const skip = (pageNum - 1) * limitNum;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        skip,
        take: limitNum,
        include: {
          actor: {
            select: {
              id: true,
              nama: true,
              username: true,
              role: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      }),
      this.prisma.auditLog.count(),
    ]);

    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }
}
