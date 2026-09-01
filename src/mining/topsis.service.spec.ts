import { TopsisService, KriteriaSpec } from './topsis.service';

/**
 * Invarian TOPSIS dari 05-Algorithm-Design.md §4.4:
 * Σ_j kontribusi_ij = 1 dan Σ_j kesenjangan_ij = 1 untuk tiap alternatif,
 * dengan toleransi 1e-9 (angka toleransi disebut eksplisit di dokumen).
 */
const KRITERIA: KriteriaSpec[] = [
  { key: 'pendapatanPerKapita', label: 'Pendapatan per kapita', benefit: false },
  { key: 'jumlahTanggungan', label: 'Jumlah tanggungan', benefit: true },
  { key: 'jumlahDisabilitasLansia', label: 'Disabilitas / lansia', benefit: true },
  { key: 'skorKondisiRumah', label: 'Kondisi rumah', benefit: false },
];

const BOBOT = {
  pendapatanPerKapita: 0.35,
  jumlahTanggungan: 0.25,
  jumlahDisabilitasLansia: 0.2,
  skorKondisiRumah: 0.2,
};

const TOLERANSI = 1e-9;

describe('TopsisService', () => {
  let service: TopsisService;

  beforeEach(() => {
    service = new TopsisService();
  });

  const matrixContoh = [
    [400_000, 5, 1, 2],
    [600_000, 3, 0, 3],
    [350_000, 4, 2, 1],
    [800_000, 2, 0, 4],
    [450_000, 6, 1, 2],
  ];

  it('Σ kontribusi per individu = 1 (toleransi 1e-9)', () => {
    const rows = service.calculate(matrixContoh, KRITERIA, BOBOT);
    expect(rows).toHaveLength(matrixContoh.length);

    for (const row of rows) {
      const total = Object.values(row.breakdown).reduce((s, b) => s + b.kontribusi, 0);
      expect(Math.abs(total - 1)).toBeLessThan(TOLERANSI);
    }
  });

  it('Σ kesenjangan per individu = 1 (toleransi 1e-9)', () => {
    const rows = service.calculate(matrixContoh, KRITERIA, BOBOT);
    for (const row of rows) {
      const total = Object.values(row.breakdown).reduce((s, b) => s + b.kesenjangan, 0);
      expect(Math.abs(total - 1)).toBeLessThan(TOLERANSI);
    }
  });

  it('skor selalu berada di rentang [0, 1] dan terurut menurun', () => {
    const rows = service.calculate(matrixContoh, KRITERIA, BOBOT);
    for (const row of rows) {
      expect(row.skor).toBeGreaterThanOrEqual(0);
      expect(row.skor).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].skor).toBeGreaterThanOrEqual(rows[i].skor);
    }
  });

  it('memprioritaskan pendapatan rendah + tanggungan banyak (§4.3)', () => {
    // Baris 2 (350rb, 4 tanggungan, 2 disabilitas, kondisi rumah 1) paling rentan
    // di semua kriteria; baris 3 (800rb, 2, 0, 4) paling tidak rentan.
    const rows = service.calculate(matrixContoh, KRITERIA, BOBOT);
    expect(rows[0].index).toBe(2);
    expect(rows[rows.length - 1].index).toBe(3);
  });

  it('deterministik: input sama menghasilkan skor identik', () => {
    const a = service.calculate(matrixContoh, KRITERIA, BOBOT);
    const b = service.calculate(matrixContoh, KRITERIA, BOBOT);
    expect(a.map((r) => [r.index, r.skor])).toEqual(b.map((r) => [r.index, r.skor]));
  });

  it('n = 1: skor netral 0.5 tanpa NaN (edge case §4.5)', () => {
    const rows = service.calculate([[500_000, 3, 1, 2]], KRITERIA, BOBOT);
    expect(rows).toHaveLength(1);
    expect(rows[0].skor).toBe(0.5);
    expect(Number.isNaN(rows[0].skor)).toBe(false);
  });

  it('semua alternatif identik: skor 0.5, bukan NaN (edge case §4.5)', () => {
    const identik = [
      [500_000, 3, 1, 2],
      [500_000, 3, 1, 2],
      [500_000, 3, 1, 2],
    ];
    const rows = service.calculate(identik, KRITERIA, BOBOT);
    for (const row of rows) {
      expect(row.skor).toBe(0.5);
      expect(Number.isNaN(row.skor)).toBe(false);
    }
  });

  it('kolom bernorm nol tidak menghasilkan NaN (edge case §4.5)', () => {
    // Kolom disabilitas/lansia semuanya 0 -> norm kolom = 0.
    const adaKolomNol = [
      [400_000, 5, 0, 2],
      [600_000, 3, 0, 3],
      [350_000, 4, 0, 1],
    ];
    const rows = service.calculate(adaKolomNol, KRITERIA, BOBOT);
    for (const row of rows) {
      expect(Number.isNaN(row.skor)).toBe(false);
      for (const b of Object.values(row.breakdown)) {
        expect(Number.isNaN(b.kontribusi)).toBe(false);
        expect(Number.isNaN(b.kesenjangan)).toBe(false);
      }
    }
  });

  it('matriks kosong menghasilkan array kosong, bukan lempar error', () => {
    expect(service.calculate([], KRITERIA, BOBOT)).toEqual([]);
  });
});
