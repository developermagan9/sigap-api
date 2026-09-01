import { Injectable } from '@nestjs/common';

export interface KandidatAlokasi {
  id: string;
  nikKkHash: string;
  peringkatCluster: number;
  labelCluster: string;
  skor: number;
  pendapatanPerKapita: number;
  jumlahTanggungan: number;
}

export interface HasilAlokasi {
  urutan: KandidatAlokasi[];
  terpilih: Set<string>;
  amount: Map<string, number>;
  kuotaPenerima: number;
  anggaranEfektif: number;
  totalAlokasi: number;
  sisaAnggaran: number;
  cutoff: {
    rankTerakhirTerpilih: number;
    skorTerakhirTerpilih: number;
    skorPertamaTidakTerpilih: number | null;
    selisih: number | null;
  };
}

export interface Invarian {
  nama: string;
  lolos: boolean;
  detail: string;
}

@Injectable()
export class AlokasiService {
  urutanGlobal(kandidat: KandidatAlokasi[]): KandidatAlokasi[] {
    return [...kandidat].sort((a, b) => {
      if (a.peringkatCluster !== b.peringkatCluster) return a.peringkatCluster - b.peringkatCluster;
      if (a.skor !== b.skor) return b.skor - a.skor;
      if (a.pendapatanPerKapita !== b.pendapatanPerKapita) return a.pendapatanPerKapita - b.pendapatanPerKapita;
      if (a.jumlahTanggungan !== b.jumlahTanggungan) return b.jumlahTanggungan - a.jumlahTanggungan;
      return a.nikKkHash.localeCompare(b.nikKkHash);
    });
  }

  alokasiFlat(
    kandidat: KandidatAlokasi[],
    anggaranTotal: number,
    nominalDasar: number,
    biayaOperasional: number,
  ): HasilAlokasi {
    const anggaranEfektif = anggaranTotal - biayaOperasional;
    const kuotaPenerima = nominalDasar > 0 ? Math.floor(anggaranEfektif / nominalDasar) : 0;
    
    const urutan = this.urutanGlobal(kandidat);
    const terpilih = new Set<string>();
    const amount = new Map<string, number>();

    const actualKuota = Math.min(kuotaPenerima, urutan.length);
    let totalAlokasi = 0;

    for (let i = 0; i < actualKuota; i++) {
      const k = urutan[i];
      terpilih.add(k.id);
      amount.set(k.id, nominalDasar);
      totalAlokasi += nominalDasar;
    }

    const sisaAnggaran = anggaranEfektif - totalAlokasi;
    const cutoff = this.hitungCutoff(urutan, actualKuota);

    return {
      urutan,
      terpilih,
      amount,
      kuotaPenerima: actualKuota,
      anggaranEfektif,
      totalAlokasi,
      sisaAnggaran,
      cutoff,
    };
  }

  /**
   * Skema B `berjenjang` (05-Algorithm-Design.md §5.2-B): nominal berbeda per
   * tingkat cluster, kuota greedy menurut urutan global.
   *
   *   nominal_i = round_to(nominal_dasar x faktor_cluster[label(cluster_i)], 1000)
   *
   * Greedy-nya BERHENTI (bukan melewati) begitu sisa dana tidak cukup membiayai
   * KK berikutnya — melewati KK berperingkat lebih tinggi demi mencari KK yang
   * lebih murah akan merusak keadilan urutan (catatan eksplisit di §5.2-B).
   */
  alokasiBerjenjang(
    kandidat: KandidatAlokasi[],
    anggaranTotal: number,
    nominalDasar: number,
    biayaOperasional: number,
    faktorCluster: Record<string, number>,
    pembulatan = 1000,
  ): HasilAlokasi {
    const anggaranEfektif = anggaranTotal - biayaOperasional;
    const urutan = this.urutanGlobal(kandidat);
    const terpilih = new Set<string>();
    const amount = new Map<string, number>();

    const nominalUntuk = (k: KandidatAlokasi) => {
      // Faktor dicari per label cluster; cluster tanpa faktor eksplisit dianggap 1.0
      // (dapat nominal dasar) alih-alih 0 — 0 akan membuat leaf bernilai nol.
      const faktor = faktorCluster[k.labelCluster] ?? 1;
      return Math.round((nominalDasar * faktor) / pembulatan) * pembulatan;
    };

    let sisaDana = anggaranEfektif;
    let totalAlokasi = 0;

    for (let i = 0; i < urutan.length; i++) {
      const nominal = nominalUntuk(urutan[i]);
      if (nominal <= 0 || sisaDana < nominal) break;
      terpilih.add(urutan[i].id);
      amount.set(urutan[i].id, nominal);
      sisaDana -= nominal;
      totalAlokasi += nominal;
    }

    return {
      urutan,
      terpilih,
      amount,
      kuotaPenerima: terpilih.size,
      anggaranEfektif,
      totalAlokasi,
      sisaAnggaran: anggaranEfektif - totalAlokasi,
      cutoff: this.hitungCutoff(urutan, terpilih.size),
    };
  }

  /**
   * Skema C `proporsional` (05-Algorithm-Design.md §5.2-C, TIDAK direkomendasikan):
   *
   *   nominal_i = clamp(anggaran_efektif x C_i / sum(C), nominal_min, nominal_max)
   *
   * Dua hal yang dokumen sebut butuh penanganan tambahan, dan diselesaikan di sini:
   *
   * 1. **Berapa yang kebagian.** Rumus di atas tidak menyebut kuota. Di sini
   *    `nominal_dasar` berperan sebagai nominal RATA-RATA yang ditargetkan, jadi
   *    kuota = floor(anggaran_efektif / nominal_dasar) — sama dengan skema flat,
   *    supaya jumlah penerima tidak berubah drastis hanya karena ganti skema.
   *    Kalau `nominal_min` dipasang lebih tinggi dari `nominal_dasar`, pembaginya
   *    ikut naik ke `nominal_min`; batas itu yang menjamin clamp bawah tidak pernah
   *    membuat total melebihi pagu. Kandidat diambil dari urutan global (§5.3).
   *
   *    (Memakai `nominal_min` sebagai pembagi kuota terlihat wajar tapi merusak
   *    skemanya: kuota jadi maksimal, nominal rata-rata persis = nominal_min, dan
   *    clamp bawah menyeret hampir semua orang ke nominal yang sama — hasilnya
   *    tidak lagi proporsional terhadap skor.)
   * 2. **Iterasi penyeimbangan.** `clamp` membuat sum(nominal) tidak lagi sama dengan
   *    pagu. Dipakai water-filling: yang kena batas atas/bawah dikunci, sisanya
   *    dibagi ulang secara proporsional dari anggaran tersisa, sampai tidak ada lagi
   *    yang perlu dikunci. Nominal akhir dibulatkan KE BAWAH ke kelipatan 1000
   *    supaya total tidak pernah melewati pagu; selisihnya jadi sisa_anggaran.
   */
  alokasiProporsional(
    kandidat: KandidatAlokasi[],
    anggaranTotal: number,
    nominalDasar: number,
    biayaOperasional: number,
    nominalMin?: number,
    nominalMax?: number,
    pembulatan = 1000,
  ): HasilAlokasi {
    const anggaranEfektif = anggaranTotal - biayaOperasional;
    const min = nominalMin && nominalMin > 0 ? nominalMin : Math.round(nominalDasar * 0.5);
    const max = nominalMax && nominalMax > 0 ? nominalMax : Math.round(nominalDasar * 2);

    const urutan = this.urutanGlobal(kandidat);
    const terpilih = new Set<string>();
    const amount = new Map<string, number>();

    const pembagiKuota = Math.max(nominalDasar, min);
    const kuota = pembagiKuota > 0 ? Math.min(Math.floor(anggaranEfektif / pembagiKuota), urutan.length) : 0;
    const dipilih = urutan.slice(0, kuota);

    // ── Water-filling: kunci yang kena batas, bagi ulang sisanya ──
    const nominal = new Map<string, number>();
    let bebas = dipilih.slice();
    let anggaranBebas = anggaranEfektif;

    while (bebas.length > 0) {
      const sumSkor = bebas.reduce((s, k) => s + Math.max(k.skor, 0), 0);
      const berikutnya: KandidatAlokasi[] = [];
      let adaYangDikunci = false;

      for (const k of bebas) {
        // Skor total nol (semua alternatif identik) -> bagi rata di antara yang bebas.
        const bagian = sumSkor > 0 ? (anggaranBebas * Math.max(k.skor, 0)) / sumSkor : anggaranBebas / bebas.length;
        if (bagian > max) {
          nominal.set(k.id, max);
          anggaranBebas -= max;
          adaYangDikunci = true;
        } else if (bagian < min) {
          nominal.set(k.id, min);
          anggaranBebas -= min;
          adaYangDikunci = true;
        } else {
          berikutnya.push(k);
        }
      }

      if (!adaYangDikunci) {
        const sisaSum = berikutnya.reduce((s, k) => s + Math.max(k.skor, 0), 0);
        for (const k of berikutnya) {
          nominal.set(
            k.id,
            sisaSum > 0 ? (anggaranBebas * Math.max(k.skor, 0)) / sisaSum : anggaranBebas / berikutnya.length,
          );
        }
        break;
      }
      bebas = berikutnya;
    }

    let totalAlokasi = 0;
    for (const k of dipilih) {
      // Pembulatan ke bawah: menjamin sum(amount) <= anggaran_efektif apa pun hasil
      // iterasi di atas. Batas bawah ikut dibulatkan ke bawah supaya tidak melewati pagu.
      const kasar = nominal.get(k.id) ?? 0;
      const dibulatkan = Math.max(
        Math.floor(min / pembulatan) * pembulatan,
        Math.floor(kasar / pembulatan) * pembulatan,
      );
      if (dibulatkan <= 0) continue;
      terpilih.add(k.id);
      amount.set(k.id, dibulatkan);
      totalAlokasi += dibulatkan;
    }

    return {
      urutan,
      terpilih,
      amount,
      kuotaPenerima: terpilih.size,
      anggaranEfektif,
      totalAlokasi,
      sisaAnggaran: anggaranEfektif - totalAlokasi,
      cutoff: this.hitungCutoff(urutan, terpilih.size),
    };
  }

  /** Ringkasan batas seleksi: peringkat & skor penerima terakhir vs kandidat pertama yang tidak masuk. */
  private hitungCutoff(urutan: KandidatAlokasi[], jumlahTerpilih: number): HasilAlokasi['cutoff'] {
    const cutoff: HasilAlokasi['cutoff'] = {
      rankTerakhirTerpilih: 0,
      skorTerakhirTerpilih: 0,
      skorPertamaTidakTerpilih: null,
      selisih: null,
    };
    if (jumlahTerpilih <= 0) return cutoff;

    cutoff.rankTerakhirTerpilih = jumlahTerpilih;
    cutoff.skorTerakhirTerpilih = urutan[jumlahTerpilih - 1].skor;
    if (jumlahTerpilih < urutan.length) {
      cutoff.skorPertamaTidakTerpilih = urutan[jumlahTerpilih].skor;
      cutoff.selisih = cutoff.skorTerakhirTerpilih - cutoff.skorPertamaTidakTerpilih;
    }
    return cutoff;
  }

  periksaInvarian(
    hasil: HasilAlokasi,
    wallets: Map<string, string>,
  ): Invarian[] {
    const invarians: Invarian[] = [];

    // 1. sum(amount) == total_alokasi
    let sumAmount = 0;
    hasil.amount.forEach(val => sumAmount += val);
    invarians.push({
      nama: 'Total Alokasi Sesuai',
      lolos: sumAmount === hasil.totalAlokasi,
      detail: `Sum = ${sumAmount}, Total = ${hasil.totalAlokasi}`
    });

    // 2. total_alokasi <= anggaran_efektif
    invarians.push({
      nama: 'Batas Anggaran',
      lolos: hasil.totalAlokasi <= hasil.anggaranEfektif,
      detail: `Total = ${hasil.totalAlokasi}, Anggaran = ${hasil.anggaranEfektif}`
    });

    // 3. count(leaves) == kuota_penerima
    invarians.push({
      nama: 'Kuota Sesuai',
      lolos: hasil.terpilih.size === hasil.kuotaPenerima,
      detail: `Terpilih = ${hasil.terpilih.size}, Kuota = ${hasil.kuotaPenerima}`
    });

    // 4. All wallet addresses valid and unique for selected
    const usedWallets = new Set<string>();
    let walletsValid = true;
    let walletErrors: string[] = [];
    hasil.terpilih.forEach(id => {
      const w = wallets.get(id);
      if (!w) {
        walletsValid = false;
        walletErrors.push(`ID ${id} missing wallet`);
      } else if (usedWallets.has(w)) {
        walletsValid = false;
        walletErrors.push(`Wallet ${w} duplicated`);
      } else {
        usedWallets.add(w);
      }
    });
    invarians.push({
      nama: 'Integritas Wallet',
      lolos: walletsValid,
      detail: walletsValid ? 'OK' : walletErrors.join(', ')
    });

    // 5. Every amount > 0
    let amountsValid = true;
    hasil.amount.forEach(val => {
      if (val <= 0) amountsValid = false;
    });
    invarians.push({
      nama: 'Amount Positif',
      lolos: amountsValid && (hasil.kuotaPenerima === 0 || hasil.amount.size > 0),
      detail: amountsValid ? 'OK' : 'Terdapat amount <= 0'
    });

    return invarians;
  }
}
