import { MiningService } from './mining.service';

/**
 * Regression test b4 (15-Checklist): `finalizeRanking()` dulu menulis ranking
 * `final`, lalu dua `updateStatus()`, lalu audit log sebagai query terpisah — gagal
 * di tengah jalan meninggalkan state setengah jadi. Sekarang semuanya harus lewat
 * SATU client transaksi, dan galat di langkah mana pun harus menggagalkan transaksi.
 *
 * Rollback-nya sendiri diverifikasi terhadap Postgres sungguhan (approvedBy non-UUID
 * → audit.log gagal → status tetap `alokasi`, ranking tetap `draft`); test ini
 * menjaga supaya tidak ada penulisan yang diam-diam kembali memakai `this.prisma`.
 */
describe('MiningService.finalizeRanking — atomik', () => {
  const periodeId = '67379184-02e3-4579-8fde-f77da67db3b9';
  const actor = '11111111-1111-4111-8111-111111111111';

  function siapkan(opts: { gagalDi?: 'approved' | 'audit' } = {}) {
    const tx = {
      rankingResult: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };
    const prisma = {
      periodeProgram: {
        findUnique: jest.fn().mockResolvedValue({ id: periodeId, status: 'alokasi', kuotaPenerima: 3, totalAlokasi: 1500 }),
      },
      rankingResult: { updateMany: jest.fn() },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const periodeProgramService = {
      updateStatus: jest.fn(async (_id: string, status: string) => {
        if (opts.gagalDi === 'approved' && status === 'approved') throw new Error('gagal di tengah');
        return { status };
      }),
    };
    const audit = {
      log: jest.fn(async () => {
        if (opts.gagalDi === 'audit') throw new Error('audit gagal');
      }),
    };
    const service = new MiningService(
      prisma as any,
      audit as any,
      {} as any,
      {} as any,
      {} as any,
      periodeProgramService as any,
    );
    return { service, prisma, tx, periodeProgramService, audit };
  }

  it('semua penulisan memakai client transaksi yang sama', async () => {
    const { service, prisma, tx, periodeProgramService, audit } = siapkan();
    await service.finalizeRanking(periodeId, actor, 'disahkan');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.rankingResult.updateMany).toHaveBeenCalledWith({
      where: { periodeId, status: 'draft' },
      data: { status: 'final' },
    });
    expect(prisma.rankingResult.updateMany).not.toHaveBeenCalled();
    expect(periodeProgramService.updateStatus.mock.calls).toEqual([
      [periodeId, 'reviewed', actor, tx],
      [periodeId, 'approved', actor, tx],
    ]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'finalize_ranking' }), tx);
  });

  it.each(['approved', 'audit'] as const)('galat di langkah %s menggagalkan transaksi', async (gagalDi) => {
    const { service, prisma } = siapkan({ gagalDi });
    await expect(service.finalizeRanking(periodeId, actor, 'disahkan')).rejects.toThrow();
    // $transaction menerima promise yang reject → Prisma me-rollback seluruh isinya.
    await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow();
  });
});
