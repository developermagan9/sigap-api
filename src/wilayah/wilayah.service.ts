import { Injectable, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWilayahDto } from './dto/create-wilayah.dto';

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
   * Daftarkan satu desa/kelurahan sebagai wilayah kerja program.
   *
   * Yang dikirim klien hanya `kode` desa; keempat nama diambil dari
   * `wilayah_referensi` di sini. Sebelumnya endpoint ini menerima empat kolom
   * teks bebas, sehingga "Kecamatan Sleman" di bawah "Provinsi Bali" pun
   * tersimpan tanpa keberatan — dan salah ketik pada nama desa langsung menjadi
   * wilayah kerja baru yang mirip tapi berbeda dengan yang sudah ada.
   */
  async create(data: CreateWilayahDto) {
    const kode = data.kode.trim();

    // Lapis kedua setelah regex di CreateWilayahDto — service ini juga dipanggil
    // langsung dari seed/skrip, yang tidak melewati ValidationPipe.
    const segmen = kode.split('.');
    if (segmen.length !== 4) {
      throw new HttpException(
        {
          code: 'KODE_BUKAN_DESA',
          message: `Kode '${kode}' bukan kode desa/kelurahan. Wilayah kerja didaftarkan per desa, jadi kodenya harus berbentuk PP.KK.CC.DDDD (mis. 34.04.01.2001).`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const [p, k, c] = segmen;
    const jalurKode = [p, `${p}.${k}`, `${p}.${k}.${c}`, kode];
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

    const sudahAda = await this.prisma.wilayah.findUnique({ where: { kode } });
    if (sudahAda) {
      throw new HttpException(
        {
          code: 'WILAYAH_SUDAH_TERDAFTAR',
          message: `${sudahAda.desa}, ${sudahAda.kecamatan}, ${sudahAda.kabupaten} sudah terdaftar sebagai wilayah kerja.`,
        },
        HttpStatus.CONFLICT,
      );
    }

    return this.prisma.wilayah.create({
      data: {
        kode,
        provinsi: jalur.get(p)!,
        kabupaten: jalur.get(`${p}.${k}`)!,
        kecamatan: jalur.get(`${p}.${k}.${c}`)!,
        desa: jalur.get(kode)!,
      },
    });
  }
}
