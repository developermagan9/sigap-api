import { Injectable, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Batas hasil pencarian desa — 83.762 desa, pengguna tidak menggulir ribuan baris. */
const MAKS_HASIL_CARI = 25;

/** Level administratif di `wilayah_referensi`. */
const LEVEL = { provinsi: 1, kabupaten: 2, kecamatan: 3, desa: 4 } as const;

@Injectable()
export class WilayahService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.wilayah.findMany({
      orderBy: [
        { provinsi: 'asc' },
        { kabupaten: 'asc' },
        { kecamatan: 'asc' },
        { desa: 'asc' },
      ],
    });
  }

  async findOne(id: string) {
    const wilayah = await this.prisma.wilayah.findUnique({
      where: { id },
    });

    if (!wilayah) {
      throw new NotFoundException({
        code: 'TIDAK_DITEMUKAN',
        message: `Wilayah dengan ID '${id}' tidak ditemukan`,
      });
    }

    return wilayah;
  }

  /**
   * Satu tingkat referensi wilayah: anak langsung dari `induk`.
   *
   * Tanpa `induk` -> 38 provinsi. `induk='34'` -> 5 kabupaten/kota DIY,
   * `induk='34.04'` -> 17 kecamatan Sleman, dan seterusnya. Selalu satu tingkat
   * saja supaya dropdown bertingkat tidak pernah menarik 83.762 desa sekaligus.
   */
  async referensi(induk?: string) {
    const kode = induk?.trim();

    if (kode) {
      // Induk harus benar-benar ada. Tanpa cek ini, kode salah ketik mengembalikan
      // daftar kosong yang tidak bisa dibedakan dari "wilayah ini memang belum
      // punya anak" — dan cascade di UI berhenti tanpa alasan yang terlihat.
      const ada = await this.prisma.wilayahReferensi.findUnique({ where: { kode } });
      if (!ada) {
        throw new NotFoundException({
          code: 'TIDAK_DITEMUKAN',
          message: `Kode wilayah '${kode}' tidak ada di referensi Kepmendagri`,
        });
      }
    }

    const anak = await this.prisma.wilayahReferensi.findMany({
      where: { indukKode: kode ?? null },
      orderBy: { nama: 'asc' },
      select: { kode: true, nama: true, level: true },
    });

    return { induk: kode ?? null, jumlah: anak.length, data: anak };
  }

  /**
   * Cari desa/kelurahan lintas provinsi berikut jalur lengkapnya.
   *
   * Empat dropdown bertingkat menuntut pengguna tahu kabupaten dan kecamatannya
   * lebih dulu; petugas yang cuma tahu nama desa butuh jalan pintas. Jalur
   * lengkap ikut dikembalikan karena nama desa TIDAK unik — ada 98 "Sidomulyo"
   * di Indonesia, dan tanpa kabupatennya hasil pencarian tidak bisa dipilih
   * dengan yakin.
   */
  async cariDesa(q: string) {
    const kueri = q?.trim() ?? '';
    if (kueri.length < 3) {
      throw new HttpException(
        {
          code: 'PARAMETER_TIDAK_VALID',
          message: 'Kata kunci pencarian minimal 3 karakter',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const desa = await this.prisma.wilayahReferensi.findMany({
      where: { level: LEVEL.desa, nama: { contains: kueri, mode: 'insensitive' } },
      orderBy: { nama: 'asc' },
      take: MAKS_HASIL_CARI,
      select: { kode: true, nama: true },
    });

    if (desa.length === 0) return { jumlah: 0, data: [] };

    // Jalur induk diambil sekali untuk semua hasil (satu query, bukan 3 per baris).
    const kodeInduk = new Set<string>();
    for (const d of desa) {
      const [p, k, c] = d.kode.split('.');
      kodeInduk.add(p);
      kodeInduk.add(`${p}.${k}`);
      kodeInduk.add(`${p}.${k}.${c}`);
    }
    const induk = new Map(
      (
        await this.prisma.wilayahReferensi.findMany({
          where: { kode: { in: [...kodeInduk] } },
          select: { kode: true, nama: true },
        })
      ).map((w) => [w.kode, w.nama]),
    );

    return {
      jumlah: desa.length,
      // `MAKS_HASIL_CARI` bukan total yang cocok — dinyatakan supaya UI bisa
      // memberi tahu pengguna bahwa daftarnya dipotong, bukan sudah lengkap.
      dipotong: desa.length === MAKS_HASIL_CARI,
      data: desa.map((d) => {
        const [p, k, c] = d.kode.split('.');
        return {
          kode: d.kode,
          desa: d.nama,
          kecamatan: induk.get(`${p}.${k}.${c}`) ?? '',
          kabupaten: induk.get(`${p}.${k}`) ?? '',
          provinsi: induk.get(p) ?? '',
        };
      }),
    };
  }

  /**
   * Pastikan satu desa/kelurahan punya baris `wilayah`, lalu kembalikan barisnya.
   *
   * Wilayah kerja tidak lagi didaftarkan lebih dulu lewat menu admin tersendiri:
   * petugas memilih provinsi → kabupaten/kota → kecamatan → desa langsung di
   * form pendataan, dan barisnya lahir di sini pada penyimpanan pertama untuk
   * desa tersebut. Yang dikirim klien tetap hanya `kode`; keempat nama diambil
   * dari `wilayah_referensi` supaya kombinasi mustahil (mis. kecamatan Sleman
   * di bawah provinsi Bali) dan salah ketik nama desa tidak bisa tersimpan.
   *
   * Idempoten — beda dengan endpoint `POST /wilayah` yang digantikannya, desa
   * yang sudah terdaftar mengembalikan baris lamanya, bukan 409. Pendataan KK
   * kedua di desa yang sama harus berhasil, bukan ditolak.
   */
  async pastikanWilayahKerja(kode: string) {
    const kodeDesa = kode.trim();

    const sudahAda = await this.prisma.wilayah.findUnique({ where: { kode: kodeDesa } });
    if (sudahAda) return sudahAda;

    // Lapis kedua setelah regex di CreateRumahTanggaDto — method ini juga
    // dipanggil importer CSV dan seed/skrip yang tidak melewati ValidationPipe.
    const segmen = kodeDesa.split('.');
    if (segmen.length !== 4) {
      throw new HttpException(
        {
          code: 'KODE_BUKAN_DESA',
          message: `Kode '${kodeDesa}' bukan kode desa/kelurahan. Alamat rumah tangga dicatat per desa, jadi kodenya harus berbentuk PP.KK.CC.DDDD (mis. 34.04.01.2001).`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const [p, k, c] = segmen;
    const jalurKode = [p, `${p}.${k}`, `${p}.${k}.${c}`, kodeDesa];
    const jalur = new Map(
      (
        await this.prisma.wilayahReferensi.findMany({
          where: { kode: { in: jalurKode } },
          select: { kode: true, nama: true },
        })
      ).map((w) => [w.kode, w.nama]),
    );

    const hilang = jalurKode.filter((kd) => !jalur.has(kd));
    if (hilang.length > 0) {
      throw new NotFoundException({
        code: 'TIDAK_DITEMUKAN',
        message:
          `Kode wilayah tidak lengkap di referensi (belum ada: ${hilang.join(', ')}). ` +
          `Pastikan tabel referensi sudah dimuat dengan \`npm run wilayah:seed\`.`,
      });
    }

    try {
      return await this.prisma.wilayah.create({
        data: {
          kode: kodeDesa,
          provinsi: jalur.get(p)!,
          kabupaten: jalur.get(`${p}.${k}`)!,
          kecamatan: jalur.get(`${p}.${k}.${c}`)!,
          desa: jalur.get(kodeDesa)!,
        },
      });
    } catch (e) {
      // Dua petugas boleh mendata desa yang sama pada saat yang sama; yang kalah
      // balapan memakai baris yang baru saja dibuat lawannya, bukan gagal.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const lomba = await this.prisma.wilayah.findUnique({ where: { kode: kodeDesa } });
        if (lomba) return lomba;
      }
      throw e;
    }
  }
}
