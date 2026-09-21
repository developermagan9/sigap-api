import { hitungTurunanAnggota, AnggotaInput } from './rumah-tangga.service';

/** Tanggal acuan tetap supaya hasil test tidak berubah seiring waktu berjalan. */
const SEKARANG = new Date('2026-09-07T00:00:00Z');

const anggota = (over: Partial<AnggotaInput> = {}): AnggotaInput => ({
  tanggal_lahir: '1995-01-01',
  status_disabilitas: false,
  is_tanggungan: true,
  ...over,
});

describe('hitungTurunanAnggota', () => {
  it('jumlah_tanggungan = anggota ber-is_tanggungan', () => {
    const hasil = hitungTurunanAnggota(
      [
        anggota({ is_tanggungan: false }),
        anggota({ is_tanggungan: true }),
        anggota({ is_tanggungan: true }),
      ],
      SEKARANG,
    );
    expect(hasil.jumlahTanggungan).toBe(2);
  });

  it('disabilitas dihitung tanpa memandang umur', () => {
    const hasil = hitungTurunanAnggota(
      [anggota({ tanggal_lahir: '2010-01-01', status_disabilitas: true })],
      SEKARANG,
    );
    expect(hasil.jumlahDisabilitasLansia).toBe(1);
  });

  it('lansia = umur >= 60 tahun', () => {
    const hasil = hitungTurunanAnggota(
      [
        anggota({ tanggal_lahir: '1950-01-01' }), // 76
        anggota({ tanggal_lahir: '1990-01-01' }), // 36
      ],
      SEKARANG,
    );
    expect(hasil.jumlahDisabilitasLansia).toBe(1);
  });

  it('anggota disabilitas DAN lansia hanya dihitung sekali', () => {
    const hasil = hitungTurunanAnggota(
      [anggota({ tanggal_lahir: '1940-01-01', status_disabilitas: true })],
      SEKARANG,
    );
    expect(hasil.jumlahDisabilitasLansia).toBe(1);
  });

  /**
   * Batas umur dihitung secara kalender, bukan lewat selisih epoch.
   *
   * Implementasi lama memakai trik `new Date(Date.now() - dob).getUTCFullYear() - 1970`,
   * yang menghitung selisih dalam milidetik lalu membaginya dengan tahun rata-rata
   * 365 hari — sehingga tiap tahun kabisat yang terlewat menggeser hasilnya
   * hampir satu hari. Untuk orang yang baru saja berulang tahun ke-60, akumulasi
   * ~15 hari geseran itu cukup membuatnya terbaca 59 dan tidak terhitung sebagai
   * lansia, padahal kriterianya sudah terpenuhi.
   */
  describe('batas tepat 60 tahun', () => {
    it('sehari SEBELUM ulang tahun ke-60 belum terhitung lansia', () => {
      const hasil = hitungTurunanAnggota([anggota({ tanggal_lahir: '1966-09-08' })], SEKARANG);
      expect(hasil.jumlahDisabilitasLansia).toBe(0);
    });

    it('tepat pada ulang tahun ke-60 sudah terhitung lansia', () => {
      const hasil = hitungTurunanAnggota([anggota({ tanggal_lahir: '1966-09-07' })], SEKARANG);
      expect(hasil.jumlahDisabilitasLansia).toBe(1);
    });
  });

  it('daftar kosong menghasilkan nol, bukan NaN', () => {
    expect(hitungTurunanAnggota([], SEKARANG)).toEqual({
      jumlahTanggungan: 0,
      jumlahDisabilitasLansia: 0,
    });
  });
});
