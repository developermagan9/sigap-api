import { PrismaClient } from '@prisma/client';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import * as path from 'path';

/**
 * Muat `prisma/data/wilayah-indonesia.csv` ke tabel `wilayah_referensi`.
 *
 * Dipisah dari `seed.ts` karena isinya beda jenis: `seed.ts` membuat data DEMO
 * yang boleh dihapus kapan saja, sedangkan ini referensi resmi yang harus ada di
 * lingkungan mana pun — termasuk produksi, di mana `seed.ts` justru tidak boleh
 * dijalankan. Jalankan dengan `npm run wilayah:seed`.
 *
 * Idempoten: baris yang kodenya sudah ada diperbarui namanya, yang tidak lagi
 * ada di CSV dihapus. Aman dijalankan ulang setelah `npm run wilayah:refresh`.
 */

const prisma = new PrismaClient();

/**
 * Cari `wilayah-indonesia.csv`, baik saat dijalankan lewat ts-node dari
 * `prisma/` maupun sebagai JS terkompilasi dari `dist/prisma/`.
 *
 * `nest build` hanya menyalin .ts -> .js, bukan aset .csv, jadi
 * `dist/prisma/data/` tidak berisi CSV-nya. Menambah konfigurasi `assets` di
 * nest-cli.json bisa saja, tapi menyelesaikannya di sini membuat skrip berdiri
 * sendiri: tidak ada langkah build yang bisa lupa disetel.
 */
function berkasCsv(): string {
  const kandidat = [
    path.join(__dirname, 'data', 'wilayah-indonesia.csv'), // ts-node: prisma/data/
    path.join(__dirname, '..', '..', 'prisma', 'data', 'wilayah-indonesia.csv'), // dist/prisma/ -> prisma/data/
  ];
  const ada = kandidat.find((k) => existsSync(k));
  if (!ada) {
    throw new Error(
      `wilayah-indonesia.csv tidak ditemukan. Dicari di:\n` +
        kandidat.map((k) => `  ${k}`).join('\n') +
        `\nJalankan \`npm run wilayah:refresh\` untuk mengunduhnya.`,
    );
  }
  return ada;
}

/** Kode induk = kode dikurangi satu segmen terakhir. `34.04.01` -> `34.04`. */
function indukDari(kode: string): string | null {
  const i = kode.lastIndexOf('.');
  return i === -1 ? null : kode.substring(0, i);
}

/** Satu baris CSV `kode,nama`. Dipisah pada koma PERTAMA saja supaya nama yang
 *  memuat koma tidak terpotong kalau bentuk sumbernya berubah. */
function pisah(baris: string): { kode: string; nama: string } | null {
  const i = baris.indexOf(',');
  if (i === -1) return null;
  const kode = baris.substring(0, i).trim();
  const nama = baris.substring(i + 1).trim();
  if (!kode || !nama) return null;
  return { kode, nama };
}

async function main() {
  const berkas = berkasCsv();
  const baris = createInterface({
    input: createReadStream(berkas, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const data: { kode: string; nama: string; level: number; indukKode: string | null }[] = [];
  let pertama = true;

  for await (const b of baris) {
    if (pertama) {
      pertama = false;
      if (b.startsWith('kode,')) continue; // lewati header
    }
    if (!b.trim()) continue;

    const row = pisah(b);
    if (!row) throw new Error(`Baris CSV tidak bisa dibaca: ${JSON.stringify(b)}`);

    const level = row.kode.split('.').length;
    if (level < 1 || level > 4) {
      throw new Error(`Kode '${row.kode}' punya ${level} segmen — hanya 1..4 yang valid`);
    }
    data.push({ ...row, level, indukKode: indukDari(row.kode) });
  }

  if (data.length === 0) {
    throw new Error(`${berkas} kosong — tidak ada yang bisa dimuat`);
  }

  // Integritas hierarki dicek SEBELUM menyentuh database: kalau ada anak yang
  // induknya tidak ada di CSV, cascade di UI buntu di tengah dan gejalanya
  // ("kecamatan kosong padahal kabupatennya jelas ada") jauh dari penyebabnya.
  const semuaKode = new Set(data.map((d) => d.kode));
  const yatim = data.filter((d) => d.indukKode !== null && !semuaKode.has(d.indukKode));
  if (yatim.length > 0) {
    throw new Error(
      `${yatim.length} kode tidak punya induk di CSV, mis. ${yatim
        .slice(0, 5)
        .map((d) => `${d.kode} (induk ${d.indukKode})`)
        .join(', ')}`,
    );
  }

  const perLevel = [1, 2, 3, 4].map((l) => data.filter((d) => d.level === l).length);
  console.log(
    `CSV terbaca: ${data.length} wilayah — ${perLevel[0]} provinsi, ${perLevel[1]} kabupaten/kota, ` +
      `${perLevel[2]} kecamatan, ${perLevel[3]} desa/kelurahan`,
  );

  // Hapus yang sudah tidak ada di sumber (pemekaran/penggabungan daerah) lebih
  // dulu, supaya tabel tidak sempat memuat kode lama dan baru sekaligus.
  const sebelum = await prisma.wilayahReferensi.findMany({ select: { kode: true, nama: true } });
  const usang = sebelum.map((w) => w.kode).filter((k) => !semuaKode.has(k));
  if (usang.length > 0) {
    await prisma.wilayahReferensi.deleteMany({ where: { kode: { in: usang } } });
    console.log(`  ${usang.length} kode usang dihapus`);
  }

  // createMany + skipDuplicates lalu update yang namanya berubah: jauh lebih
  // cepat daripada 91.599 upsert satu per satu (detik vs menit).
  const UKURAN_BATCH = 5000;
  for (let i = 0; i < data.length; i += UKURAN_BATCH) {
    await prisma.wilayahReferensi.createMany({
      data: data.slice(i, i + UKURAN_BATCH),
      skipDuplicates: true,
    });
  }

  const namaLama = new Map(sebelum.map((w) => [w.kode, w.nama]));
  let diperbarui = 0;
  for (const d of data) {
    const lama = namaLama.get(d.kode);
    if (lama !== undefined && lama !== d.nama) {
      await prisma.wilayahReferensi.update({ where: { kode: d.kode }, data: { nama: d.nama } });
      diperbarui++;
    }
  }

  const total = await prisma.wilayahReferensi.count();
  console.log(`Selesai: ${total} baris di wilayah_referensi (${diperbarui} nama diperbarui).`);

  // Wilayah kerja yang kodenya tidak lagi ada di referensi DILAPORKAN, tidak
  // dihapus — `rumah_tangga` dan `users` masih menunjuk ke sana, dan menghapus
  // wilayah kerja berarti membuang jejak siapa mendata di mana.
  const kerja = await prisma.wilayah.findMany({
    where: { kode: { not: null } },
    select: { kode: true, desa: true, kabupaten: true },
  });
  const yatimKerja = kerja.filter((w) => !semuaKode.has(w.kode!));
  if (yatimKerja.length > 0) {
    console.warn(
      `\n⚠️  ${yatimKerja.length} wilayah kerja memakai kode yang tidak ada lagi di referensi ` +
        `(kemungkinan pemekaran/penggabungan daerah):\n` +
        yatimKerja.map((w) => `    ${w.kode}  ${w.desa}, ${w.kabupaten}`).join('\n') +
        `\n    Dibiarkan apa adanya — rumah tangga & petugas masih terhubung ke sana.\n`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
