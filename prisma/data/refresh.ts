import { writeFileSync } from 'fs';
import * as path from 'path';

/**
 * Tarik ulang `wilayah-indonesia.csv` dari sumber hulu.
 *
 * Kode wilayah berubah tiap ada pemekaran/penggabungan daerah, jadi berkasnya
 * perlu bisa dimutakhirkan tanpa menyalin-tempel manual. Jalankan dengan
 * `npm run wilayah:refresh`, lalu `npm run wilayah:seed` untuk memuatnya.
 *
 * Sumber: https://github.com/cahyadsn/wilayah (MIT), mengikuti Kepmendagri
 * No. 300.2.2-2138 Tahun 2025. Lihat README.md di folder ini.
 */

const SUMBER = 'https://raw.githubusercontent.com/cahyadsn/wilayah/master/db/wilayah.sql';

/** Baris data di dump SQL berbentuk `('34.04.01.2001','Balecatur'),` */
const BARIS = /^\('([0-9.]{2,13})','(.*)'\)[,;]$/;

async function main() {
  console.log(`Mengunduh ${SUMBER} ...`);
  const res = await fetch(SUMBER);
  if (!res.ok) throw new Error(`Unduhan gagal: HTTP ${res.status} ${res.statusText}`);

  const sql = await res.text();
  const baris: string[] = ['kode,nama'];
  const kode = new Set<string>();

  for (const b of sql.split('\n')) {
    const m = BARIS.exec(b.trim());
    if (!m) continue;
    // `''` adalah escape SQL untuk satu petik tunggal (mis. "Pasi Kuala Ba''u").
    const nama = m[2].replace(/''/g, "'");
    if (nama.includes(',')) throw new Error(`Nama memuat koma, format CSV perlu dikaji: ${nama}`);
    kode.add(m[1]);
    baris.push(`${m[1]},${nama}`);
  }

  // Sanity check sebelum menimpa berkas yang sudah ada: kalau hulu berubah
  // bentuk, hasil parsing bisa nyaris kosong dan menimpanya diam-diam jauh lebih
  // buruk daripada gagal di sini.
  const jumlah = baris.length - 1;
  if (jumlah < 80_000) {
    throw new Error(`Hanya ${jumlah} baris terbaca (harapan >80.000) — format sumber mungkin berubah`);
  }
  if (kode.size !== jumlah) {
    throw new Error(`Ada kode ganda di sumber: ${jumlah} baris tapi ${kode.size} kode unik`);
  }

  const tujuan = path.join(__dirname, 'wilayah-indonesia.csv');
  writeFileSync(tujuan, baris.join('\n') + '\n', 'utf-8');

  const perLevel = [1, 2, 3, 4].map(
    (l) => baris.slice(1).filter((b) => b.substring(0, b.indexOf(',')).split('.').length === l).length,
  );
  console.log(
    `${tujuan} ditulis: ${jumlah} wilayah — ${perLevel[0]} provinsi, ${perLevel[1]} kabupaten/kota, ` +
      `${perLevel[2]} kecamatan, ${perLevel[3]} desa/kelurahan`,
  );
  console.log('Jalankan `npm run wilayah:seed` untuk memuatnya ke database.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
