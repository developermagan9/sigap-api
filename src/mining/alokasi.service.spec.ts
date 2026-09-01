import { AlokasiService, KandidatAlokasi } from './alokasi.service';

/**
 * Invarian alokasi anggaran dari 05-Algorithm-Design.md §5.3 (urutan global &
 * tie-break deterministik) dan §5.4 (invarian wajib sebelum on-chain).
 */
function kandidat(over: Partial<KandidatAlokasi> & { id: string }): KandidatAlokasi {
  return {
    nikKkHash: `hash-${over.id}`,
    peringkatCluster: 0,
    labelCluster: 'Sangat Rentan',
    skor: 0.5,
    pendapatanPerKapita: 500_000,
    jumlahTanggungan: 2,
    ...over,
  };
}

describe('AlokasiService', () => {
  let service: AlokasiService;

  beforeEach(() => {
    service = new AlokasiService();
  });

  describe('urutanGlobal — §5.3', () => {
    it('mendahulukan cluster lebih rentan SELURUHNYA sebelum cluster berikutnya', () => {
      const urut = service.urutanGlobal([
        kandidat({ id: 'b', peringkatCluster: 1, labelCluster: 'Rentan', skor: 0.99 }),
        kandidat({ id: 'a', peringkatCluster: 0, skor: 0.1 }),
      ]);
      // Skor 'b' jauh lebih tinggi, tapi clusternya lebih rendah prioritasnya.
      expect(urut.map((k) => k.id)).toEqual(['a', 'b']);
    });

    it('di dalam cluster: skor TOPSIS descending', () => {
      const urut = service.urutanGlobal([
        kandidat({ id: 'a', skor: 0.4 }),
        kandidat({ id: 'b', skor: 0.9 }),
        kandidat({ id: 'c', skor: 0.6 }),
      ]);
      expect(urut.map((k) => k.id)).toEqual(['b', 'c', 'a']);
    });

    it('tie-break 1: skor sama -> pendapatan per kapita ascending', () => {
      const urut = service.urutanGlobal([
        kandidat({ id: 'kaya', skor: 0.5, pendapatanPerKapita: 900_000 }),
        kandidat({ id: 'miskin', skor: 0.5, pendapatanPerKapita: 200_000 }),
      ]);
      expect(urut.map((k) => k.id)).toEqual(['miskin', 'kaya']);
    });

    it('tie-break 2: pendapatan sama -> jumlah tanggungan descending', () => {
      const urut = service.urutanGlobal([
        kandidat({ id: 'sedikit', skor: 0.5, jumlahTanggungan: 1 }),
        kandidat({ id: 'banyak', skor: 0.5, jumlahTanggungan: 6 }),
      ]);
      expect(urut.map((k) => k.id)).toEqual(['banyak', 'sedikit']);
    });

    it('tie-break 3: semua sama -> nik_kk_hash ascending, BUKAN urutan input', () => {
      const a = kandidat({ id: 'a', nikKkHash: 'zzz' });
      const b = kandidat({ id: 'b', nikKkHash: 'aaa' });
      // Urutan input dibalik: hasilnya harus tetap sama (tidak bergantung siapa didaftarkan duluan).
      expect(service.urutanGlobal([a, b]).map((k) => k.id)).toEqual(['b', 'a']);
      expect(service.urutanGlobal([b, a]).map((k) => k.id)).toEqual(['b', 'a']);
    });

    it('deterministik: dipanggil berulang pada data sama -> urutan identik', () => {
      const data = [
        kandidat({ id: 'a', skor: 0.5 }),
        kandidat({ id: 'b', skor: 0.5 }),
        kandidat({ id: 'c', skor: 0.7, peringkatCluster: 1, labelCluster: 'Rentan' }),
        kandidat({ id: 'd', skor: 0.2 }),
      ];
      const pertama = service.urutanGlobal(data).map((k) => k.id);
      for (let i = 0; i < 5; i++) {
        expect(service.urutanGlobal(data).map((k) => k.id)).toEqual(pertama);
      }
    });

    it('tidak memutasi array input', () => {
      const data = [kandidat({ id: 'a', skor: 0.1 }), kandidat({ id: 'b', skor: 0.9 })];
      service.urutanGlobal(data);
      expect(data.map((k) => k.id)).toEqual(['a', 'b']);
    });
  });

  describe('alokasiFlat — §5.2-A', () => {
    const lima = [
      kandidat({ id: 'a', skor: 0.9 }),
      kandidat({ id: 'b', skor: 0.8 }),
      kandidat({ id: 'c', skor: 0.7 }),
      kandidat({ id: 'd', skor: 0.6 }),
      kandidat({ id: 'e', skor: 0.5 }),
    ];

    it('kuota = floor(anggaran_efektif / nominal_dasar) dan memilih dari peringkat teratas', () => {
      // 1.700.000 - 200.000 = 1.500.000 efektif -> kuota 3 x 500.000
      const hasil = service.alokasiFlat(lima, 1_700_000, 500_000, 200_000);
      expect(hasil.anggaranEfektif).toBe(1_500_000);
      expect(hasil.kuotaPenerima).toBe(3);
      expect([...hasil.terpilih].sort()).toEqual(['a', 'b', 'c']);
      expect(hasil.totalAlokasi).toBe(1_500_000);
      expect(hasil.sisaAnggaran).toBe(0);
    });

    it('kuota lebih besar dari jumlah kandidat -> semua kebagian, sisanya jadi carry-over (§5.5)', () => {
      const hasil = service.alokasiFlat(lima, 10_000_000, 500_000, 0);
      expect(hasil.kuotaPenerima).toBe(5);
      expect(hasil.totalAlokasi).toBe(2_500_000);
      expect(hasil.sisaAnggaran).toBe(7_500_000);
    });

    it('cutoff mencatat skor penerima terakhir dan kandidat pertama yang tidak masuk', () => {
      const hasil = service.alokasiFlat(lima, 1_500_000, 500_000, 0);
      expect(hasil.cutoff.rankTerakhirTerpilih).toBe(3);
      expect(hasil.cutoff.skorTerakhirTerpilih).toBeCloseTo(0.7, 10);
      expect(hasil.cutoff.skorPertamaTidakTerpilih).toBeCloseTo(0.6, 10);
      expect(hasil.cutoff.selisih).toBeCloseTo(0.1, 10);
    });

    it('anggaran tidak cukup untuk siapa pun -> nol penerima, bukan error', () => {
      const hasil = service.alokasiFlat(lima, 100_000, 500_000, 0);
      expect(hasil.kuotaPenerima).toBe(0);
      expect(hasil.totalAlokasi).toBe(0);
      expect(hasil.cutoff.rankTerakhirTerpilih).toBe(0);
    });

    it('memenuhi seluruh invarian §5.4', () => {
      const hasil = service.alokasiFlat(lima, 1_700_000, 500_000, 200_000);
      const wallets = new Map([...hasil.terpilih].map((id, i) => [id, `0x${String(i).padStart(40, '0')}`]));
      for (const inv of service.periksaInvarian(hasil, wallets)) {
        expect(inv.lolos).toBe(true);
      }
    });

    it('invarian gagal jelas kalau ada wallet duplikat', () => {
      const hasil = service.alokasiFlat(lima, 1_500_000, 500_000, 0);
      const sama = new Map([...hasil.terpilih].map((id) => [id, '0xduplikat']));
      const invarian = service.periksaInvarian(hasil, sama);
      expect(invarian.find((i) => i.nama === 'Integritas Wallet')?.lolos).toBe(false);
    });
  });

  describe('alokasiBerjenjang — §5.2-B', () => {
    const faktor = { 'Sangat Rentan': 1.25, Rentan: 1.0 };
    const campuran = [
      kandidat({ id: 'sr1', skor: 0.9 }),
      kandidat({ id: 'sr2', skor: 0.8 }),
      kandidat({ id: 'r1', peringkatCluster: 1, labelCluster: 'Rentan', skor: 0.95 }),
      kandidat({ id: 'r2', peringkatCluster: 1, labelCluster: 'Rentan', skor: 0.85 }),
    ];

    it('nominal mengikuti faktor cluster, dibulatkan ke kelipatan 1000', () => {
      const hasil = service.alokasiBerjenjang(campuran, 10_000_000, 500_000, 0, faktor);
      expect(hasil.amount.get('sr1')).toBe(625_000);
      expect(hasil.amount.get('r1')).toBe(500_000);
      expect(hasil.totalAlokasi).toBe(625_000 * 2 + 500_000 * 2);
    });

    it('greedy BERHENTI saat dana kurang, tidak melewati untuk cari yang lebih murah', () => {
      // Cukup untuk 2 x 625.000 = 1.250.000, sisa 100.000 tidak cukup untuk siapa pun.
      const hasil = service.alokasiBerjenjang(campuran, 1_350_000, 500_000, 0, faktor);
      expect([...hasil.terpilih].sort()).toEqual(['sr1', 'sr2']);
      // 'r1' bernominal lebih murah (500.000) tapi TIDAK boleh menyalip.
      expect(hasil.terpilih.has('r1')).toBe(false);
      expect(hasil.sisaAnggaran).toBe(100_000);
    });

    it('label cluster tanpa faktor eksplisit dapat nominal dasar (faktor 1.0), bukan nol', () => {
      const hasil = service.alokasiBerjenjang(campuran, 10_000_000, 500_000, 0, { 'Sangat Rentan': 1.25 });
      expect(hasil.amount.get('r1')).toBe(500_000);
    });

    it('total alokasi tidak pernah melebihi anggaran efektif', () => {
      const hasil = service.alokasiBerjenjang(campuran, 2_000_000, 500_000, 500_000, faktor);
      expect(hasil.totalAlokasi).toBeLessThanOrEqual(hasil.anggaranEfektif);
    });

    it('memenuhi invarian §5.4', () => {
      const hasil = service.alokasiBerjenjang(campuran, 10_000_000, 500_000, 0, faktor);
      const wallets = new Map([...hasil.terpilih].map((id, i) => [id, `0x${String(i).padStart(40, '0')}`]));
      for (const inv of service.periksaInvarian(hasil, wallets)) {
        expect(inv.lolos).toBe(true);
      }
    });
  });

  describe('alokasiProporsional — §5.2-C', () => {
    const empat = [
      kandidat({ id: 'a', skor: 0.9 }),
      kandidat({ id: 'b', skor: 0.6 }),
      kandidat({ id: 'c', skor: 0.3 }),
      kandidat({ id: 'd', skor: 0.2 }),
    ];

    it('nominal sebanding skor: skor lebih tinggi tidak pernah dapat lebih kecil', () => {
      const hasil = service.alokasiProporsional(empat, 4_000_000, 500_000, 0, 100_000, 2_000_000);
      const a = hasil.amount.get('a')!;
      const b = hasil.amount.get('b')!;
      const c = hasil.amount.get('c')!;
      expect(a).toBeGreaterThanOrEqual(b);
      expect(b).toBeGreaterThanOrEqual(c);
    });

    it('setiap nominal berada di dalam [nominal_min, nominal_max]', () => {
      const min = 200_000;
      const max = 800_000;
      const hasil = service.alokasiProporsional(empat, 4_000_000, 500_000, 0, min, max);
      hasil.amount.forEach((v) => {
        expect(v).toBeGreaterThanOrEqual(min);
        expect(v).toBeLessThanOrEqual(max);
      });
    });

    it('total alokasi tidak pernah melebihi anggaran efektif (setelah water-filling + pembulatan)', () => {
      for (const anggaran of [1_000_000, 2_345_678, 4_000_000, 10_000_000]) {
        const hasil = service.alokasiProporsional(empat, anggaran, 500_000, 0, 200_000, 800_000);
        expect(hasil.totalAlokasi).toBeLessThanOrEqual(hasil.anggaranEfektif);
      }
    });

    it('semua nominal kelipatan 1000 (tidak ada angka ganjil yang sulit dijelaskan)', () => {
      const hasil = service.alokasiProporsional(empat, 3_333_333, 500_000, 0);
      hasil.amount.forEach((v) => expect(v % 1000).toBe(0));
    });

    it('kuota mengikuti nominal_dasar sebagai nominal rata-rata, sama seperti flat', () => {
      // 2.000.000 / 500.000 -> 4 penerima; nominal rata-ratanya 500.000.
      const hasil = service.alokasiProporsional(empat, 2_000_000, 500_000, 0, 200_000, 800_000);
      expect(hasil.kuotaPenerima).toBe(4);
      expect(hasil.totalAlokasi / hasil.kuotaPenerima).toBeLessThanOrEqual(500_000);
    });

    it('nominal_min lebih tinggi dari nominal_dasar tetap membatasi kuota', () => {
      // min 700.000 > dasar 500.000 -> pembagi kuota ikut naik: 2.000.000 / 700.000 = 2.
      const hasil = service.alokasiProporsional(empat, 2_000_000, 500_000, 0, 700_000, 900_000);
      expect(hasil.kuotaPenerima).toBe(2);
      expect(hasil.totalAlokasi).toBeLessThanOrEqual(hasil.anggaranEfektif);
    });

    it('anggaran kecil membatasi jumlah penerima', () => {
      const hasil = service.alokasiProporsional(empat, 500_000, 500_000, 0, 200_000, 800_000);
      expect(hasil.kuotaPenerima).toBe(1);
      expect([...hasil.terpilih]).toEqual(['a']);
    });

    it('nominal benar-benar berbeda antar penerima ketika skornya berbeda', () => {
      const hasil = service.alokasiProporsional(empat, 2_000_000, 500_000, 0, 100_000, 2_000_000);
      expect(new Set(hasil.amount.values()).size).toBeGreaterThan(1);
      expect(hasil.amount.get('a')!).toBeGreaterThan(hasil.amount.get('d')!);
    });

    it('skor identik -> nominal terbagi rata', () => {
      const sama = ['a', 'b', 'c', 'd'].map((id) => kandidat({ id, skor: 0.5 }));
      const hasil = service.alokasiProporsional(sama, 4_000_000, 500_000, 0, 100_000, 2_000_000);
      const nilai = [...hasil.amount.values()];
      expect(new Set(nilai).size).toBe(1);
    });

    it('memenuhi invarian §5.4', () => {
      const hasil = service.alokasiProporsional(empat, 4_000_000, 500_000, 0, 200_000, 800_000);
      const wallets = new Map([...hasil.terpilih].map((id, i) => [id, `0x${String(i).padStart(40, '0')}`]));
      for (const inv of service.periksaInvarian(hasil, wallets)) {
        expect(inv.lolos).toBe(true);
      }
    });
  });
});
