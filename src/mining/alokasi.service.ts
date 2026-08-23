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

    let cutoff = {
      rankTerakhirTerpilih: 0,
      skorTerakhirTerpilih: 0,
      skorPertamaTidakTerpilih: null as number | null,
      selisih: null as number | null,
    };

    if (actualKuota > 0) {
      cutoff.rankTerakhirTerpilih = actualKuota;
      cutoff.skorTerakhirTerpilih = urutan[actualKuota - 1].skor;
      
      if (actualKuota < urutan.length) {
        cutoff.skorPertamaTidakTerpilih = urutan[actualKuota].skor;
        cutoff.selisih = cutoff.skorTerakhirTerpilih - cutoff.skorPertamaTidakTerpilih;
      }
    }

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
