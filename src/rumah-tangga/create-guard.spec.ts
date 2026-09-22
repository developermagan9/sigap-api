import { HttpException } from '@nestjs/common';
import { RumahTanggaService } from './rumah-tangga.service';
import { CreateRumahTanggaDto } from './dto/create-rumah-tangga.dto';

/**
 * Regression test 2026-09-22: petugas (wilayah Mekarsari) bisa menyimpan KK di
 * desa lain dan ke periode yang sudah `alokasi`. Datanya lalu tidak terlihat di
 * riwayatnya sendiri, tidak masuk antrean verifikator mana pun, dan tidak pernah
 * ikut dihitung. Kedua penjaga harus menolak SEBELUM ada tulisan ke database.
 */
const WIL_MILIK = '11111111-1111-4111-8111-111111111111';
const WIL_LAIN = '22222222-2222-4222-8222-222222222222';
const PERIODE = '33333333-3333-4333-8333-333333333333';

const petugas = { role: 'petugas', wilayahId: WIL_MILIK, wilayahIds: [WIL_MILIK] };
const admin = { role: 'admin' };

function buat(statusPeriode: string | null, wilayahByKode: Record<string, string>) {
  const prisma = {
    periodeProgram: {
      findUnique: jest.fn().mockResolvedValue(statusPeriode ? { status: statusPeriode, namaProgram: 'P' } : null),
    },
    wilayah: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(wilayahByKode[where.kode] ? { id: wilayahByKode[where.kode] } : null),
      ),
      findMany: jest.fn().mockResolvedValue([{ desa: 'Mekarsari', kode: '32.04.29.2003' }]),
    },
    rumahTangga: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  const wilayahSvc = { pastikanWilayahKerja: jest.fn().mockResolvedValue({ id: 'baru' }) };
  const service = new RumahTanggaService(prisma as any, {} as any, wilayahSvc as any);
  return { service, prisma, wilayahSvc };
}

const dto = (kode: string) => ({ kode_wilayah: kode, periode_id: PERIODE }) as CreateRumahTanggaDto;

async function kodeError(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return ((e as HttpException).getResponse() as any).error.code;
  }
  return null;
}

describe('RumahTanggaService.create — penjaga periode & wilayah', () => {
  it('menolak periode yang sudah lewat draft', async () => {
    const { service, prisma } = buat('alokasi', { '32.04.29.2003': WIL_MILIK });
    expect(await kodeError(service.create(dto('32.04.29.2003'), 'u', petugas))).toBe('PERIODE_BUKAN_PENDATAAN');
    expect(prisma.rumahTangga.findFirst).not.toHaveBeenCalled();
  });

  it('menolak periode yang tidak ada', async () => {
    const { service } = buat(null, {});
    expect(await kodeError(service.create(dto('32.04.29.2003'), 'u', petugas))).toBe('PERIODE_TIDAK_DITEMUKAN');
  });

  it('menolak petugas mendata desa yang sudah ada tapi di luar wilayahnya', async () => {
    const { service, prisma } = buat('draft', { '34.03.01.2004': WIL_LAIN });
    expect(await kodeError(service.create(dto('34.03.01.2004'), 'u', petugas))).toBe('WILAYAH_DI_LUAR_KEWENANGAN');
    expect(prisma.rumahTangga.findFirst).not.toHaveBeenCalled();
  });

  it('menolak desa yang belum pernah didata tanpa membuat baris wilayah baru', async () => {
    const { service, wilayahSvc } = buat('draft', {});
    expect(await kodeError(service.create(dto('34.03.01.2004'), 'u', petugas))).toBe('WILAYAH_DI_LUAR_KEWENANGAN');
    expect(wilayahSvc.pastikanWilayahKerja).not.toHaveBeenCalled();
  });

  it('meloloskan desa di wilayah petugas (lanjut ke cek duplikat)', async () => {
    const { service, prisma } = buat('draft', { '32.04.29.2003': WIL_MILIK });
    prisma.rumahTangga.findFirst.mockResolvedValue({ id: 'ada' });
    expect(await kodeError(service.create(dto('32.04.29.2003'), 'u', petugas))).toBe('DUPLICATE_NIK');
  });

  it('admin boleh desa mana pun, termasuk yang belum ada (dibuat otomatis)', async () => {
    const { service, prisma, wilayahSvc } = buat('draft', {});
    prisma.rumahTangga.findFirst.mockResolvedValue({ id: 'ada' });
    expect(await kodeError(service.create(dto('34.03.01.2004'), 'u', admin))).toBe('DUPLICATE_NIK');
    expect(wilayahSvc.pastikanWilayahKerja).toHaveBeenCalledWith('34.03.01.2004');
  });
});
