import { Injectable, Logger } from '@nestjs/common';

export interface KriteriaSpec {
  key: string;
  label: string;
  benefit: boolean;
}

export interface BreakdownItem {
  nilaiAsli: number;
  terbobot: number;
  kontribusi: number;
  kesenjangan: number;
}

export interface TopsisRow {
  index: number;
  skor: number;
  dPlus: number;
  dMinus: number;
  breakdown: Record<string, BreakdownItem>;
}

@Injectable()
export class TopsisService {
  private readonly logger = new Logger(TopsisService.name);

  calculate(
    matrix: number[][],
    kriteria: KriteriaSpec[],
    bobot: Record<string, number>,
  ): TopsisRow[] {
    if (matrix.length === 0) return [];
    
    // Normalization and ideal solutions
    const numCols = kriteria.length;
    const numRows = matrix.length;
    
    // Check single row edge case
    // Cluster prioritas berisi 1 KK (edge case §4.5): TOPSIS pada n=1 selalu
    // menghasilkan C = 0.5; lewati perhitungan, tapi tetap penuhi invarian Σ = 1
    // dengan komposisi rata supaya konsumen breakdown tidak perlu kasus khusus.
    if (numRows === 1) {
      const rata = numCols > 0 ? 1 / numCols : 0;
      const breakdown: Record<string, BreakdownItem> = {};
      for (let j = 0; j < numCols; j++) {
        breakdown[kriteria[j].key] = {
          nilaiAsli: matrix[0][j],
          terbobot: 0,
          kontribusi: rata,
          kesenjangan: rata,
        };
      }
      return [{ index: 0, skor: 0.5, dPlus: 0, dMinus: 0, breakdown }];
    }

    const norms = new Array(numCols).fill(0);
    for (let j = 0; j < numCols; j++) {
      let sumSq = 0;
      for (let i = 0; i < numRows; i++) {
        sumSq += Math.pow(matrix[i][j], 2);
      }
      norms[j] = Math.sqrt(sumSq);
      if (norms[j] === 0) {
        this.logger.warn(`Zero-norm column detected: ${kriteria[j].key}`);
        norms[j] = 1; // prevent div by zero
      }
    }

    // Weighted normalization
    const v = Array.from({ length: numRows }, () => new Array(numCols).fill(0));
    for (let i = 0; i < numRows; i++) {
      for (let j = 0; j < numCols; j++) {
        const w = bobot[kriteria[j].key] || 1;
        v[i][j] = (matrix[i][j] / norms[j]) * w;
      }
    }

    // Ideal positive and negative
    const aPlus = new Array(numCols).fill(0);
    const aMinus = new Array(numCols).fill(0);
    
    for (let j = 0; j < numCols; j++) {
      let colVals = v.map(row => row[j]);
      let maxVal = Math.max(...colVals);
      let minVal = Math.min(...colVals);
      
      if (kriteria[j].benefit) {
        aPlus[j] = maxVal;
        aMinus[j] = minVal;
      } else {
        aPlus[j] = minVal;
        aMinus[j] = maxVal;
      }
    }

    // Distances
    const dPlusArr = new Array(numRows).fill(0);
    const dMinusArr = new Array(numRows).fill(0);
    for (let i = 0; i < numRows; i++) {
      let sumPlus = 0;
      let sumMinus = 0;
      for (let j = 0; j < numCols; j++) {
        sumPlus += Math.pow(v[i][j] - aPlus[j], 2);
        sumMinus += Math.pow(v[i][j] - aMinus[j], 2);
      }
      dPlusArr[i] = Math.sqrt(sumPlus);
      dMinusArr[i] = Math.sqrt(sumMinus);
    }

    // Explanations (kontribusi and kesenjangan)
    const sumKontribusi = new Array(numRows).fill(0);
    const sumKesenjangan = new Array(numRows).fill(0);
    const rawKontribusi = Array.from({ length: numRows }, () => new Array(numCols).fill(0));
    const rawKesenjangan = Array.from({ length: numRows }, () => new Array(numCols).fill(0));

    for (let i = 0; i < numRows; i++) {
      for (let j = 0; j < numCols; j++) {
        rawKontribusi[i][j] = Math.pow(v[i][j] - aMinus[j], 2);
        rawKesenjangan[i][j] = Math.pow(v[i][j] - aPlus[j], 2);
        sumKontribusi[i] += rawKontribusi[i][j];
        sumKesenjangan[i] += rawKesenjangan[i][j];
      }
    }

    const rows: TopsisRow[] = [];
    for (let i = 0; i < numRows; i++) {
      let dPlus = dPlusArr[i];
      let dMinus = dMinusArr[i];
      let skor = dMinus / (dPlus + dMinus);
      if (isNaN(skor) || (dPlus + dMinus === 0)) skor = 0.5;

      // Invarian 05-Algorithm-Design.md §4.4: Σ_j kontribusi_ij = Σ_j kesenjangan_ij = 1.
      //
      // Pembaginya bisa nol kalau baris ini PERSIS sama dengan solusi ideal negatif
      // (D⁻ = 0, alternatif paling tidak prioritas) atau ideal positif (D⁺ = 0).
      // Komposisi vektor nol tidak terdefinisi secara matematis, jadi dipakai
      // pembagian rata 1/m — artinya "tidak ada satu kriteria pun yang membedakan
      // rumah tangga ini dari kondisi acuan". Mengembalikan 0 akan melanggar
      // invarian Σ = 1 dan membuat stacked bar di dashboard tampil kosong.
      const rata = 1 / numCols;
      const breakdown: Record<string, BreakdownItem> = {};
      for (let j = 0; j < numCols; j++) {
        breakdown[kriteria[j].key] = {
          nilaiAsli: matrix[i][j],
          terbobot: v[i][j],
          kontribusi: sumKontribusi[i] === 0 ? rata : rawKontribusi[i][j] / sumKontribusi[i],
          kesenjangan: sumKesenjangan[i] === 0 ? rata : rawKesenjangan[i][j] / sumKesenjangan[i],
        };
      }

      rows.push({
        index: i,
        skor,
        dPlus,
        dMinus,
        breakdown,
      });
    }

    return rows.sort((a, b) => b.skor - a.skor);
  }
}
