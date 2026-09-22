import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateRumahTanggaDto } from './create-rumah-tangga.dto';

/**
 * Regression test untuk keputusan produk 2026-09-22: wallet mandiri wajib
 * diisi saat pendataan. Sebelumnya `wallet_address` opsional dan baris tanpa
 * wallet bisa dikirim dengan `jenis_wallet: 'custodial'`, yang membuat backend
 * men-derive alamat placeholder (`deriveCustodialWallet()`) tanpa private key
 * di baliknya — dana ke alamat itu terkunci selamanya. Sejak perubahan ini,
 * baris baru WAJIB membawa `wallet_address` asli; jalur custodial ditutup di
 * lapisan validasi supaya tidak ada lagi baris baru yang jatuh ke kondisi itu.
 */
describe('CreateRumahTanggaDto — wallet mandiri wajib', () => {
  const dasar = () => ({
    nik_kepala_keluarga: '3273010101800001',
    no_kk: '3273010101800001',
    nama_kepala_keluarga: 'Budi Santoso',
    alamat_detail: 'RT 01/RW 05 Jl. Mawar No. 1',
    kode_wilayah: '34.04.01.2001',
    pendapatan_per_kapita: 450000,
    skor_kondisi_rumah: 2,
    skor_akses_pendidikan: 3,
    riwayat_bansos_sebelumnya: false,
    periode_id: 'f3358fc2-9050-4ceb-8e2d-e24530e81a99',
    anggota: [
      {
        nik: '3273010101800001',
        nama: 'Budi Santoso',
        hubungan: 'kepala',
        tanggal_lahir: '1980-01-01',
        status_disabilitas: false,
        is_tanggungan: true,
      },
    ],
  });

  const buat = (patch: Record<string, unknown>) =>
    validateSync(plainToInstance(CreateRumahTanggaDto, { ...dasar(), ...patch }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('menerima wallet_address mandiri yang valid', () => {
    const errors = buat({ wallet_address: '0x1234567890abcdef1234567890abcdef12345678' });
    expect(errors).toHaveLength(0);
  });

  it('menolak baris tanpa wallet_address sama sekali', () => {
    const errors = buat({});
    expect(errors.map((e) => e.property)).toContain('wallet_address');
  });

  it('menolak wallet_address format salah', () => {
    const errors = buat({ wallet_address: 'bukan-alamat-eth' });
    expect(errors.map((e) => e.property)).toContain('wallet_address');
  });

  it('menolak jenis_wallet "custodial" — jalur derivasi placeholder ditutup untuk data baru', () => {
    const errors = buat({
      wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
      jenis_wallet: 'custodial',
    });
    expect(errors.map((e) => e.property)).toContain('jenis_wallet');
  });

  it('menerima jenis_wallet "mandiri" eksplisit', () => {
    const errors = buat({
      wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
      jenis_wallet: 'mandiri',
    });
    expect(errors).toHaveLength(0);
  });
});
