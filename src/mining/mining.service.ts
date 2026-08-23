import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { KMeansService, LABEL_KERENTANAN } from './kmeans.service';
import { TopsisService, KriteriaSpec } from './topsis.service';
import { AlokasiService, KandidatAlokasi } from './alokasi.service';

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

@Injectable()
export class MiningService {
  private readonly logger = new Logger(MiningService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private kmeans: KMeansService,
    private topsis: TopsisService,
    private alokasi: AlokasiService,
  ) {}

  /**
   * Run K-Means clustering on verified households for a period.
   */
  async runClustering(periodeId: string, k?: number, fitur?: string[]) {
    const periode = await this.prisma.periodeProgram.findUnique({ where: { id: periodeId } });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
    }

    const kTarget = k || periode.kCluster || 4;

    // Fetch all verified households for this period
    const households = await this.prisma.rumahTangga.findMany({
      where: {
        periodeId,
        statusVerifikasi: 'verified',
      },
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

    // Delete old cluster results
    await this.prisma.clusterResult.deleteMany({ where: { periodeId } });
    // Also delete old ranking results
    await this.prisma.rankingResult.deleteMany({ where: { periodeId } });

    // Save new cluster results
    for (const cd of clusterData) {
      await this.prisma.clusterResult.create({
        data: {
          periodeId,
          clusterIndex: cd.clusterIndex,
          label: cd.label,
          centroid: cd.centroid,
          jumlahAnggota: cd.householdIds.length,
        },
      });
    }

    // Update period status
    await this.prisma.periodeProgram.update({
      where: { id: periodeId },
      data: { status: 'clustering', kCluster: kTarget },
    });

    // Audit
    await this.audit.log({
      action: 'run_clustering',
      entityType: 'periode_program',
      entityId: periodeId,
      afterState: { k: kTarget, sse: result.sse, iterations: result.iterations },
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
    const clusters = await this.prisma.clusterResult.findMany({
      where: { periodeId },
      orderBy: { clusterIndex: 'asc' },
    });
    return { clusters };
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

    // Get clusters in target indices
    const clusters = await this.prisma.clusterResult.findMany({
      where: { periodeId, clusterIndex: { in: clusterIndexTarget } },
    });

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

    for (const cluster of clusters) {
      // Get all households in this cluster period
      // We need to find which households belong to this cluster
      // This is determined during clustering; we'll re-fetch verified households and re-assign
      const households = await this.prisma.rumahTangga.findMany({
        where: { periodeId, statusVerifikasi: 'verified' },
      });

      // Re-run clustering assignment to determine which households are in this cluster
      // For efficiency in production, store cluster assignments. For now, re-compute.
      const X = households.map((h) => [
        Number(h.pendapatanPerKapita),
        h.jumlahTanggungan,
        h.jumlahDisabilitasLansia,
        h.skorKondisiRumah,
      ]);

      const { Xstd } = this.kmeans.standardize(X);
      const kmeansResult = this.kmeans.run(Xstd, periode.kCluster);
      const labelMapping = this.kmeans.labelByIncome(kmeansResult.centroids, 0);

      // Find households that belong to this cluster
      const clusterHouseholds = households.filter((_, i) => {
        const assignedCluster = kmeansResult.assignments[i];
        const sortedIdx = labelMapping.indexOf(assignedCluster);
        return sortedIdx === cluster.clusterIndex;
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
  ) {
    const periode = await this.prisma.periodeProgram.findUnique({ where: { id: periodeId } });
    if (!periode) {
      throw new HttpException({ code: 'TIDAK_DITEMUKAN', message: 'Periode tidak ditemukan' }, HttpStatus.NOT_FOUND);
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
    const alokasiResult = this.alokasi.alokasiFlat(kandidat, anggaranTotal, nominalDasar, biayaOperasional);

    // Update ranking results with terpilih and amount
    for (const [id, amount] of alokasiResult.amount) {
      await this.prisma.rankingResult.updateMany({
        where: { periodeId, rumahTanggaId: id },
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

    return {
      skema_alokasi: skemaAlokasi,
      anggaran_efektif: alokasiResult.anggaranEfektif,
      nominal_dasar: nominalDasar,
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

    // Update period status
    await this.prisma.periodeProgram.update({
      where: { id: periodeId },
      data: { status: 'approved' },
    });

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
