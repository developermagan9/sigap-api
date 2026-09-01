import { KMeansService } from './kmeans.service';

/**
 * Fokus test ini: sifat yang dipegang alur produksi — determinisme (hasil re-run
 * harus identik supaya Merkle root bisa direproduksi auditor, §5.3) dan silhouette
 * sebagai validasi pemilihan k (§3.2).
 */
describe('KMeansService', () => {
  let service: KMeansService;

  beforeEach(() => {
    service = new KMeansService();
  });

  /** Tiga gumpalan yang terpisah jelas — silhouette-nya harus tinggi. */
  const terpisahJelas = [
    [0, 0], [0.2, 0.1], [0.1, 0.3],
    [10, 10], [10.2, 10.1], [9.9, 10.3],
    [20, 0], [20.1, 0.2], [19.8, 0.1],
  ];

  describe('standardize', () => {
    it('menghasilkan mean 0 dan std 1 per kolom', () => {
      const { Xstd } = service.standardize([[1, 10], [2, 20], [3, 30], [4, 40]]);
      for (let j = 0; j < 2; j++) {
        const kolom = Xstd.map((r) => r[j]);
        const mean = kolom.reduce((a, b) => a + b, 0) / kolom.length;
        const std = Math.sqrt(kolom.reduce((s, v) => s + (v - mean) ** 2, 0) / kolom.length);
        expect(Math.abs(mean)).toBeLessThan(1e-12);
        expect(Math.abs(std - 1)).toBeLessThan(1e-12);
      }
    });

    it('kolom konstan tidak menghasilkan NaN (std 0 diganti 1)', () => {
      const { Xstd } = service.standardize([[5, 1], [5, 2], [5, 3]]);
      expect(Xstd.every((r) => r.every((v) => Number.isFinite(v)))).toBe(true);
    });
  });

  describe('run', () => {
    it('deterministik: seed sama -> assignment & SSE identik', () => {
      const a = service.run(terpisahJelas, 3);
      const b = service.run(terpisahJelas, 3);
      expect(a.assignments).toEqual(b.assignments);
      expect(a.sse).toBeCloseTo(b.sse, 12);
    });

    it('menemukan tiga gumpalan yang memang terpisah', () => {
      const { assignments } = service.run(terpisahJelas, 3);
      // Tiga titik pertama satu cluster, tiga berikutnya satu, tiga terakhir satu.
      expect(new Set(assignments.slice(0, 3)).size).toBe(1);
      expect(new Set(assignments.slice(3, 6)).size).toBe(1);
      expect(new Set(assignments.slice(6, 9)).size).toBe(1);
      expect(new Set(assignments).size).toBe(3);
    });

    it('data kosong / k tidak valid tidak melempar error', () => {
      expect(service.run([], 3).assignments).toEqual([]);
      expect(service.run(terpisahJelas, 0).assignments).toEqual([]);
    });
  });

  describe('labelByIncome — §3.3', () => {
    it('mengurutkan cluster dari centroid pendapatan terendah ke tertinggi', () => {
      // mapping[peringkat] = index cluster asli
      const mapping = service.labelByIncome([[5, 0], [-2, 0], [1, 0]], 0);
      expect(mapping).toEqual([1, 2, 0]);
    });
  });

  describe('silhouette — §3.2', () => {
    it('cluster yang terpisah jelas menghasilkan skor mendekati 1', () => {
      const { assignments } = service.run(terpisahJelas, 3);
      const skor = service.silhouette(terpisahJelas, assignments);
      expect(skor).toBeGreaterThan(0.8);
      expect(skor).toBeLessThanOrEqual(1);
    });

    it('cluster yang tumpang tindih menghasilkan skor jauh lebih rendah', () => {
      // Satu awan titik tunggal dipecah paksa jadi 3 — tidak ada pemisahan nyata.
      const satuAwan = Array.from({ length: 30 }, (_, i) => [Math.sin(i) * 0.5, Math.cos(i) * 0.5]);
      const { assignments } = service.run(satuAwan, 3);
      const tumpangTindih = service.silhouette(satuAwan, assignments);

      const { assignments: rapi } = service.run(terpisahJelas, 3);
      const jelas = service.silhouette(terpisahJelas, rapi);

      expect(tumpangTindih).toBeLessThan(jelas);
    });

    it('selalu berada di rentang [-1, 1]', () => {
      for (const k of [2, 3, 4]) {
        const { assignments } = service.run(terpisahJelas, k);
        const skor = service.silhouette(terpisahJelas, assignments);
        expect(skor).toBeGreaterThanOrEqual(-1);
        expect(skor).toBeLessThanOrEqual(1);
      }
    });

    it('deterministik pada data yang sama', () => {
      const { assignments } = service.run(terpisahJelas, 3);
      expect(service.silhouette(terpisahJelas, assignments)).toBe(
        service.silhouette(terpisahJelas, assignments),
      );
    });

    it('satu cluster saja -> 0 (tidak terdefinisi, bukan NaN)', () => {
      expect(service.silhouette(terpisahJelas, new Array(9).fill(0))).toBe(0);
    });

    it('data terlalu sedikit -> 0', () => {
      expect(service.silhouette([[1, 1]], [0])).toBe(0);
    });
  });

  describe('elbow', () => {
    it('SSE menurun monoton seiring k bertambah', () => {
      const hasil = service.elbow(terpisahJelas, 5);
      expect(hasil).toHaveLength(5);
      for (let i = 1; i < hasil.length; i++) {
        expect(hasil[i].sse).toBeLessThanOrEqual(hasil[i - 1].sse + 1e-9);
      }
    });
  });
});
