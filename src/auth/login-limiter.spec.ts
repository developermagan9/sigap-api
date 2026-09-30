import { LoginLimiter } from './login-limiter';

describe('LoginLimiter', () => {
  let waktu: number;
  const buat = () => new LoginLimiter(3, 60_000, () => waktu);

  beforeEach(() => {
    waktu = 1_000_000;
  });

  it('mengunci setelah N kali gagal, tidak sebelumnya', () => {
    const l = buat();
    l.catatGagal('admin');
    l.catatGagal('admin');
    expect(l.sisaKunci('admin')).toBe(0);
    l.catatGagal('admin');
    expect(l.sisaKunci('admin')).toBe(60);
  });

  it('username tidak peka huruf besar/spasi, dan tidak mengunci user lain', () => {
    const l = buat();
    ['Admin', ' admin', 'ADMIN'].forEach((u) => l.catatGagal(u));
    expect(l.sisaKunci('admin')).toBeGreaterThan(0);
    expect(l.sisaKunci('petugas')).toBe(0);
  });

  it('kunci terbuka sendiri setelah jendela lewat', () => {
    const l = buat();
    [1, 2, 3].forEach(() => l.catatGagal('admin'));
    waktu += 30_000;
    expect(l.sisaKunci('admin')).toBe(30);
    waktu += 30_000;
    expect(l.sisaKunci('admin')).toBe(0);
    l.catatGagal('admin');
    expect(l.sisaKunci('admin')).toBe(0);
  });

  it('login sukses (reset) mengosongkan hitungan', () => {
    const l = buat();
    l.catatGagal('admin');
    l.catatGagal('admin');
    l.reset('admin');
    l.catatGagal('admin');
    expect(l.sisaKunci('admin')).toBe(0);
  });
});
