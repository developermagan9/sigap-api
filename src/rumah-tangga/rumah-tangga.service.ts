import { Injectable, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashWithPepper, encrypt, normalizeName, jaroWinkler, deriveCustodialWallet } from '../common/crypto.util';
import { CreateRumahTanggaDto } from './dto/create-rumah-tangga.dto';
import { VerifikasiDto } from './dto/verifikasi.dto';

@Injectable()
export class RumahTanggaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateRumahTanggaDto, actorId?: string) {
    const nikKkHash = hashWithPepper(dto.nik_kepala_keluarga);
    const noKkHash = hashWithPepper(dto.no_kk);

    const existingNik = await this.prisma.rumahTangga.findFirst({
      where: { nikKkHash: nikKkHash },
    });
    if (existingNik) {
      throw new HttpException(
        { error: { code: 'DUPLICATE_NIK', message: 'NIK Kepala Keluarga already exists' } },
        HttpStatus.CONFLICT,
      );
    }

    const existingKk = await this.prisma.rumahTangga.findFirst({
      where: { noKkHash: noKkHash },
    });
    if (existingKk) {
      throw new HttpException(
        { error: { code: 'DUPLICATE_NO_KK', message: 'No KK already exists' } },
        HttpStatus.CONFLICT,
      );
    }

    const anggotaHashes = dto.anggota.map((a) => hashWithPepper(a.nik));
    const existingAnggota = await this.prisma.anggotaKeluarga.findFirst({
      where: { nikHash: { in: anggotaHashes } },
    });
    if (existingAnggota) {
      throw new HttpException(
        { error: { code: 'DUPLICATE_NIK_ANGGOTA', message: 'One or more Anggota NIK already exists' } },
        HttpStatus.CONFLICT,
      );
    }

    const kepala = dto.anggota.filter((a) => a.hubungan === 'kepala');
    if (kepala.length !== 1 || kepala[0].nik !== dto.nik_kepala_keluarga) {
      throw new HttpException(
        { error: { code: 'BAD_REQUEST', message: 'Exactly one anggota must be kepala with matching NIK' } },
        HttpStatus.BAD_REQUEST,
      );
    }

    const jumlahTanggungan = dto.anggota.filter((a) => a.is_tanggungan).length;

    const jumlahDisabilitasLansia = dto.anggota.filter((a) => {
      if (a.status_disabilitas) return true;
      const dob = new Date(a.tanggal_lahir);
      const ageDifMs = Date.now() - dob.getTime();
      const ageDate = new Date(ageDifMs); 
      return Math.abs(ageDate.getUTCFullYear() - 1970) >= 60;
    }).length;

    const nikEnc = encrypt(dto.nik_kepala_keluarga);
    const kkEnc = encrypt(dto.no_kk);
    const namaEnc = encrypt(dto.nama_kepala_keluarga);
    const alamatEnc = encrypt(dto.alamat_detail);

    const namaNorm = normalizeName(dto.nama_kepala_keluarga);
    const alamatNorm = normalizeName(dto.alamat_detail);

    let flaggedDuplicate = false;
    const allPii = await this.prisma.rumahTanggaPii.findMany();
    const queryStr = `${namaNorm} ${alamatNorm}`;
    for (const pii of allPii) {
      const targetStr = `${pii.namaNormalized} ${pii.alamatNormalized}`;
      const similarity = jaroWinkler(queryStr, targetStr);
      if (similarity > 0.85) {
        flaggedDuplicate = true;
        break;
      }
    }

    // Wallet dikumpulkan di sini (bukan di-derive palsu nanti saat build-merkle).
    // 'mandiri' butuh alamat asli dari DTO; 'custodial' tanpa alamat dapat placeholder
    // deterministik — perlu id baris ditentukan dulu supaya bisa jadi seed derivasinya.
    const rumahTanggaId = randomUUID();
    let walletAddress = dto.wallet_address ?? null;
    let jenisWallet = dto.jenis_wallet ?? null;
    if (jenisWallet === 'custodial' && !walletAddress) {
      walletAddress = deriveCustodialWallet(rumahTanggaId);
    } else if (walletAddress && !jenisWallet) {
      jenisWallet = 'mandiri';
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const rt = await tx.rumahTangga.create({
        data: {
          id: rumahTanggaId,
          nikKkHash: nikKkHash,
          noKkHash: noKkHash,
          wilayahId: dto.wilayah_id,
          pendapatanPerKapita: dto.pendapatan_per_kapita,
          skorKondisiRumah: dto.skor_kondisi_rumah,
          skorAksesPendidikan: dto.skor_akses_pendidikan,
          riwayatBansosSebelumnya: dto.riwayat_bansos_sebelumnya,
          jumlahTanggungan,
          jumlahDisabilitasLansia,
          flaggedDuplicate,
          statusVerifikasi: 'pending',
          periodeId: dto.periode_id,
          walletAddress: walletAddress ?? undefined,
          jenisWallet: (jenisWallet as any) ?? undefined,
          pii: {
            create: {
              nikKepalaKeluargaEnc: nikEnc,
              noKkEnc: kkEnc,
              namaKepalaKeluargaEnc: namaEnc,
              alamatDetailEnc: alamatEnc,
              namaNormalized: namaNorm,
              alamatNormalized: alamatNorm,
            },
          },
          anggota: {
            create: dto.anggota.map((a) => ({
              nikHash: hashWithPepper(a.nik),
              nikEnc: encrypt(a.nik),
              namaEnc: encrypt(a.nama),
              hubungan: a.hubungan as any,
              tanggalLahir: new Date(a.tanggal_lahir),
              statusDisabilitas: a.status_disabilitas,
              isTanggungan: a.is_tanggungan,
            })),
          },
        },
      });

      if (actorId) {
        await this.audit.log({
          action: 'CREATE_RUMAH_TANGGA',
          actorId,
          entityId: rt.id,
          entityType: 'rumah_tangga',
          afterState: rt,
        });
      }

      return rt;
    });

    return {
      id: result.id,
      statusVerifikasi: result.statusVerifikasi,
      flaggedDuplicate: result.flaggedDuplicate,
      jumlahTanggungan: result.jumlahTanggungan,
      jumlahDisabilitasLansia: result.jumlahDisabilitasLansia,
    };
  }

  async findAll(
    filters: { wilayah_id?: string; periode_id?: string; status?: string; page?: number; limit?: number },
    user?: { role?: string; wilayahId?: string | null },
  ) {
    const page = filters.page || 1;
    const limit = filters.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (user && user.role !== 'admin') {
      // petugas/verifikator can only ever see their own wilayah, regardless of
      // what wilayah_id was requested in the query string.
      where.wilayahId = user.wilayahId ?? '__no_wilayah__';
    } else if (filters.wilayah_id) {
      where.wilayahId = filters.wilayah_id;
    }
    if (filters.periode_id) {
      where.periodeId = filters.periode_id;
    }
    if (filters.status) {
      where.statusVerifikasi = filters.status;
    }

    const [data, total] = await Promise.all([
      this.prisma.rumahTangga.findMany({
        where,
        skip,
        take: limit,
        include: {
          wilayah: true,
        },
      }),
      this.prisma.rumahTangga.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async verifikasi(id: string, dto: VerifikasiDto, actorId: string) {
    const rt = await this.prisma.rumahTangga.findUnique({
      where: { id },
    });

    if (!rt) {
      throw new HttpException(
        { error: { code: 'NOT_FOUND', message: 'Rumah Tangga not found' } },
        HttpStatus.NOT_FOUND,
      );
    }

    const updated = await this.prisma.rumahTangga.update({
      where: { id },
      data: {
        statusVerifikasi: dto.status_verifikasi as any,
      },
    });

    await this.audit.log({
      action: 'VERIFIKASI_RUMAH_TANGGA',
      actorId,
      entityId: id,
      entityType: 'rumah_tangga',
      beforeState: rt,
      afterState: updated,
    });

    return updated;
  }
}
