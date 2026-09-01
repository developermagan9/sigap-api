import { HttpException } from '@nestjs/common';
import { resolusiWilayah, type BarisWilayah, type PetaWilayah } from './rumah-tangga.service';

/**
 * Nama desa tidak unik di Indonesia — 27.544 dari 83.762 desa memakai nama yang
 * juga dipakai desa lain. Importer CSV harus menolak nama yang ambigu, bukan
 * menebak; tebakan yang salah memindahkan satu rumah tangga ke wilayah kerja
 * lain, dan scoping wilayah (siapa boleh memverifikasinya) ikut salah.
 */
describe('resolusiWilayah', () => {
  const sidomulyoSleman: BarisWilayah = {
    id: 'id-sleman',
    kode: '34.04.11.2003',
    desa: 'Sidomulyo',
    kecamatan: 'Godean',
    kabupaten: 'Kabupaten Sleman',
  };
  const sidomulyoBantul: BarisWilayah = {
    id: 'id-bantul',
    kode: '34.02.05.2002',
    desa: 'Sidomulyo',
    kecamatan: 'Bambanglipuro',
    kabupaten: 'Kabupaten Bantul',
  };
  const balecatur: BarisWilayah = {
    id: 'id-balecatur',
    kode: '34.04.01.2001',
    desa: 'Balecatur',
    kecamatan: 'Gamping',
    kabupaten: 'Kabupaten Sleman',
  };

  function petaDari(...rows: BarisWilayah[]): PetaWilayah {
    const byDesa = new Map<string, BarisWilayah[]>();
    for (const r of rows) {
      const k = r.desa.toLowerCase();
      byDesa.set(k, [...(byDesa.get(k) ?? []), r]);
    }
    return {
      byKode: new Map(rows.filter((r) => r.kode).map((r) => [r.kode!, r.id])),
      byDesa,
    };
  }

  const peta = petaDari(sidomulyoSleman, sidomulyoBantul, balecatur);

  it('memakai wilayah_id apa adanya kalau diisi', () => {
    expect(resolusiWilayah({ wilayah_id: 'uuid-langsung', desa: 'Balecatur' }, peta)).toBe('uuid-langsung');
  });

  it('mencocokkan kode_wilayah ke wilayah kerja', () => {
    expect(resolusiWilayah({ kode_wilayah: '34.04.01.2001' }, peta)).toBe('id-balecatur');
  });

  it('menerima nama desa yang unik di antara wilayah kerja', () => {
    expect(resolusiWilayah({ desa: 'Balecatur' }, peta)).toBe('id-balecatur');
    expect(resolusiWilayah({ desa: '  balecatur  ' }, peta)).toBe('id-balecatur');
  });

  it('MENOLAK nama desa yang cocok ke lebih dari satu wilayah kerja', () => {
    expect(() => resolusiWilayah({ desa: 'Sidomulyo' }, peta)).toThrow(HttpException);

    try {
      resolusiWilayah({ desa: 'Sidomulyo' }, peta);
      fail('seharusnya melempar');
    } catch (e) {
      const body = (e as HttpException).getResponse() as any;
      expect(body.error.code).toBe('WILAYAH_AMBIGU');
      // Pesannya harus menyebutkan kedua kandidat berikut kodenya, supaya
      // petugas tahu kode mana yang harus dipakai untuk membedakannya.
      expect(body.error.message).toContain('34.04.11.2003');
      expect(body.error.message).toContain('34.02.05.2002');
      expect(body.error.message).toContain('kode_wilayah');
    }
  });

  it('kode_wilayah menang atas nama desa yang ambigu', () => {
    expect(resolusiWilayah({ kode_wilayah: '34.02.05.2002', desa: 'Sidomulyo' }, peta)).toBe('id-bantul');
  });

  it('menolak kode_wilayah yang belum jadi wilayah kerja', () => {
    try {
      resolusiWilayah({ kode_wilayah: '11.01.01.2001' }, peta);
      fail('seharusnya melempar');
    } catch (e) {
      expect(((e as HttpException).getResponse() as any).error.code).toBe('WILAYAH_TIDAK_DIKENAL');
    }
  });

  it('menolak baris tanpa satu pun kolom wilayah', () => {
    try {
      resolusiWilayah({}, peta);
      fail('seharusnya melempar');
    } catch (e) {
      expect(((e as HttpException).getResponse() as any).error.code).toBe('WILAYAH_TIDAK_DIKENAL');
    }
  });
});
