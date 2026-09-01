import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { KMeansService, LABEL_KERENTANAN } from './kmeans.service';
import { TopsisService, KriteriaSpec } from './topsis.service';
import { AlokasiService, KandidatAlokasi } from './alokasi.service';
import { PeriodeProgramService } from '../periode-program/periode-program.service';

export const KRITERIA_DEFAULT: KriteriaSpec[] = [
  { key: 'pendapatanPerKapita', label: 'Pendapatan per kapita', benefit: false },
  { key: 'jumlahTanggungan', label: 'Jumlah tanggungan', benefit: true },
  { key: 'jumlahDisabilitasLansia', label: 'Disabilitas / lansia', benefit: true },
  { key: 'skorKondisiRumah', label: 'Kondisi rumah', benefit: false },
];

const FEATURE_KEYS = [
  'pendapatanPerKapita',
  'jumlahTanggungan',
  'jumlahDisabilitasLansia',
  'skorKondisiRumah',
] as const;

// Status di mana daftar penerima sudah disahkan / dikunci — menjalankan ulang
// clustering / TOPSIS / alokasi pada status ini akan menghapus (deleteMany)
// ranking final yang sudah ditandatangani, jadi ditolak keras. Iterasi normal
// (draft/clustering/ranking/alokasi) tetap boleh diulang.
const STATUS_TERKUNCI = ['reviewed', 'approved', 'disbursed'];

function assertPeriodeTidakTerkunci(status: string) {
  if (STATUS_TERKUNCI.includes(status)) {
    throw new HttpException(
      {
        code: 'PERIODE_TERKUNCI',
        message: `Periode berstatus '${status}' — daftar penerima sudah dikunci. Batalkan approval sebelum menjalankan ulang tahap data mining.`,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// Ketiga skema di 05-Algorithm-Design.md §5.2 sudah diimplementasikan di
// alokasi.service.ts. Nama di luar daftar ini tetap ditolak eksplisit alih-alih
// diam-diam dihitung sebagai flat.
const SKEMA_ALOKASI_DIDUKUNG = ['flat', 'berjenjang', 'proporsional'];

// Faktor pengali nominal per label cluster untuk skema `berjenjang`, dipakai bila
// periode belum menyimpan `faktor_cluster` sendiri. Angkanya contoh di §5.2-B.
const FAKTOR_CLUSTER_DEFAULT: Record<string, number> = {
  'Sangat Rentan': 1.25,
  Rentan: 1.0,
  'Cukup Mampu': 0.75,
  Mampu: 0.5,
};

@Injectable()
export class MiningService {
  private readonly logger = new Logger(MiningService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private kmeans: KMeansService,
    private topsis: TopsisService,
    private alokasi: AlokasiService,
    private periodeProgramService: PeriodeProgramService,
  ) {}

  /**
   * Run K-Means clustering on verified households for a period.
   */
  async runClustering(periodeId: string, k?: number, fitur?: string[]) {
    const periode = await this.prisma.periodeProgram.findUnique({ where: { id: periodeId } });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }
    assertPeriodeTidakTerkunci(periode.status);

    const kTarget = k || periode.kCluster || 4;

    // Fetch all verified households for this period.
    // `orderBy` WAJIB: tanpa ini Postgres tidak menjamin urutan baris, sedangkan
    // inisialisasi K-Means++ memilih centroid awal berdasarkan indeks baris —
    // urutan yang berbeda menghasilkan assignment yang berbeda untuk data yang
    // sama persis (lihat 15-Checklist-Belum-Terimplementasi.md item C).
    const households = await this.prisma.rumahTangga.findMany({
      where: {
        periodeId,
        statusVerifikasi: 'verified',
      },
      orderBy: { id: 'asc' },
    });

    if (households.length < kTarget) {
      throw new HttpException(
        { code: 'DATA_TIDAK_CUKUP', message: `Jumlah data terverifikasi (${households.length}) kurang dari k (${kTarget})` },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Build feature matrix
    const X = households.map((h) => [
      Number(h.pendapatanPerKapita),
      h.jumlahTanggungan,
      h.jumlahDisabilitasLansia,
      h.skorKondisiRumah,
    ]);

    // Standardize
    const { Xstd } = this.kmeans.standardize(X);

    // Run K-Means
    const result = this.kmeans.run(Xstd, kTarget);

    // Label clusters by ascending centroid income (col 0 = income in standardized space)
    const labelMapping = this.kmeans.labelByIncome(result.centroids, 0);

    // Compute original-space centroids for each cluster
    const clusterData: { clusterIndex: number; label: string; centroid: Record<string, number>; householdIds: string[] }[] = [];
    for (let ci = 0; ci < kTarget; ci++) {
      const memberIndices = result.assignments
        .map((a, i) => (a === ci ? i : -1))
        .filter((i) => i >= 0);

      const sortedIdx = labelMapping.indexOf(ci);
      const label = sortedIdx < LABEL_KERENTANAN.length ? LABEL_KERENTANAN[sortedIdx] : `Cluster ${sortedIdx}`;

      // Compute centroid in original space
      const centroid: Record<string, number> = {};
      for (let f = 0; f < FEATURE_KEYS.length; f++) {
        const sum = memberIndices.reduce((s, i) => s + X[i][f], 0);
        centroid[FEATURE_KEYS[f]] = memberIndices.length > 0 ? Math.round(sum / memberIndices.length) : 0;
      }

      clusterData.push({
        clusterIndex: sortedIdx,
        label,
        centroid,
        householdIds: memberIndices.map((i) => households[i].id),
      });
    }

    // Silhouette score dihitung di ruang terstandardisasi memakai label
    // peringkat (bukan index mentah K-Means) — nilainya sama, tapi konsisten
    // dengan apa yang disimpan per rumah tangga di bawah.
    const labelPeringkat = result.assignments.map((a) => labelMapping.indexOf(a));
    const silhouetteScore = this.kmeans.silhouette(Xstd, labelPeringkat);

    // Delete old cluster results
    await this.prisma.clusterResult.deleteMany({ where: { periodeId } });
    // Also delete old ranking results
    await this.prisma.rankingResult.deleteMany({ where: { periodeId } });

    // Kosongkan assignment lama (baris yang tadinya verified lalu ditolak, atau
    // sisa run sebelumnya) supaya tidak ada cluster "hantu" yang ikut terbaca
    // run-topsis. `clusterResultId` sendiri sudah jadi NULL karena onDelete:
    // SetNull di atas — `clusterIndex` yang perlu dibersihkan manual.
    await this.prisma.rumahTangga.updateMany({
      where: { periodeId },
      data: { clusterIndex: null, clusterResultId: null },
    });

    // Save new cluster results + assignment per rumah tangga
    for (const cd of clusterData) {
      const created = await this.prisma.clusterResult.create({
        data: {
          periodeId,
          clusterIndex: cd.clusterIndex,
          label: cd.label,
          centroid: cd.centroid,
          jumlahAnggota: cd.householdIds.length,
        },
      });

      if (cd.householdIds.length > 0) {
        await this.prisma.rumahTangga.updateMany({
          where: { id: { in: cd.householdIds } },
          data: { clusterIndex: cd.clusterIndex, clusterResultId: created.id },
        });
      }
    }

    // Update period status
    await this.prisma.periodeProgram.update({
      where: { id: periodeId },
      data: { status: 'clustering', kCluster: kTarget, silhouetteScore },
    });

    // Audit
    await this.audit.log({
      action: 'run_clustering',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: { k: kTarget, sse: result.sse, iterations: result.iterations, silhouette: silhouetteScore },
    });

    // Compute elbow data
    const maxK = Math.min(8, households.length);
    const elbowData = this.kmeans.elbow(Xstd, maxK);

    return {
      job_id: periodeId,
      status: 'completed',
      k: kTarget,
      sse: result.sse,
      iterations: result.iterations,
      silhouette_score: silhouetteScore,
      clusters: clusterData.map((cd) => ({
        cluster_index: cd.clusterIndex,
        label: cd.label,
        centroid: cd.centroid,
        jumlah_anggota: cd.householdIds.length,
      })),
      elbow: elbowData,
    };
  }

  /**
   * Get clustering result for a period.
   */
  async getClusteringResult(periodeId: string) {
    const [clusters, periode] = await Promise.all([
      this.prisma.clusterResult.findMany({
        where: { periodeId },
        orderBy: { clusterIndex: 'asc' },
      }),
      this.prisma.periodeProgram.findUnique({
        where: { id: periodeId },
        select: { silhouetteScore: true },
      }),
    ]);
    return {
      clusters,
      silhouette_score: periode?.silhouetteScore == null ? null : Number(periode.silhouetteScore),
    };
  }

  /**
   * Run TOPSIS ranking on priority clusters.
   */
  async runTopsis(
    periodeId: string,
    clusterIndexTarget: number[],
    bobotKriteria: Record<string, number>,
  ) {
    // Validate bobot sums to 1
    const bobotSum = Object.values(bobotKriteria).reduce((s, v) => s + v, 0);
    if (Math.abs(bobotSum - 1.0) > 1e-6) {
      throw new HttpException(
        { code: 'BOBOT_TIDAK_VALID', message: `Jumlah bobot kriteria (${bobotSum}) harus = 1.0` },
        HttpStatus.BAD_REQUEST,
      );
    }

    const periode = await this.prisma.periodeProgram.findUnique({ where: { id: periodeId } });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }
    assertPeriodeTidakTerkunci(periode.status);

    // Get clusters in target indices. Prisma/Postgres does not guarantee row
    // order for `in` filters without an explicit orderBy, so we re-sort to
    // match clusterIndexTarget's order ourselves — globalRank below is
    // assigned by iterating `clusters` in sequence, and that sequence IS the
    // cluster priority (e.g. "Sangat Rentan" must be ranked before "Rentan").
    const clustersUnordered = await this.prisma.clusterResult.findMany({
      where: { periodeId, clusterIndex: { in: clusterIndexTarget } },
    });
    const clusters = [...clustersUnordered].sort(
      (a, b) => clusterIndexTarget.indexOf(a.clusterIndex) - clusterIndexTarget.indexOf(b.clusterIndex),
    );

    if (clusters.length === 0) {
      throw new HttpException(
        { code: 'CLUSTER_TIDAK_DITEMUKAN', message: 'Tidak ada cluster dengan index target yang ditemukan' },
        HttpStatus.NOT_FOUND,
      );
    }

    // Delete old ranking results
    await this.prisma.rankingResult.deleteMany({ where: { periodeId } });

    // For each target cluster, run TOPSIS
    let globalRank = 0;
    const allResults: any[] = [];

    // Assignment cluster per rumah tangga sudah disimpan `run-clustering`
    // (kolom cluster_result_id). Kalau kosong berarti data ini berasal dari run
    // sebelum kolom itu ada — minta clustering dijalankan ulang alih-alih
    // menghitung ulang K-Means di sini, karena hasil perhitungan ulang belum
    // tentu identik dengan agregat ClusterResult yang sudah tersimpan.
    const jumlahAssigned = await this.prisma.rumahTangga.count({
      where: { periodeId, statusVerifikasi: 'verified', clusterResultId: { not: null } },
    });
    if (jumlahAssigned === 0) {
      throw new HttpException(
        {
          code: 'CLUSTER_ASSIGNMENT_TIDAK_ADA',
          message:
            'Assignment cluster per rumah tangga belum tersimpan untuk periode ini. Jalankan ulang run-clustering terlebih dahulu.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    for (const cluster of clusters) {
      const clusterHouseholds = await this.prisma.rumahTangga.findMany({
        where: { periodeId, statusVerifikasi: 'verified', clusterResultId: cluster.id },
        orderBy: { id: 'asc' },
      });

      if (clusterHouseholds.length === 0) continue;

      // Build decision matrix for TOPSIS
      const matrix = clusterHouseholds.map((h) => [
        Number(h.pendapatanPerKapita),
        h.jumlahTanggungan,
        h.jumlahDisabilitasLansia,
        h.skorKondisiRumah,
      ]);

      // Run TOPSIS
      const topsisRows = this.topsis.calculate(matrix, KRITERIA_DEFAULT, bobotKriteria);

      // Save ranking results
      for (const row of topsisRows) {
        globalRank++;
        const household = clusterHouseholds[row.index];

        await this.prisma.rankingResult.create({
          data: {
            rumahTanggaId: household.id,
            periodeId,
            clusterId: cluster.id,
            skorTopsis: row.skor,
            dPlus: row.dPlus,
            dMinus: row.dMinus,
            rank: globalRank,
            breakdownKriteria: row.breakdown as any,
            terpilih: false,
            status: 'draft',
          },
        });

        allResults.push({
          rumah_tangga_id: household.id,
          cluster_label: cluster.label,
          rank: globalRank,
          skor_topsis: row.skor,
          d_plus: row.dPlus,
          d_minus: row.dMinus,
          breakdown_kriteria: row.breakdown,
        });
      }
    }

    // Update period status and bobot
    await this.prisma.periodeProgram.update({
      where: { id: periodeId },
      data: {
        status: 'ranking',
        bobotKriteria: bobotKriteria,
        clusterPrioritas: clusterIndexTarget,
      },
    });

    await this.audit.log({
      action: 'run_topsis',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: { clusterIndexTarget, bobotKriteria, totalRanked: allResults.length },
    });

    return {
      job_id: periodeId,
      status: 'completed',
      total_ranked: allResults.length,
      results: allResults,
    };
  }

  /**
   * Get ranking results for a period.
   */
  async getRankingResult(periodeId: string, status?: string) {
    const where: any = { periodeId };
    if (status) where.status = status;

    const results = await this.prisma.rankingResult.findMany({
      where,
      orderBy: { rank: 'asc' },
      include: {
        rumahTangga: { select: { nikKkHash: true, wilayahId: true } },
        cluster: { select: { label: true, clusterIndex: true } },
      },
    });

    return {
      results: results.map((r) => ({
        rumah_tangga_id: r.rumahTanggaId,
        nik_kk_hash: r.rumahTangga.nikKkHash,
        cluster_label: r.cluster.label,
        rank: r.rank,
        skor_topsis: Number(r.skorTopsis),
        d_plus: r.dPlus ? Number(r.dPlus) : null,
        d_minus: r.dMinus ? Number(r.dMinus) : null,
        breakdown_kriteria: r.breakdownKriteria,
        terpilih: r.terpilih,
        amount: r.amount ? Number(r.amount) : null,
        status: r.status,
      })),
    };
  }

  /**
   * Run budget allocation.
   */
  async runAlokasi(
    periodeId: string,
    skemaAlokasi: string,
    nominalDasar: number,
    biayaOperasional: number,
    opsi?: { faktorCluster?: Record<string, number>; nominalMin?: number; nominalMax?: number },
  ) {
    const periode = await this.prisma.periodeProgram.findUnique({ where: { id: periodeId } });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }
    assertPeriodeTidakTerkunci(periode.status);

    if (!SKEMA_ALOKASI_DIDUKUNG.includes(skemaAlokasi)) {
      throw new HttpException(
        {
          code: 'SKEMA_ALOKASI_BELUM_DIDUKUNG',
          message: `Skema alokasi '${skemaAlokasi}' belum diimplementasikan. Skema yang tersedia: ${SKEMA_ALOKASI_DIDUKUNG.join(', ')}.`,
        },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    // Get draft ranking results
    const rankings = await this.prisma.rankingResult.findMany({
      where: { periodeId, status: 'draft' },
      orderBy: { rank: 'asc' },
      include: {
        rumahTangga: { select: { id: true, nikKkHash: true, pendapatanPerKapita: true, jumlahTanggungan: true } },
        cluster: { select: { label: true, clusterIndex: true } },
      },
    });

    if (rankings.length === 0) {
      throw new HttpException(
        { code: 'RANKING_TIDAK_DITEMUKAN', message: 'Tidak ada ranking draft ditemukan. Jalankan TOPSIS terlebih dahulu.' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Build kandidat array
    const kandidat: KandidatAlokasi[] = rankings.map((r) => ({
      id: r.rumahTanggaId,
      nikKkHash: r.rumahTangga.nikKkHash,
      peringkatCluster: r.cluster.clusterIndex,
      labelCluster: r.cluster.label,
      skor: Number(r.skorTopsis),
      pendapatanPerKapita: Number(r.rumahTangga.pendapatanPerKapita),
      jumlahTanggungan: r.rumahTangga.jumlahTanggungan,
    }));

    const anggaranTotal = Number(periode.anggaranTotal);

    // Faktor cluster hanya relevan untuk `berjenjang`; disimpan ke periode supaya
    // angka yang dipakai bisa diaudit ulang persis seperti bobot kriteria TOPSIS.
    const faktorCluster: Record<string, number> =
      opsi?.faktorCluster ??
      ((periode.faktorCluster as Record<string, number> | null) ?? FAKTOR_CLUSTER_DEFAULT);

    let alokasiResult;
    if (skemaAlokasi === 'berjenjang') {
      alokasiResult = this.alokasi.alokasiBerjenjang(
        kandidat,
        anggaranTotal,
        nominalDasar,
        biayaOperasional,
        faktorCluster,
      );
    } else if (skemaAlokasi === 'proporsional') {
      alokasiResult = this.alokasi.alokasiProporsional(
        kandidat,
        anggaranTotal,
        nominalDasar,
        biayaOperasional,
        opsi?.nominalMin,
        opsi?.nominalMax,
      );
    } else {
      alokasiResult = this.alokasi.alokasiFlat(kandidat, anggaranTotal, nominalDasar, biayaOperasional);
    }

    // Bersihkan hasil alokasi sebelumnya SEBELUM menandai yang baru. Tanpa ini,
    // menjalankan ulang alokasi (ganti skema / nominal / anggaran) menyisakan
    // baris yang tetap `terpilih = true` dengan amount lama — build-merkle lalu
    // gagal di invarian §5.4 karena Σ amount tidak sama dengan total_alokasi dan
    // jumlah leaf melebihi kuota.
    await this.prisma.rankingResult.updateMany({
      where: { periodeId },
      data: { terpilih: false, amount: null },
    });

    // Update ranking results with terpilih and amount. Dikelompokkan per nominal
    // supaya skema flat (semua nominal sama) cukup satu query alih-alih satu per
    // penerima; skema berjenjang/proporsional tetap hemat karena nominalnya
    // berulang di banyak baris.
    const perNominal = new Map<number, string[]>();
    for (const [id, amount] of alokasiResult.amount) {
      const daftar = perNominal.get(amount) ?? [];
      daftar.push(id);
      perNominal.set(amount, daftar);
    }
    for (const [amount, ids] of perNominal) {
      await this.prisma.rankingResult.updateMany({
        where: { periodeId, rumahTanggaId: { in: ids } },
        data: { terpilih: true, amount },
      });
    }

    // Update periode
    await this.prisma.periodeProgram.update({
      where: { id: periodeId },
      data: {
        status: 'alokasi',
        skemaAlokasi: skemaAlokasi as any,
        nominalDasar: nominalDasar,
        biayaOperasional: biayaOperasional,
        kuotaPenerima: alokasiResult.kuotaPenerima,
        totalAlokasi: alokasiResult.totalAlokasi,
        sisaAnggaran: alokasiResult.sisaAnggaran,
        faktorCluster: skemaAlokasi === 'berjenjang' ? faktorCluster : undefined,
      },
    });

    await this.audit.log({
      action: 'run_alokasi',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: {
        skemaAlokasi,
        nominalDasar,
        kuotaPenerima: alokasiResult.kuotaPenerima,
        totalAlokasi: alokasiResult.totalAlokasi,
      },
    });

    // Nominal tidak lagi selalu seragam di skema selain `flat` — kirim sebarannya
    // supaya UI bisa menampilkan "berapa KK dapat berapa" tanpa menebak.
    const sebaranNominal = new Map<number, number>();
    alokasiResult.amount.forEach((v) => sebaranNominal.set(v, (sebaranNominal.get(v) ?? 0) + 1));

    return {
      skema_alokasi: skemaAlokasi,
      anggaran_efektif: alokasiResult.anggaranEfektif,
      nominal_dasar: nominalDasar,
      faktor_cluster: skemaAlokasi === 'berjenjang' ? faktorCluster : null,
      sebaran_nominal: Array.from(sebaranNominal.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([nominal, jumlah]) => ({ nominal, jumlah_penerima: jumlah })),
      kuota_penerima: alokasiResult.kuotaPenerima,
      total_alokasi: alokasiResult.totalAlokasi,
      sisa_anggaran: alokasiResult.sisaAnggaran,
      cutoff: {
        rank_terakhir_terpilih: alokasiResult.cutoff.rankTerakhirTerpilih,
        skor_topsis_terakhir_terpilih: alokasiResult.cutoff.skorTerakhirTerpilih,
        skor_topsis_pertama_tidak_terpilih: alokasiResult.cutoff.skorPertamaTidakTerpilih,
      },
      peringatan: [],
    };
  }

  /**
   * Finalize ranking: approve the allocation.
   */
  async finalizeRanking(periodeId: string, approvedBy: string, catatan: string) {
    const periode = await this.prisma.periodeProgram.findUnique({ where: { id: periodeId } });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }

    if (periode.status !== 'alokasi' && periode.status !== 'reviewed') {
      throw new HttpException(
        { code: 'ALOKASI_BELUM_DIJALANKAN', message: 'Jalankan alokasi anggaran terlebih dahulu sebelum finalisasi' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Check that allocation has been run (kuotaPenerima must exist)
    if (!periode.kuotaPenerima || !periode.totalAlokasi) {
      throw new HttpException(
        { code: 'ALOKASI_BELUM_DIJALANKAN', message: 'Data alokasi belum lengkap' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Update all draft rankings to final
    await this.prisma.rankingResult.updateMany({
      where: { periodeId, status: 'draft' },
      data: { status: 'final' },
    });

    // Route the status change through the single source of truth for the FSM
    // (PeriodeProgramService.updateStatus), which only allows one step at a
    // time (alokasi -> reviewed -> approved).
    if (periode.status === 'alokasi') {
      await this.periodeProgramService.updateStatus(periodeId, 'reviewed', approvedBy);
    }
    await this.periodeProgramService.updateStatus(periodeId, 'approved', approvedBy);

    await this.audit.log({
      actorId: approvedBy,
      action: 'finalize_ranking',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: { catatan, status: 'approved' },
    });

    return {
      status: 'approved',
      catatan_approval: catatan,
      approved_by: approvedBy,
    };
  }
}
