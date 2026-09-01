import { alamatKontrakValid } from './blockchain.service';

/**
 * Regression test untuk temuan 2026-08-29: `submit-onchain` mode simulasi
 * menyimpan `REGISTRY_CONTRACT_ADDRESS` apa adanya (di `.env.example` isinya
 * literal `"0x..."`), lalu nilai itu ditampilkan ke publik sebagai alamat kontrak
 * dan dijadikan tautan block explorer yang pasti mati.
 */
describe('alamatKontrakValid', () => {
  it('menerima alamat Ethereum yang benar', () => {
    const alamat = '0x' + 'a1B2'.repeat(10);
    expect(alamatKontrakValid(alamat)).toBe(alamat);
  });

  it('menolak placeholder .env.example', () => {
    expect(alamatKontrakValid('0x...')).toBeNull();
  });

  it('menolak null / undefined / string kosong', () => {
    expect(alamatKontrakValid(null)).toBeNull();
    expect(alamatKontrakValid(undefined)).toBeNull();
    expect(alamatKontrakValid('')).toBeNull();
  });

  it('menolak alamat yang panjangnya salah', () => {
    expect(alamatKontrakValid('0x' + 'a'.repeat(39))).toBeNull();
    expect(alamatKontrakValid('0x' + 'a'.repeat(41))).toBeNull();
  });

  it('menolak karakter non-hex dan awalan yang salah', () => {
    expect(alamatKontrakValid('0x' + 'z'.repeat(40))).toBeNull();
    expect(alamatKontrakValid('a'.repeat(42))).toBeNull();
  });
});
