import { Logger } from '@nestjs/common';

/**
 * Validasi variabel lingkungan yang menentukan keamanan sistem.
 *
 * **Kenapa ini ada.** `crypto.util.ts` dan `auth.module.ts` punya nilai cadangan
 * hardcode untuk `SYSTEM_PEPPER`, `DB_ENCRYPTION_KEY`, dan `JWT_SECRET`. Kalau
 * salah satu variabel itu lupa diisi saat deploy, aplikasi tetap **berhasil
 * start** dan berjalan seolah normal — padahal:
 *
 *  - seluruh `nik_kk_hash` dihitung dengan pepper yang tertulis di source code,
 *    sehingga bisa di-brute-force dari dump database (ruang NIK cuma 16 digit —
 *    ini persis skenario yang dilarang 07-Security-Privacy-Ethics.md §2);
 *  - seluruh PII dienkripsi dengan kunci AES nol;
 *  - seluruh JWT ditandatangani dengan secret yang diketahui publik, jadi siapa
 *    pun bisa menerbitkan token admin sendiri.
 *
 * Tidak ada satu pun dari kegagalan itu yang terlihat dari luar. Karena itu
 * pemeriksaannya dibuat **fail-fast**: di `production` proses berhenti, di
 * development tetap jalan tapi dengan peringatan yang sulit diabaikan.
 *
 * Cara membuat nilai yang benar: lihat `docs/16-Konfigurasi-Kredensial.md`.
 */

const logger = new Logger('EnvValidation');

/** Nilai contoh di `.env.example` — kalau ini yang terpakai, artinya belum diganti. */
const PLACEHOLDER = new Set([
  'change-me-to-a-strong-random-string',
  'change-me-to-a-64-char-hex-string',
  'change-me-to-a-64-char-hex-key',
  'default-pepper-change-me',
  'sigap-secret',
  '0x_your_deployer_private_key',
  '0x...',
  '',
]);

type Aturan = {
  nama: string;
  wajib: boolean;
  /** Pola yang harus dipenuhi kalau variabelnya diisi. */
  pola?: RegExp;
  petunjuk: string;
};

const ATURAN: Aturan[] = [
  {
    nama: 'DATABASE_URL',
    wajib: true,
    pola: /^postgres(ql)?:\/\/.+/,
    petunjuk: 'URL koneksi Postgres, mis. postgresql://user:pass@host:5432/db?schema=public',
  },
  {
    nama: 'JWT_SECRET',
    wajib: true,
    pola: /^.{32,}$/,
    petunjuk: 'minimal 32 karakter acak — buat dengan: openssl rand -hex 32',
  },
  {
    nama: 'SYSTEM_PEPPER',
    wajib: true,
    pola: /^[0-9a-fA-F]{64}$/,
    petunjuk: '64 karakter hex (32 byte) — buat dengan: openssl rand -hex 32',
  },
  {
    nama: 'DB_ENCRYPTION_KEY',
    wajib: true,
    pola: /^[0-9a-fA-F]{64}$/,
    petunjuk: 'kunci AES-256, tepat 64 karakter hex — buat dengan: openssl rand -hex 32',
  },
];

/** Variabel blockchain: opsional (mode simulasi), tapi kalau diisi harus benar. */
const ATURAN_CHAIN: Aturan[] = [
  { nama: 'RPC_URL', wajib: false, pola: /^https?:\/\/.+/, petunjuk: 'URL RPC node, mis. https://rpc-amoy.polygon.technology' },
  { nama: 'ADMIN_PRIVATE_KEY', wajib: false, pola: /^0x[0-9a-fA-F]{64}$/, petunjuk: '0x + 64 karakter hex' },
  { nama: 'REGISTRY_CONTRACT_ADDRESS', wajib: false, pola: /^0x[0-9a-fA-F]{40}$/, petunjuk: '0x + 40 karakter hex' },
  { nama: 'DISBURSEMENT_CONTRACT_ADDRESS', wajib: false, pola: /^0x[0-9a-fA-F]{40}$/, petunjuk: '0x + 40 karakter hex' },
  { nama: 'DANA_TOKEN_ADDRESS', wajib: false, pola: /^0x[0-9a-fA-F]{40}$/, petunjuk: '0x + 40 karakter hex' },
];

export function validateEnv(): void {
  const produksi = process.env.NODE_ENV === 'production';
  const galat: string[] = [];
  const peringatan: string[] = [];

  for (const a of ATURAN) {
    const nilai = process.env[a.nama];

    if (nilai === undefined || nilai === '') {
      galat.push(`${a.nama} belum diisi — ${a.petunjuk}`);
      continue;
    }
    if (PLACEHOLDER.has(nilai)) {
      galat.push(`${a.nama} masih memakai nilai contoh dari .env.example — ${a.petunjuk}`);
      continue;
    }
    if (a.pola && !a.pola.test(nilai)) {
      galat.push(`${a.nama} formatnya tidak valid — ${a.petunjuk}`);
    }
  }

  // Blockchain: kosong/placeholder = mode simulasi (sah). Yang dilaporkan hanya
  // nilai yang diisi tapi salah format — itu pasti salah ketik, bukan pilihan.
  const chainTerisi: string[] = [];
  for (const a of ATURAN_CHAIN) {
    const nilai = process.env[a.nama];
    if (nilai === undefined || PLACEHOLDER.has(nilai)) continue;
    chainTerisi.push(a.nama);
    if (a.pola && !a.pola.test(nilai)) {
      peringatan.push(`${a.nama} diisi tapi formatnya tidak valid — ${a.petunjuk}`);
    }
  }

  if (peringatan.length > 0) {
    for (const p of peringatan) logger.warn(p);
  }

  if (galat.length > 0) {
    const pesan = [
      'Konfigurasi keamanan tidak lengkap:',
      ...galat.map((g) => `  • ${g}`),
      '',
      'Panduan lengkap cara membuat tiap nilai: docs/16-Konfigurasi-Kredensial.md',
    ].join('\n');

    if (produksi) {
      // Sengaja menghentikan proses: berjalan dengan pepper/kunci yang diketahui
      // publik jauh lebih berbahaya daripada tidak berjalan sama sekali.
      logger.error(pesan);
      throw new Error('Startup dibatalkan — variabel lingkungan keamanan belum benar.');
    }
    logger.warn(`${pesan}\n\nNODE_ENV bukan 'production', jadi proses diteruskan memakai nilai cadangan yang TIDAK AMAN. Jangan pakai konfigurasi ini di luar mesin lokal.`);
  }

  // Mode on-chain nyata butuh KETIGANYA sekaligus (syarat yang sama dengan
  // `BlockchainService.getChainConfig()`). Melaporkan "on-chain nyata" hanya
  // karena RPC_URL terisi akan menyesatkan — submit-onchain tetap jatuh ke
  // simulasi selama private key / alamat registry masih placeholder.
  const wajibChain = ['RPC_URL', 'ADMIN_PRIVATE_KEY', 'REGISTRY_CONTRACT_ADDRESS'];
  const chainSiap = wajibChain.every((n) => chainTerisi.includes(n));
  const kurang = wajibChain.filter((n) => !chainTerisi.includes(n));

  logger.log(
    chainSiap
      ? 'Konfigurasi terbaca — mode blockchain: on-chain nyata (kredensial lengkap)'
      : `Konfigurasi terbaca — mode blockchain: SIMULASI (belum terisi: ${kurang.join(', ')}). ` +
          'Panduan mengisinya: docs/16-Konfigurasi-Kredensial.md',
  );
}
