import { RumahTanggaService } from './rumah-tangga.service';

/**
 * Regression test 2026-10-01: `GET /rumah-tangga` memakai `findMany` tanpa
 * `orderBy`, jadi urutan baris (dan isi halaman `skip/take`) tidak terjamin —
 * kartu tugas petugas menampilkan sampel acak, daftar riwayat tidak benar-benar
 * "terbaru dulu", dan UI menghitung statistik dari 100 baris acak. Daftar kini
 * punya urutan tetap, filter `flagged`, `limit` yang dibatasi, dan ringkasan
 * (`meta.ringkasan`) yang dihitung dari cakupan wilayah+periode pemanggil.
 */
const WIL_A = '11111111-1111-4111-8111-111111111111';
const PERIODE = '33333333-3333-4333-8333-333333333333';

const petugas = { role: 'petugas', wilayahId: WIL_A, wilayahIds: [WIL_A] };
const admin = { role: 'admin' };

function buat(perStatus: { statusVerifikasi: string; _count: { _all: number } }[] = [], perluCek = 0) {
  const rumahTangga = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn((args: any) => Promise.resolve(args.where.flaggedDuplicate && args.where.statusVerifikasi ? perluCek : 7)),
    groupBy: jest.fn().mockResolvedValue(perStatus),
  };
  const service = new RumahTanggaService({ rumahTangga } as any, {} as any, {} as any, {} as any);
  return { service, rumahTangga };
}

describe('RumahTanggaService.findAll — urutan, filter, dan ringkasan', () => {
  it('selalu mengurutkan terbaru dulu dengan id sebagai pemutus seri', async () => {
    const { service, rumahTangga } = buat();
    await service.findAll({ periode_id: PERIODE }, admin as any);
    expect(rumahTangga.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });

  it('filter flagged hanya mempersempit daftar, bukan ringkasan', async () => {
    const { service, rumahTangga } = buat();
    await service.findAll({ periode_id: PERIODE, flagged: true, status: 'pending' }, admin as any);

    expect(rumahTangga.findMany.mock.calls[0][0].where).toEqual({
      periodeId: PERIODE,
      statusVerifikasi: 'pending',
      flaggedDuplicate: true,
    });
    // groupBy (ringkasan) tidak boleh ikut tersaring status/flag
    expect(rumahTangga.groupBy.mock.calls[0][0].where).toEqual({ periodeId: PERIODE });
  });

  it('tanpa flagged=true tidak memasang filter flag', async () => {
    const { service, rumahTangga } = buat();
    await service.findAll({ periode_id: PERIODE, flagged: false }, admin as any);
    expect(rumahTangga.findMany.mock.calls[0][0].where).toEqual({ periodeId: PERIODE });
  });

  it('membatasi limit dan menormalkan page yang tidak masuk akal', async () => {
    const { service, rumahTangga } = buat();
    await service.findAll({ limit: 999999, page: -3 }, admin as any);
    let args = rumahTangga.findMany.mock.calls[0][0];
    expect(args.take).toBe(1000);
    expect(args.skip).toBe(0);

    await service.findAll({ limit: NaN, page: NaN }, admin as any);
    args = rumahTangga.findMany.mock.calls[1][0];
    expect(args.take).toBe(10);
    expect(args.skip).toBe(0);

    await service.findAll({ limit: 6, page: 3 }, admin as any);
    args = rumahTangga.findMany.mock.calls[2][0];
    expect(args.take).toBe(6);
    expect(args.skip).toBe(12);
  });

  it('menghitung ringkasan per status dan perlu_cek_duplikat (ditandai & masih pending)', async () => {
    const { service } = buat(
      [
        { statusVerifikasi: 'pending', _count: { _all: 19 } },
        { statusVerifikasi: 'verified', _count: { _all: 1 } },
      ],
      6,
    );
    const hasil = await service.findAll({ periode_id: PERIODE }, admin as any);
    expect(hasil.meta.ringkasan).toEqual({
      total: 20,
      pending: 19,
      verified: 1,
      rejected: 0,
      perlu_cek_duplikat: 6,
    });
  });

  it('ringkasan petugas tetap dibatasi wilayahnya', async () => {
    const { service, rumahTangga } = buat();
    await service.findAll({ periode_id: PERIODE }, petugas as any);
    expect(rumahTangga.groupBy.mock.calls[0][0].where).toEqual({ periodeId: PERIODE, wilayahId: { in: [WIL_A] } });
    const hitungCek = rumahTangga.count.mock.calls.find(([a]: any) => a.where.flaggedDuplicate)![0];
    expect(hitungCek.where).toEqual({
      periodeId: PERIODE,
      wilayahId: { in: [WIL_A] },
      flaggedDuplicate: true,
      statusVerifikasi: 'pending',
    });
  });
});
