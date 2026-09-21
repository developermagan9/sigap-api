import {
  tanpaBatasWilayah,
  daftarWilayah,
  filterWilayah,
  bolehAksesWilayah,
} from './wilayah-scope';

const W1 = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const W2 = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const W3 = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f';

describe('wilayah-scope', () => {
  describe('tanpaBatasWilayah', () => {
    it('admin tidak dibatasi', () => {
      expect(tanpaBatasWilayah({ role: 'admin', wilayahId: null })).toBe(true);
    });

    it('pemanggil internal (user undefined) tidak dibatasi', () => {
      expect(tanpaBatasWilayah(undefined)).toBe(true);
    });

    it('verifikator & petugas dibatasi', () => {
      expect(tanpaBatasWilayah({ role: 'verifikator', wilayahId: W1 })).toBe(false);
      expect(tanpaBatasWilayah({ role: 'petugas', wilayahId: W1 })).toBe(false);
    });
  });

  describe('daftarWilayah', () => {
    it('menggabungkan wilayah utama dengan wilayah akses tambahan', () => {
      expect(
        daftarWilayah({ role: 'verifikator', wilayahId: W1, wilayahIds: [W1, W2, W3] }),
      ).toEqual([W1, W2, W3]);
    });

    it('jatuh ke wilayah utama untuk user lama yang belum punya UserWilayah', () => {
      expect(daftarWilayah({ role: 'verifikator', wilayahId: W1 })).toEqual([W1]);
    });

    it('membuang duplikat — wilayah utama biasanya juga ada di daftar akses', () => {
      expect(
        daftarWilayah({ role: 'verifikator', wilayahId: W1, wilayahIds: [W1, W1, W2] }),
      ).toEqual([W1, W2]);
    });

    it('user tanpa wilayah sama sekali menghasilkan daftar kosong, bukan null', () => {
      expect(daftarWilayah({ role: 'verifikator', wilayahId: null })).toEqual([]);
    });
  });

  describe('filterWilayah', () => {
    it('admin tidak menghasilkan filter apa pun', () => {
      expect(filterWilayah({ role: 'admin' })).toBeUndefined();
    });

    it('non-admin selalu menghasilkan filter `in`, bukan kecocokan tunggal', () => {
      expect(filterWilayah({ role: 'verifikator', wilayahId: W1, wilayahIds: [W1, W2] })).toEqual({
        in: [W1, W2],
      });
    });

    /**
     * Regresi bug fail-500. Pola lama `user.wilayahId ?? '__no_wilayah__'`
     * meletakkan string non-UUID di kolom `@db.Uuid`, dan Prisma menolaknya di
     * level driver dengan `Inconsistent column data: Error creating UUID` — jadi
     * user non-admin tanpa wilayah menerima HTTP 500 berisi stack trace Prisma,
     * bukan daftar kosong seperti yang dimaksudkan. `{ in: [] }` sah secara tipe
     * dan benar mengembalikan nol baris.
     */
    it('user tanpa wilayah: fail-closed lewat `in: []`, tanpa sentinel non-UUID', () => {
      const filter = filterWilayah({ role: 'verifikator', wilayahId: null });
      expect(filter).toEqual({ in: [] });
      expect(JSON.stringify(filter)).not.toContain('__no_wilayah__');
    });
  });

  describe('bolehAksesWilayah', () => {
    it('admin boleh ke wilayah mana pun', () => {
      expect(bolehAksesWilayah({ role: 'admin' }, W3)).toBe(true);
    });

    it('verifikator kecamatan boleh ke seluruh desa yang dibawahinya', () => {
      const camat = { role: 'verifikator', wilayahId: W1, wilayahIds: [W1, W2, W3] };
      expect(bolehAksesWilayah(camat, W1)).toBe(true);
      expect(bolehAksesWilayah(camat, W2)).toBe(true);
      expect(bolehAksesWilayah(camat, W3)).toBe(true);
    });

    it('ditolak di luar kewenangan', () => {
      expect(bolehAksesWilayah({ role: 'verifikator', wilayahId: W1, wilayahIds: [W1] }, W2)).toBe(
        false,
      );
    });

    it('user tanpa wilayah ditolak di mana pun (fail-closed)', () => {
      expect(bolehAksesWilayah({ role: 'verifikator', wilayahId: null }, W1)).toBe(false);
    });
  });
});
