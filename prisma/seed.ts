import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);
  const suPasswordHash = await bcrypt.hash('TuhanYesus1', 10);

  // 1. Seed Wilayah
  const wilayahs = [
    {
      id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      provinsi: 'Jawa Barat',
      kabupaten: 'Bandung',
      kecamatan: 'Ciparay',
      desa: 'Sukamaju',
    },
    {
      id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      provinsi: 'Jawa Barat',
      kabupaten: 'Bandung',
      kecamatan: 'Ciparay',
      desa: 'Ciparay',
    },
    {
      id: 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f',
      provinsi: 'Jawa Barat',
      kabupaten: 'Bandung',
      kecamatan: 'Bojongsoang',
      desa: 'Mekarsari',
    },
    {
      id: 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a',
      provinsi: 'Jawa Tengah',
      kabupaten: 'Semarang',
      kecamatan: 'Ambarawa',
      desa: 'Tanjungrejo',
    },
    {
      id: 'e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b',
      provinsi: 'Jawa Tengah',
      kabupaten: 'Semarang',
      kecamatan: 'Ambarawa',
      desa: 'Bojongsari',
    },
    {
      id: 'f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c',
      provinsi: 'Jawa Timur',
      kabupaten: 'Malang',
      kecamatan: 'Singosari',
      desa: 'Karangwangi',
    },
  ];

  for (const w of wilayahs) {
    await prisma.wilayah.upsert({
      where: { id: w.id },
      update: {},
      create: w,
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
      username: 'verifikator',
      nama: 'Verifikator Pusat',
      role: UserRole.verifikator,
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
        nama: u.nama
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
