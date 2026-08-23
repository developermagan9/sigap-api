# SIGAP-Bansos API

Layanan backend untuk **SIGAP-Bansos** — Sistem Distribusi Bantuan Sosial Tepat Sasaran Berbasis Data Mining & Blockchain. Dibangun dengan **NestJS**, **Prisma ORM**, dan **PostgreSQL**.

Backend ini menangani:
- Autentikasi & RBAC (JWT + bcrypt)
- Pendataan warga dengan deduplikasi (NIK/No. KK ter-hash + fuzzy match nama/alamat) dan enkripsi PII (AES-256)
- Data mining: clustering kerentanan (K-Means) & ranking prioritas penerima (TOPSIS), lengkap dengan skor explainability
- Alokasi anggaran & alur persetujuan (state machine `draft → ... → disbursed`)
- Pencatatan Merkle tree & simulasi penyaluran dana on-chain
- Audit log immutable untuk setiap perubahan status/kriteria
- Endpoint publik untuk portal transparansi (ringkasan penyaluran, cek status klaim)

## Tech Stack
- **NestJS 11** + TypeScript
- **Prisma ORM** + **PostgreSQL 16**
- **JWT** (`@nestjs/jwt`, `passport-jwt`) + `bcrypt` untuk autentikasi
- **ethers.js** + `@openzeppelin/merkle-tree` untuk komponen Web3 (Merkle tree, hashing — belum tersambung ke smart contract sungguhan, lihat catatan di checklist)
- Swagger/OpenAPI (`/docs`) untuk dokumentasi endpoint

## Prasyarat
- Node.js v18+
- Docker & Docker Compose (untuk PostgreSQL) — atau instance PostgreSQL sendiri

## Cara Menjalankan

### 1. Jalankan PostgreSQL
Dari root proyek (satu level di atas folder ini):
```bash
docker compose up -d postgres
```
Tunggu sampai container berstatus `healthy` (`docker ps`).

### 2. Instalasi Dependensi
Di dalam folder `sigap-api`:
```bash
npm install
```

### 3. Konfigurasi Lingkungan (Environment)
Salin `.env.example` menjadi `.env`:
```bash
cp .env.example .env
```
Variabel yang dipakai:

| Variabel | Wajib? | Keterangan |
|---|---|---|
| `DATABASE_URL` | Ya | Connection string PostgreSQL. Default cocok dengan `docker-compose.yml` di root |
| `JWT_SECRET` | Ya | Secret untuk menandatangani JWT |
| `JWT_EXPIRES_IN` | Tidak | Default `1h` |
| `SYSTEM_PEPPER` | Direkomendasikan | Pepper untuk hashing NIK/No. KK — ganti dari nilai contoh sebelum dipakai serius, karena punya fallback tidak aman jika kosong |
| `DB_ENCRYPTION_KEY` | Direkomendasikan | Kunci AES-256 (hex 64 karakter) untuk enkripsi kolom PII — sama seperti di atas, jangan pakai nilai contoh di produksi |
| `PORT` | Tidak | Default `3001` |
| `CORS_ORIGIN` | Tidak | Default `http://localhost:3000` |
| `RPC_URL`, `CHAIN_ID`, `ADMIN_PRIVATE_KEY`, `*_CONTRACT_ADDRESS`, `DANA_TOKEN_ADDRESS` | Tidak (belum dipakai) | Disiapkan untuk integrasi smart contract yang belum diimplementasikan — lihat checklist bagian Blockchain |

### 4. Migrasi Database & Seeding
Proyek ini belum punya riwayat migrasi Prisma (`prisma/migrations` kosong), jadi skema disinkronkan langsung dengan `db push`:
```bash
npx prisma db push
npm run prisma:seed
```
Jika sebelumnya sempat memakai `prisma migrate`, gunakan `npx prisma migrate deploy` sebagai gantinya.

### 5. Menjalankan Server
```bash
npm run dev
```
Server berjalan di `http://localhost:3001`. Semua route API memiliki prefix `/v1` (contoh: `http://localhost:3001/v1/auth/login`). Dokumentasi Swagger tersedia di `http://localhost:3001/docs`.

## Akun Demo
Perintah `npm run prisma:seed` membuat akun demo untuk tiap role (admin, verifikator, petugas, auditor, plus satu akun super admin). Lihat kredensialnya langsung di `prisma/seed.ts` — sengaja tidak dicantumkan di README ini karena repo akan bersifat publik.

## Testing
Belum ada unit test otomatis di backend (lihat [checklist bagian Testing](../docs/09-Implementation-Checklist.md#8-testing-otomatis)). Verifikasi end-to-end saat ini dilakukan lewat suite Playwright di `sigap-ui/e2e/`, yang memanggil API ini secara langsung.

Cek cepat login manual:
```bash
curl -X POST http://localhost:3001/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password123"}'
```
