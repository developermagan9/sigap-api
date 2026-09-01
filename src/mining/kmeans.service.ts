import { Injectable } from '@nestjs/common';

export interface KMeansResult {
  assignments: number[];
  centroids: number[][];
  sse: number;
  iterations: number;
}

export const LABEL_KERENTANAN = ['Sangat Rentan', 'Rentan', 'Cukup Mampu', 'Mampu'] as const;

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

@Injectable()
export class KMeansService {
  standardize(X: number[][]): { Xstd: number[][]; means: number[]; stds: number[] } {
    if (X.length === 0) return { Xstd: [], means: [], stds: [] };
    const numCols = X[0].length;
    const means = new Array(numCols).fill(0);
    const stds = new Array(numCols).fill(0);

    for (let j = 0; j < numCols; j++) {
      let sum = 0;
      for (let i = 0; i < X.length; i++) {
        sum += X[i][j];
      }
      means[j] = sum / X.length;

      let sqSum = 0;
      for (let i = 0; i < X.length; i++) {
        sqSum += Math.pow(X[i][j] - means[j], 2);
      }
      let std = Math.sqrt(sqSum / X.length);
      if (std === 0) std = 1; // Prevent div by 0
      stds[j] = std;
    }

    const Xstd = X.map(row => row.map((val, j) => (val - means[j]) / stds[j]));
    return { Xstd, means, stds };
  }

  run(X: number[][], k: number, seed = 42, maxIter = 100): KMeansResult {
    if (X.length === 0 || k <= 0) return { assignments: [], centroids: [], sse: 0, iterations: 0 };
    const prng = mulberry32(seed);

    // KMeans++ initialization
    const centroids: number[][] = [];
    const firstIdx = Math.floor(prng() * X.length);
    centroids.push([...X[firstIdx]]);

    for (let c = 1; c < k; c++) {
      const dists = X.map(row => {
        let minDist = Infinity;
        for (const centroid of centroids) {
          const d = row.reduce((sum, val, j) => sum + Math.pow(val - centroid[j], 2), 0);
          if (d < minDist) minDist = d;
        }
        return minDist;
      });
      const sumDist = dists.reduce((a, b) => a + b, 0);
      let r = prng() * sumDist;
      let selectedIdx = dists.length - 1;
      for (let i = 0; i < dists.length; i++) {
        r -= dists[i];
        if (r <= 0) {
          selectedIdx = i;
          break;
        }
      }
      centroids.push([...X[selectedIdx]]);
    }

    let assignments = new Array(X.length).fill(-1);
    let iterations = 0;
    let changed = true;

    while (changed && iterations < maxIter) {
      changed = false;
      iterations++;
      
      const newAssignments = X.map(row => {
        let minDist = Infinity;
        let bestK = -1;
        for (let c = 0; c < k; c++) {
          const d = row.reduce((sum, val, j) => sum + Math.pow(val - centroids[c][j], 2), 0);
          if (d < minDist) {
            minDist = d;
            bestK = c;
          }
        }
        return bestK;
      });

      for (let i = 0; i < X.length; i++) {
        if (assignments[i] !== newAssignments[i]) {
          changed = true;
          assignments[i] = newAssignments[i];
        }
      }

      // Update centroids
      const counts = new Array(k).fill(0);
      const newCentroids = Array.from({ length: k }, () => new Array(X[0].length).fill(0));
      for (let i = 0; i < X.length; i++) {
        const c = assignments[i];
        counts[c]++;
        for (let j = 0; j < X[0].length; j++) {
          newCentroids[c][j] += X[i][j];
        }
      }
      for (let c = 0; c < k; c++) {
        if (counts[c] > 0) {
          for (let j = 0; j < X[0].length; j++) {
            centroids[c][j] = newCentroids[c][j] / counts[c];
          }
        }
      }
    }

    let sse = 0;
    for (let i = 0; i < X.length; i++) {
      const c = assignments[i];
      sse += X[i].reduce((sum, val, j) => sum + Math.pow(val - centroids[c][j], 2), 0);
    }

    return { assignments, centroids, sse, iterations };
  }

  labelByIncome(centroids: number[][], incomeCol = 0): number[] {
    const withIndex = centroids.map((c, idx) => ({ c, idx }));
    withIndex.sort((a, b) => a.c[incomeCol] - b.c[incomeCol]);
    const mapping = new Array(centroids.length);
    for (let i = 0; i < withIndex.length; i++) {
      mapping[i] = withIndex[i].idx;
    }
    return mapping; // mapping[sortedIndex] = originalIndex
  }

  /**
   * Silhouette coefficient rata-rata (05-Algorithm-Design.md §3.2) — dipakai
   * sebagai bukti kuantitatif bahwa k yang dipilih memisahkan data dengan wajar.
   *
   * Untuk tiap titik i:
   *   a_i = jarak rata-rata ke titik LAIN di cluster yang sama
   *   b_i = jarak rata-rata terkecil ke seluruh titik di salah satu cluster lain
   *   s_i = (b_i - a_i) / max(a_i, b_i)
   * Hasil akhir = rata-rata s_i. Rentang -1..1, makin tinggi makin terpisah.
   *
   * Titik yang sendirian di clusternya diberi s_i = 0 (konvensi standar: tidak
   * ada informasi kohesi untuk dinilai, dan 0 tidak menggeser rata-rata).
   *
   * Kompleksitasnya O(n^2 * m). Untuk n besar dipakai subsampel deterministik
   * (seed tetap) supaya endpoint clustering tidak jadi lambat — nilai silhouette
   * memang estimasi, bukan angka yang dipakai untuk keputusan alokasi.
   */
  silhouette(X: number[][], labels: number[], maxSample = 1500, seed = 42): number {
    if (X.length !== labels.length || X.length < 2) return 0;

    let idxs = X.map((_, i) => i);
    if (idxs.length > maxSample) {
      // Sampling acak deterministik (Fisher-Yates dengan PRNG ber-seed) supaya
      // dua panggilan pada data yang sama menghasilkan angka yang sama persis.
      const prng = mulberry32(seed);
      for (let i = idxs.length - 1; i > 0; i--) {
        const j = Math.floor(prng() * (i + 1));
        [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
      }
      idxs = idxs.slice(0, maxSample).sort((a, b) => a - b);
    }

    const uniqueLabels = Array.from(new Set(idxs.map((i) => labels[i])));
    if (uniqueLabels.length < 2) return 0;

    const dist = (a: number[], b: number[]) => {
      let sum = 0;
      for (let j = 0; j < a.length; j++) sum += Math.pow(a[j] - b[j], 2);
      return Math.sqrt(sum);
    };

    let total = 0;
    for (const i of idxs) {
      // sumJarak[label] & jumlah[label] -> rata-rata jarak i ke tiap cluster
      const sumJarak = new Map<number, number>();
      const jumlah = new Map<number, number>();
      for (const j of idxs) {
        if (i === j) continue;
        const l = labels[j];
        sumJarak.set(l, (sumJarak.get(l) ?? 0) + dist(X[i], X[j]));
        jumlah.set(l, (jumlah.get(l) ?? 0) + 1);
      }

      const own = labels[i];
      const nOwn = jumlah.get(own) ?? 0;
      if (nOwn === 0) continue; // satu-satunya anggota cluster -> s_i = 0
      const a = (sumJarak.get(own) ?? 0) / nOwn;

      let b = Infinity;
      for (const l of uniqueLabels) {
        if (l === own) continue;
        const n = jumlah.get(l) ?? 0;
        if (n === 0) continue;
        b = Math.min(b, (sumJarak.get(l) ?? 0) / n);
      }
      if (!isFinite(b)) continue;

      const denom = Math.max(a, b);
      total += denom === 0 ? 0 : (b - a) / denom;
    }

    return total / idxs.length;
  }

  elbow(X: number[][], maxK = 10, seed = 42): { k: number; sse: number }[] {
    const { Xstd } = this.standardize(X);
    const results = [];
    const limit = Math.min(maxK, X.length);
    for (let k = 1; k <= limit; k++) {
      const { sse } = this.run(Xstd, k, seed);
      results.push({ k, sse });
    }
    return results;
  }
}
