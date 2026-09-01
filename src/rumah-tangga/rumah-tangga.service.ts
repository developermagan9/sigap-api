import { Injectable, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashWithPepper, encrypt, normalizeName, jaroWinkler, deriveCustodialWallet } from '../common/crypto.util';
import { CreateRumahTanggaDto } from './dto/create-rumah-tangga.dto';
import { VerifikasiDto } from './dto/verifikasi.dto';

/** Ambang Jaro-Winkler untuk menandai kemungkinan duplikat "lunak" (nama+alamat mirip). */
const AMBANG_MIRIP = 0.85;

/** Berapa kandidat teratas hasil prefilter trigram yang dicek penuh dengan Jaro-Winkler. */
const KANDIDAT_FUZZY_MAKS = 50;

/** Baris wilayah kerja yang dipakai importer CSV untuk mencocokkan kolom wilayah. */
export type BarisWilayah = { id: string; kode: string | null; desa: string; kecamatan: string; kabupaten: string };

/** Peta pencarian wilayah untuk importer CSV — lihat catatan di importCsv(). */
export type PetaWilayah = {
  byKode: Map<string, string>;
  byDesa: Map<string, BarisWilayah[]>;
};

/**
 * Tentukan `wilayah_id` satu baris CSV dari `wilayah_id` | `kode_wilayah` | `desa`.
 *
 * Nama desa dipakai TERAKHIR dan hanya kalau tidak ambigu. Menerima nama yang
 * cocok ke beberapa wilayah kerja berarti menebak — dan tebakan yang salah di
 * sini memindahkan satu rumah tangga ke wilayah lain, yang berarti petugas dan
 * verifikator yang salah pula yang memegang berkasnya (scoping wilayah memakai
 * kolom ini). Lebih baik satu baris gagal dengan pesan jelas.
 */
export function resolusiWilayah(baris: Record<string, string>, peta: PetaWilayah): string {
  const id = (baris['wilayah_id'] ?? '').trim();
  if (id) return id;

  const kode = (baris['kode_wilayah'] ?? '').trim();
  if (kode) {
    const cocok = peta.byKode.get(kode);
    if (cocok) return cocok;
    throw new HttpException(
      {
        error: {
          code: 'WILAYAH_TIDAK_DIKENAL',
          message: `Kode wilayah '${kode}' belum terdaftar sebagai wilayah kerja. Tambahkan dulu lewat menu Wilayah Kerja.`,
        },
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  const desa = (baris['desa'] ?? '').trim();
  const kandidat = desa ? (peta.byDesa.get(desa.toLowerCase()) ?? []) : [];

  if (kandidat.length === 1) return kandidat[0].id;

  if (kandidat.length > 1) {
    throw new HttpException(
      {
        error: {
          code: 'WILAYAH_AMBIGU',
          message:
            `Desa '${desa}' cocok dengan ${kandidat.length} wilayah kerja ` +
            `(${kandidat.map((w) => `${w.kode ?? 'tanpa kode'} — ${w.kecamatan}, ${w.kabupaten}`).join('; ')}). ` +
            `Pakai kolom kode_wilayah atau wilayah_id untuk menunjuk yang mana.`,
        },
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  throw new HttpException(
    {
      error: {
        code: 'WILAYAH_TIDAK_DIKENAL',
        message: `Kolom wilayah_id dan kode_wilayah kosong, dan desa '${desa}' tidak ada di data wilayah kerja`,
      },
    },
    HttpStatus.BAD_REQUEST,
  );
}

@Injectable()
export class RumahTanggaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Simpan satu rumah tangga (dedup + turunan + enkripsi PII + audit).
   *
   * Dipakai BERSAMA oleh submit tunggal `POST /rumah-tangga` dan import CSV
   * `POST /rumah-tangga/import` — jangan duplikasi logikanya di importCsv(),
   * dedup NIK/No.KK dan perhitungan `jumlah_tanggungan` harus persis sama di
   * kedua jalur (14-Task-Intern.md BE-3 poin 3).
   *
   * Melempar `HttpException` dengan `error.code` yang stabil
   * (DUPLICATE_NIK / DUPLICATE_NO_KK / DUPLICATE_NIK_ANGGOTA / BAD_REQUEST)
   * supaya importer bisa melaporkan alasan gagal per baris.
   */
  async create(dto: CreateRumahTanggaDto, actorId?: string) {
    const nikKkHash = hashWithPepper(dto.nik_kepala_keluarga);
    const noKkHash = hashWithPepper(dto.no_kk);

    // Dedup discope "per periode program" (03-Data-Model.md §1.1): satu KK yang
    // sama boleh terdaftar lagi di periode berikutnya, tapi tidak dua kali pada
    // periode yang sama. `periodeId: null` (data lepas) ikut aturan yang sama.
    const periodeId = dto.periode_id ?? null;

    const existingNik = await this.prisma.rumahTangga.findFirst({
      where: { nikKkHash, periodeId },
    });
    if (existingNik) {
      throw new HttpException(
        { error: { code: 'DUPLICATE_NIK', message: 'NIK Kepala Keluarga already exists in this period' } },
        HttpStatus.CONFLICT,
      );
    }

    const existingKk = await this.prisma.rumahTangga.findFirst({
      where: { noKkHash, periodeId },
    });
    if (existingKk) {
      throw new HttpException(
        { error: { code: 'DUPLICATE_NO_KK', message: 'No KK already exists in this period' } },
        HttpStatus.CONFLICT,
      );
    }

    const anggotaHashes = dto.anggota.map((a) => hashWithPepper(a.nik));
    const existingAnggota = await this.prisma.anggotaKeluarga.findFirst({
      where: { nikHash: { in: anggotaHashes }, rumahTangga: { periodeId } },
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

    const flaggedDuplicate = await this.cekMiripAdaYangSama(namaNorm, alamatNorm);

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

  /**
   * Tandai kemungkinan duplikat "lunak" (nama + alamat mirip walau NIK berbeda).
   *
   * Sebelumnya seluruh isi `rumah_tangga_pii` ditarik ke memori tiap insert lalu
   * dibandingkan satu per satu — O(n) per baris baru, tidak akan sampai ke target
   * "puluhan ribu baris" di 02-System-Architecture.md §5. Sekarang kandidat disaring
   * dulu di Postgres lewat operator trigram `%` (pakai index GIN pg_trgm di
   * schema.prisma), baru Jaro-Winkler dijalankan pada segelintir baris teratas —
   * ambang akhirnya tetap 0.85 seperti semula, jadi hasilnya tidak berubah untuk
   * data yang memang mirip.
   */
  private async cekMiripAdaYangSama(namaNorm: string, alamatNorm: string): Promise<boolean> {
    const kandidat = await this.prisma.$queryRaw<{ nama_normalized: string; alamat_normalized: string }[]>`
      SELECT nama_normalized, alamat_normalized
      FROM rumah_tangga_pii
      WHERE nama_normalized % ${namaNorm} OR alamat_normalized % ${alamatNorm}
      ORDER BY similarity(nama_normalized, ${namaNorm}) + similarity(alamat_normalized, ${alamatNorm}) DESC
      LIMIT ${KANDIDAT_FUZZY_MAKS}
    `;

    const queryStr = `${namaNorm} ${alamatNorm}`;
    return kandidat.some(
      (k) => jaroWinkler(queryStr, `${k.nama_normalized} ${k.alamat_normalized}`) > AMBANG_MIRIP,
    );
  }

  /**
   * Import massal dari CSV (`POST /rumah-tangga/import`).
   *
   * **Format**: satu baris = satu ANGGOTA KELUARGA, baris dikelompokkan lewat
   * kolom `no_kk`. Kolom rumah tangga cukup diisi pada baris `hubungan=kepala`;
   * baris anggota lain boleh mengosongkannya. Satu rumah tangga beranggota satu
   * orang = satu baris dengan `hubungan=kepala`.
   *
   * Kolom yang dibaca (header wajib ada, urutan bebas):
   *   no_kk, nik_kepala_keluarga, nama_kepala_keluarga, alamat_detail,
   *   wilayah_id | kode_wilayah | desa, pendapatan_per_kapita, skor_kondisi_rumah,
   *   skor_akses_pendidikan, riwayat_bansos_sebelumnya,
   *   wallet_address?, jenis_wallet?,
   *   nik?, nama?, hubungan, tanggal_lahir, status_disabilitas, is_tanggungan
   * (`nik`/`nama` boleh kosong di baris kepala — diambil dari kolom kepala keluarga.)
   *
   * **Satu baris gagal TIDAK menggagalkan seluruh file** (09-Pembagian-Tugas.md A1):
   * tiap kelompok diproses sendiri-sendiri dan hasilnya dilaporkan per baris.
   */
  async importCsv(buffer: Buffer, actorId?: string, periodeIdDefault?: string) {
    let records: Record<string, string>[];
    try {
      records = parseCsv(buffer, {
        columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch (e) {
      throw new HttpException(
        { error: { code: 'CSV_TIDAK_VALID', message: `File CSV tidak bisa dibaca: ${(e as Error).message}` } },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (records.length === 0) {
      throw new HttpException(
        { error: { code: 'CSV_KOSONG', message: 'File CSV tidak berisi baris data' } },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Peta pencarian wilayah untuk CSV. Tiga jalur, sengaja berbeda ketegasannya:
    //   `wilayah_id` (UUID)   -> pasti
    //   `kode_wilayah`        -> pasti (kode Kepmendagri, unik se-Indonesia)
    //   `desa` (nama)         -> hanya kalau namanya unik di antara wilayah kerja
    // Nama desa TIDAK unik di Indonesia: 27.544 desa memakai nama yang juga
    // dipakai desa lain, dan "Sidomulyo" saja ada 98. Peta lama `desa -> id`
    // menimpa diam-diam saat ada dua desa senama, sehingga rumah tangga bisa
    // masuk ke wilayah yang salah tanpa satu pun pesan galat. Sekarang nama yang
    // ambigu ditolak dan pesannya menyebutkan kode mana yang harus dipakai.
    const semuaWilayah = await this.prisma.wilayah.findMany({
      select: { id: true, kode: true, desa: true, kecamatan: true, kabupaten: true },
    });
    const wilayahByKode = new Map(
      semuaWilayah.filter((w) => w.kode).map((w) => [w.kode!, w.id]),
    );
    const wilayahByDesa = new Map<string, typeof semuaWilayah>();
    for (const w of semuaWilayah) {
      const kunci = w.desa.toLowerCase();
      const daftar = wilayahByDesa.get(kunci) ?? [];
      daftar.push(w);
      wilayahByDesa.set(kunci, daftar);
    }
    const petaWilayah: PetaWilayah = { byKode: wilayahByKode, byDesa: wilayahByDesa };

    // Kelompokkan baris per no_kk, pertahankan urutan kemunculan pertama.
    // `nomorBaris` = nomor baris di file (header = 1) supaya laporan error
    // menunjuk ke baris yang benar-benar dilihat petugas di spreadsheet.
    type Kelompok = { noKk: string; baris: number[]; rows: Record<string, string>[] };
    const kelompok = new Map<string, Kelompok>();
    const tanpaNoKk: number[] = [];

    records.forEach((row, i) => {
      const nomorBaris = i + 2;
      const noKk = (row['no_kk'] ?? '').trim();
      if (!noKk) {
        tanpaNoKk.push(nomorBaris);
        return;
      }
      const k = kelompok.get(noKk) ?? { noKk, baris: [], rows: [] };
      k.baris.push(nomorBaris);
      k.rows.push(row);
      kelompok.set(noKk, k);
    });

    const hasil: {
      baris: number[];
      no_kk: string | null;
      status: 'success' | 'error';
      code?: string;
      message?: string;
      id?: string;
      flagged_duplicate?: boolean;
    }[] = tanpaNoKk.map((b) => ({
      baris: [b],
      no_kk: null,
      status: 'error' as const,
      code: 'NO_KK_KOSONG',
      message: 'Kolom no_kk wajib diisi — baris dilewati',
    }));

    for (const k of kelompok.values()) {
      try {
        const dto = await this.bangunDtoDariCsv(k.rows, petaWilayah, periodeIdDefault);
        const dibuat = await this.create(dto, actorId);
        hasil.push({
          baris: k.baris,
          no_kk: k.noKk,
          status: 'success',
          id: dibuat.id,
          flagged_duplicate: dibuat.flaggedDuplicate,
        });
      } catch (e) {
        const { code, message } = ekstrakError(e);
        hasil.push({ baris: k.baris, no_kk: k.noKk, status: 'error', code, message });
      }
    }

    hasil.sort((a, b) => a.baris[0] - b.baris[0]);
    const sukses = hasil.filter((h) => h.status === 'success').length;

    if (actorId) {
      await this.audit.log({
        action: 'IMPORT_CSV_RUMAH_TANGGA',
        actorId,
        entityId: periodeIdDefault ?? randomUUID(),
        entityType: 'rumah_tangga',
        afterState: { total_baris: records.length, sukses, gagal: hasil.length - sukses },
      });
    }

    return {
      total_baris: records.length,
      total_rumah_tangga: kelompok.size,
      sukses,
      gagal: hasil.length - sukses,
      hasil,
    };
  }

  /** Susun `CreateRumahTanggaDto` dari sekelompok baris CSV ber-`no_kk` sama, lalu validasi pakai aturan DTO yang sama dengan submit tunggal. */
  private async bangunDtoDariCsv(
    rows: Record<string, string>[],
    peta: PetaWilayah,
    periodeIdDefault?: string,
  ): Promise<CreateRumahTanggaDto> {
    // Baris kepala jadi sumber kolom rumah tangga; kalau tidak ada, pakai baris pertama.
    const barisKepala = rows.find((r) => (r['hubungan'] ?? '').trim().toLowerCase() === 'kepala') ?? rows[0];

    const wilayahId = resolusiWilayah(barisKepala, peta);

    const nikKepala = (barisKepala['nik_kepala_keluarga'] ?? '').trim();

    const anggota = rows.map((r) => {
      const hubungan = (r['hubungan'] ?? '').trim().toLowerCase();
      return {
        nik: (r['nik'] ?? '').trim() || (hubungan === 'kepala' ? nikKepala : ''),
        nama: (r['nama'] ?? '').trim() || (hubungan === 'kepala' ? (barisKepala['nama_kepala_keluarga'] ?? '').trim() : ''),
        hubungan,
        tanggal_lahir: (r['tanggal_lahir'] ?? '').trim(),
        status_disabilitas: keBoolean(r['status_disabilitas']),
        is_tanggungan: keBoolean(r['is_tanggungan']),
      };
    });

    const plain: Record<string, unknown> = {
      nik_kepala_keluarga: nikKepala,
      no_kk: (barisKepala['no_kk'] ?? '').trim(),
      nama_kepala_keluarga: (barisKepala['nama_kepala_keluarga'] ?? '').trim(),
      alamat_detail: (barisKepala['alamat_detail'] ?? '').trim(),
      wilayah_id: wilayahId,
      pendapatan_per_kapita: keAngka(barisKepala['pendapatan_per_kapita']),
      skor_kondisi_rumah: keAngka(barisKepala['skor_kondisi_rumah']),
      skor_akses_pendidikan: keAngka(barisKepala['skor_akses_pendidikan']),
      riwayat_bansos_sebelumnya: keBoolean(barisKepala['riwayat_bansos_sebelumnya']),
      anggota,
    };

    const periodeId = (barisKepala['periode_id'] ?? '').trim() || periodeIdDefault;
    if (periodeId) plain.periode_id = periodeId;
    const wallet = (barisKepala['wallet_address'] ?? '').trim();
    if (wallet) plain.wallet_address = wallet;
    const jenisWallet = (barisKepala['jenis_wallet'] ?? '').trim();
    if (jenisWallet) plain.jenis_wallet = jenisWallet;

    const dto = plainToInstance(CreateRumahTanggaDto, plain);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length > 0) {
      const detail = errors
        .map((e) => Object.values(e.constraints ?? {}).join(', ') || `${e.property} tidak valid`)
        .join('; ');
      throw new HttpException(
        { error: { code: 'VALIDASI_GAGAL', message: detail } },
        HttpStatus.BAD_REQUEST,
      );
    }

    return dto;
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

  async verifikasi(
    id: string,
    dto: VerifikasiDto,
    actorId: string,
    user?: { role?: string; wilayahId?: string | null },
  ) {
    const rt = await this.prisma.rumahTangga.findUnique({
      where: { id },
    });

    if (!rt) {
      throw new HttpException(
        { error: { code: 'NOT_FOUND', message: 'Rumah Tangga not found' } },
        HttpStatus.NOT_FOUND,
      );
    }

    // Scoping wilayah untuk aksi TULIS. `findAll()` sudah memaksa wilayah user
    // non-admin, tapi endpoint ini tidak — jadi verifikator wilayah A tetap bisa
    // meng-approve rumah tangga wilayah B kalau id-nya diketahui (id muncul di
    // respons API lain, jadi bukan rahasia). Membatasi baca tanpa membatasi tulis
    // tidak menutup apa pun.
    if (user && user.role !== 'admin' && rt.wilayahId !== user.wilayahId) {
      throw new HttpException(
        {
          error: {
            code: 'AKSES_DITOLAK',
            message: 'Rumah tangga ini berada di luar wilayah kerja Anda',
          },
        },
        HttpStatus.FORBIDDEN,
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
      beforeState: { statusVerifikasi: rt.statusVerifikasi },
      // `catatan` dari verifikator ikut dicatat di sini. Sebelumnya field ini
      // diterima DTO, diisi lewat UI (kolom "alasan" di Antrean), lalu dibuang
      // begitu saja — alasan di balik tiap keputusan hilang, padahal justru itu
      // yang membuat jejak audit berguna saat keputusan dipertanyakan.
      afterState: {
        statusVerifikasi: updated.statusVerifikasi,
        catatan: dto.catatan ?? null,
      },
    });

    return updated;
  }
}

/** CSV selalu string — terima "true/1/ya/y" (case-insensitive) sebagai true. */
function keBoolean(v: string | undefined): boolean {
  const t = (v ?? '').trim().toLowerCase();
  return t === 'true' || t === '1' || t === 'ya' || t === 'y';
}

/** Angka dari CSV, toleran terhadap pemisah ribuan titik/koma yang lazim di ekspor spreadsheet Indonesia. */
function keAngka(v: string | undefined): number {
  const t = (v ?? '').trim().replace(/[.\s]/g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Ambil `code`/`message` dari HttpException bentuk apa pun supaya laporan per baris konsisten. */
function ekstrakError(e: unknown): { code: string; message: string } {
  if (e instanceof HttpException) {
    const resp = e.getResponse() as any;
    const inner = resp?.error ?? resp;
    return {
      code: inner?.code ?? 'GAGAL',
      message: Array.isArray(inner?.message) ? inner.message.join('; ') : (inner?.message ?? e.message),
    };
  }
  return { code: 'GAGAL', message: (e as Error)?.message ?? 'Kesalahan tidak dikenal' };
}
