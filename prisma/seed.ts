import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);
  const suPasswordHash = await bcrypt.hash('TuhanYesus1', 10);

  // 1. Seed Wilayah kerja
  //
  // Nama & kode diambil persis dari `wilayah_referensi` (Kepmendagri
  // 300.2.2-2138/2025) — sebelumnya desa-desa di sini dikarang ("Sukamaju",
  // "Karangwangi") dan kabupatennya ditulis tanpa awalan resmi ("Bandung"
  // alih-alih "Kabupaten Bandung"), jadi data demo tidak pernah cocok dengan
  // apa pun yang bisa dipilih lewat form wilayah.
  //
  // PRASYARAT: jalankan `npm run wilayah:seed` lebih dulu. Tanpa itu tabel
  // referensinya kosong dan seed ini berhenti dengan pesan yang menyebutkannya.
  const wilayahs = [
    { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', kode: '32.04.29.2003' }, // Mekarsari, Ciparay
    { id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', kode: '32.04.29.2001' }, // Ciparay, Ciparay
    { id: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f', kode: '32.04.08.2005' }, // Bojongsari, Bojongsoang
    { id: 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a', kode: '33.22.10.1004' }, // Tambakboyo, Ambarawa
    { id: 'e5f6a7b8-c9d0-4e1f-aa3b-4c5d6e7f8a9b', kode: '33.22.10.1010' }, // Baran, Ambarawa
    { id: 'f6a7b8c9-d0e1-4f2a-bb4c-5d6e7f8a9b0c', kode: '35.07.24.2013' }, // Ardimulyo, Singosari
  ];

  const kodeJalur = new Set<string>();
  for (const w of wilayahs) {
    const [p, k, c] = w.kode.split('.');
    kodeJalur.add(p);
    kodeJalur.add(`${p}.${k}`);
    kodeJalur.add(`${p}.${k}.${c}`);
    kodeJalur.add(w.kode);
  }

  const referensi = new Map(
    (
      await prisma.wilayahReferensi.findMany({
        where: { kode: { in: [...kodeJalur] } },
        select: { kode: true, nama: true },
      })
    ).map((r) => [r.kode, r.nama]),
  );

  const belumAda = [...kodeJalur].filter((k) => !referensi.has(k));
  if (belumAda.length > 0) {
    throw new Error(
      `Referensi wilayah belum lengkap (${belumAda.length} kode hilang, mis. ${belumAda
        .slice(0, 3)
        .join(', ')}).\nJalankan \`npm run wilayah:seed\` lebih dulu.`,
    );
  }

  for (const w of wilayahs) {
    const [p, k, c] = w.kode.split('.');
    const data = {
      kode: w.kode,
      provinsi: referensi.get(p)!,
      kabupaten: referensi.get(`${p}.${k}`)!,
      kecamatan: referensi.get(`${p}.${k}.${c}`)!,
      desa: referensi.get(w.kode)!,
    };
    // `update` sengaja diisi (bukan `{}`): menjalankan ulang seed pada database
    // lama harus ikut memperbaiki nama-nama karangan yang sudah terlanjur ada.
    await prisma.wilayah.upsert({
      where: { id: w.id },
      update: data,
      create: { id: w.id, ...data },
    });
  }

  // 2. Seed Users
  const users = [
    {
      username: 'admin',
      nama: 'Admin Dinas Sosial',
      role: UserRole.admin,
      passwordHash,
    },
    {
      // Verifikator WAJIB punya wilayah. Sejak scoping RBAC diterapkan, akses
      // baca maupun tulis (daftar rumah tangga, daftar sanggahan, keputusan
      // verifikasi) dibatasi ke `user.wilayahId` — dan pembatasannya fail-closed:
      // verifikator tanpa wilayah tidak melihat apa pun, bukan melihat semuanya.
      // Seed lama tidak mengisi kolom ini, sehingga akun demo ini tidak bisa
      // memverifikasi satu berkas pun.
      username: 'verifikator',
      nama: 'Verifikator Desa Sukamaju',
      role: UserRole.verifikator,
      wilayahId: wilayahs[0].id,
      passwordHash,
    },
    {
      username: 'petugas',
      nama: 'Petugas Desa Sukamaju',
      role: UserRole.petugas,
      wilayahId: wilayahs[0].id,
      passwordHash,
    },
    {
      username: 'auditor',
      nama: 'Auditor Eksternal',
      role: UserRole.auditor,
      passwordHash,
    },
    {
      username: 'ITSUP',
      nama: 'Super Admin',
      role: UserRole.admin, // Beri akses admin sementara, role switcher akan di-handle di UI
      passwordHash: suPasswordHash,
    }
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { username: u.username },
      update: {
        passwordHash: u.passwordHash,
        role: u.role,
        nama: u.nama,
        // Ikut di-update supaya database yang sudah ada (dibuat seed versi lama)
        // ikut terkoreksi saat seed dijalankan ulang, bukan hanya database baru.
        wilayahId: (u as { wilayahId?: string }).wilayahId ?? null,
      },
      create: u,
    });
  }

  // 3. Seed Periode Program
  const periode = await prisma.periodeProgram.upsert({
    where: { id: 'a1234567-89ab-4def-8123-456789abcdef' },
    update: {},
    create: {
      id: 'a1234567-89ab-4def-8123-456789abcdef',
      namaProgram: 'Bantuan Langsung Tunai (BLT) Dana Desa',
      anggaranTotal: 15000000,
      bobotKriteria: { pendapatan: 0.35, tanggungan: 0.25, disabilitasLansia: 0.20, kondisiRumah: 0.20 },
    },
  });

  console.log('\nSeed completed successfully!');
  console.log('\nDefault credentials:');
  console.log('  admin / password123');
  console.log('  verifikator / password123');
  console.log('  petugas / password123');
  console.log('  ITSUP / TuhanYesus1 (Super Admin)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
