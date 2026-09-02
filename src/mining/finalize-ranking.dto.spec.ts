import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { FinalizeRankingDto } from './dto/mining.dto';

/**
 * Regression test untuk temuan 2026-09-02 #6: `approvedBy` cuma divalidasi
 * `@IsString()`, jadi username (mis. `"admin"`) lolos validasi lalu meledak
 * jauh di dalam `finalizeRanking()` — tepatnya saat `audit.log()` menulis
 * `actorId` ke kolom UUID. Yang bikin runyam: transisi status
 * `alokasi -> reviewed` sudah ter-commit sebelum error itu terjadi, jadi API
 * melaporkan 500 padahal state DB sudah berubah (non-atomic).
 *
 * Nilai salah harus ditolak di lapisan validasi (`400`), sebelum menyentuh DB.
 */
describe('FinalizeRankingDto', () => {
  const buat = (approvedBy: unknown) =>
    validateSync(
      plainToInstance(FinalizeRankingDto, { approvedBy, catatan: 'disahkan' }),
    );

  it('menerima UUID', () => {
    expect(buat('f3358fc2-9050-4ceb-8e2d-e24530e81a99')).toHaveLength(0);
  });

  it('menolak username — kasus yang dulu jadi 500 setelah status terlanjur berubah', () => {
    const errors = buat('admin');
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('approvedBy');
    expect(errors[0].constraints).toHaveProperty('isUuid');
  });

  it('menolak string kosong dan nilai non-string', () => {
    expect(buat('').length).toBeGreaterThan(0);
    expect(buat(123).length).toBeGreaterThan(0);
    expect(buat(undefined).length).toBeGreaterThan(0);
  });

  it('tetap mewajibkan catatan berupa string', () => {
    const errors = validateSync(
      plainToInstance(FinalizeRankingDto, {
        approvedBy: 'f3358fc2-9050-4ceb-8e2d-e24530e81a99',
        catatan: 42,
      }),
    );
    expect(errors.map((e) => e.property)).toContain('catatan');
  });
});
