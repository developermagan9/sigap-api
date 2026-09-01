# Referensi wilayah administratif Indonesia

`wilayah-indonesia.csv` — 91.599 baris `kode,nama`, mencakup seluruh wilayah
administratif Indonesia sampai tingkat desa/kelurahan:

| Level | Jumlah | Bentuk kode | Contoh |
|---|---|---|---|
| 1 — Provinsi | 38 | `PP` | `34` → Daerah Istimewa Yogyakarta |
| 2 — Kabupaten/Kota | 514 | `PP.KK` | `34.04` → Kabupaten Sleman |
| 3 — Kecamatan | 7.285 | `PP.KK.CC` | `34.04.01` → Gamping |
| 4 — Desa/Kelurahan | 83.762 | `PP.KK.CC.DDDD` | `34.04.01.2001` → Balecatur |

Kode induk adalah prefiks kode anak — memotong satu segmen dari belakang
menghasilkan kode induknya. Itu satu-satunya aturan yang dipakai
`prisma/seed-wilayah.ts` untuk membentuk hierarkinya, jadi tidak ada tabel
pemetaan terpisah yang bisa ikut basi.

## Sumber & versi

Data mengikuti **Kepmendagri No. 300.2.2-2138 Tahun 2025** tentang Pemberian dan
Pemutakhiran Kode, Data Wilayah Administrasi Pemerintahan, dan Pulau.

Diturunkan dari <https://github.com/cahyadsn/wilayah> (`db/wilayah.sql`, lisensi
MIT, © cahya dsn) — hanya kolom `kode` dan `nama` yang diambil, dan escape SQL
`''` dikembalikan menjadi `'` (mis. `Pasi Kuala Ba''u` → `Pasi Kuala Ba'u`).

## Memutakhirkan

Kode wilayah berubah setiap kali ada pemekaran atau penggabungan daerah. Untuk
menarik versi terbaru:

```bash
npm run wilayah:refresh      # unduh + tulis ulang wilayah-indonesia.csv
npm run wilayah:seed         # muat ulang ke tabel wilayah_referensi
```

`wilayah:seed` bersifat idempoten: baris yang kodenya sudah ada diperbarui
namanya, yang hilang dari sumber baru dihapus. Tabel `wilayah` (wilayah kerja
operasional) **tidak** ikut tersentuh — kalau sebuah desa dimekarkan dan kodenya
berubah, baris wilayah kerja yang menunjuk kode lama akan dilaporkan oleh
`wilayah:seed` sebagai yatim, bukan dihapus diam-diam, karena `rumah_tangga`
masih menunjuk ke sana.
