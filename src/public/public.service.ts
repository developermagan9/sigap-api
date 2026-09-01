import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { alamatKontrakValid } from '../blockchain/blockchain.service';

/** Hanya periode yang sudah disahkan yang boleh tampil di portal publik —
 *  daftar penerima periode `draft`..`alokasi` masih bisa berubah, mempublikasikannya
 *  akan menampilkan angka yang belum final ke warga. */
const STATUS_PUBLIK = ['approved', 'disbursed'] as const;

@Injectable()
export class PublicService {
  constructor(private prisma: PrismaService) {}

  /**
   * Public disbursement summary — no auth required.
   * Returns aggregated metrics, per-region breakdown, and recent transactions.
   */
  async getDisbursementSummary() {
    // Find latest approved/disbursed periode
    const periode = await this.prisma.periodeProgram.findFirst({
      where: { status: { in: ['approved', 'disbursed'] } },
      orderBy: { createdAt: 'desc' },
    });

    if (!periode) {
      return {
        program: null,
        total_anggaran: 0,
        total_tersalur: 0,
        jumlah_penerima: 0,
        per_wilayah: [],
        transaksi_terbaru: [],
      };
    }

    // Aggregate disbursement stats
    const disbursements = await this.prisma.disbursementRecord.findMany({
      where: { periodeId: periode.id },
      include: {
        rumahTangga: {
          select: {
            wilayahId: true,
            wilayah: { select: { desa: true } },
          },
        },
      },
    });

    // Total claimed amount
    const claimedDisbursements = disbursements.filter((d) => d.status === 'claimed');
    const totalTersalur = claimedDisbursements.reduce((sum, d) => sum + Number(d.amount), 0);

    // Per-wilayah breakdown
    const wilayahMap = new Map<string, { desa: string; jumlah_penerima: number; total_dana: number; total_cair: number }>();
    for (const d of disbursements) {
      const desa = d.rumahTangga.wilayah.desa;
      const existing = wilayahMap.get(desa) || { desa, jumlah_penerima: 0, total_dana: 0, total_cair: 0 };
      existing.jumlah_penerima++;
      existing.total_dana += Number(d.amount);
      if (d.status === 'claimed') existing.total_cair += Number(d.amount);
      wilayahMap.set(desa, existing);
    }

    // Recent transactions (last 10 claimed)
    const recentClaimed = await this.prisma.disbursementRecord.findMany({
      where: { periodeId: periode.id, status: 'claimed' },
      orderBy: { claimedAt: 'desc' },
      take: 10,
    });

    const transaksiTerbaru = recentClaimed.map((d) => ({
      tx_hash: d.txHash || '0x...',
      amount: Number(d.amount),
      timestamp: d.claimedAt?.toISOString() || d.updatedAt.toISOString(),
      recipient_ref: `${d.reference} (anonim)`,
    }));

    return {
      program: `${periode.namaProgram}`,
      total_anggaran: Number(periode.anggaranTotal),
      total_tersalur: totalTersalur,
      jumlah_penerima: disbursements.length,
      per_wilayah: Array.from(wilayahMap.values()),
      transaksi_terbaru: transaksiTerbaru,
    };
  }

  /**
   * Daftar program/periode yang sudah disahkan — dipakai portal publik untuk
   * menautkan halaman detail per periode. Tidak memuat data individu.
   */
  async getPrograms() {
    const periodes = await this.prisma.periodeProgram.findMany({
      where: { status: { in: [...STATUS_PUBLIK] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        namaProgram: true,
        status: true,
        anggaranTotal: true,
        kuotaPenerima: true,
        totalAlokasi: true,
        createdAt: true,
      },
    });

    return {
      programs: periodes.map((p) => ({
        id: p.id,
        nama_program: p.namaProgram,
        status: p.status,
        anggaran_total: Number(p.anggaranTotal),
        kuota_penerima: p.kuotaPenerima,
        total_alokasi: p.totalAlokasi == null ? null : Number(p.totalAlokasi),
        dibuat_pada: p.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Detail satu periode untuk portal publik: agregat dana, sebaran per wilayah,
   * bobot kriteria, ringkasan cluster, dan batas skor (cutoff).
   *
   * Yang SENGAJA tidak dikembalikan: skor TOPSIS per individu, hash NIK, dan
   * daftar penerima per orang — 07-Security-Privacy-Ethics.md hanya mengizinkan
   * definisi kriteria & angka agregat di kanal publik.
   */
  async getProgramDetail(periodeId: string) {
    const periode = await this.prisma.periodeProgram.findFirst({
      where: { id: periodeId, status: { in: [...STATUS_PUBLIK] } },
    });
    if (!periode) {
      throw new HttpException(
        { code: 'TIDAK_DITEMUKAN', message: 'Program tidak ditemukan atau belum disahkan untuk publik' },
        HttpStatus.NOT_FOUND,
      );
    }

    const [disbursements, clusters, terpilih, totalRanked, totalVerified] = await Promise.all([
      this.prisma.disbursementRecord.findMany({
        where: { periodeId },
        include: { rumahTangga: { select: { wilayah: { select: { desa: true } } } } },
      }),
      this.prisma.clusterResult.findMany({
        where: { periodeId },
        orderBy: { clusterIndex: 'asc' },
        select: { clusterIndex: true, label: true, jumlahAnggota: true },
      }),
      this.prisma.rankingResult.findMany({
        where: { periodeId, terpilih: true },
        orderBy: { rank: 'desc' },
        take: 1,
        select: { skorTopsis: true, rank: true },
      }),
      this.prisma.rankingResult.count({ where: { periodeId } }),
      this.prisma.rumahTangga.count({ where: { periodeId, statusVerifikasi: 'verified' } }),
    ]);

    // Kandidat pertama yang TIDAK masuk kuota — dipakai menghitung "batas tipis"
    // (selisih skor penerima terakhir vs kandidat berikutnya), angka agregat yang
    // menunjukkan seberapa dekat keputusan cutoff-nya.
    const pertamaTidakTerpilih = terpilih.length
      ? await this.prisma.rankingResult.findFirst({
          where: { periodeId, terpilih: false, rank: { gt: terpilih[0].rank } },
          orderBy: { rank: 'asc' },
          select: { skorTopsis: true },
        })
      : null;

    const skorTerakhir = terpilih.length ? Number(terpilih[0].skorTopsis) : null;
    const skorBerikutnya = pertamaTidakTerpilih ? Number(pertamaTidakTerpilih.skorTopsis) : null;

    return {
      id: periode.id,
      nama_program: periode.namaProgram,
      status: periode.status,
      anggaran_total: Number(periode.anggaranTotal),
      biaya_operasional: Number(periode.biayaOperasional),
      nominal_dasar: Number(periode.nominalDasar),
      skema_alokasi: periode.skemaAlokasi,
      bobot_kriteria: periode.bobotKriteria,
      k_cluster: periode.kCluster,
      silhouette_score: periode.silhouetteScore == null ? null : Number(periode.silhouetteScore),
      kuota_penerima: periode.kuotaPenerima,
      total_alokasi: periode.totalAlokasi == null ? null : Number(periode.totalAlokasi),
      sisa_anggaran: periode.sisaAnggaran == null ? null : Number(periode.sisaAnggaran),
      merkle_root: periode.merkleRoot,
      // Nilai sampah dari versi lama (mis. literal "0x...") tidak boleh keluar ke
      // publik sebagai alamat kontrak — UI akan memasang tautan explorer yang mati.
      contract_address: alamatKontrakValid(periode.contractAddress),
      tx_hash: periode.txHash,
      total_verifikasi: totalVerified,
      total_masuk_ranking: totalRanked,
      clusters: clusters.map((c) => ({
        cluster_index: c.clusterIndex,
        label: c.label,
        jumlah_anggota: c.jumlahAnggota,
      })),
      cutoff: {
        rank_terakhir_terpilih: terpilih.length ? terpilih[0].rank : null,
        skor_terakhir_terpilih: skorTerakhir,
        skor_pertama_tidak_terpilih: skorBerikutnya,
        selisih: skorTerakhir != null && skorBerikutnya != null ? skorTerakhir - skorBerikutnya : null,
      },
      ...this.agregatDisbursement(disbursements),
    };
  }

  /**
   * Daftar transaksi pencairan ber-pagination untuk halaman Jejak Transaksi.
   * Identitas penerima diganti kode referensi anonim (REC-XXXX), sama seperti
   * yang sudah dipakai `disbursement-summary`.
   */
  async getTransactions(params: { periodeId?: string; page?: number; limit?: number; status?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));

    // Tanpa periode_id: pakai periode publik terbaru, supaya halaman transaksi
    // tidak mencampur beberapa periode dalam satu tabel tanpa penanda.
    let periodeId = params.periodeId;
    if (!periodeId) {
      const terbaru = await this.prisma.periodeProgram.findFirst({
        where: { status: { in: [...STATUS_PUBLIK] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (!terbaru) return { data: [], meta: { total: 0, page, limit, totalPages: 0 }, periode_id: null };
      periodeId = terbaru.id;
    } else {
      const adaDanPublik = await this.prisma.periodeProgram.findFirst({
        where: { id: periodeId, status: { in: [...STATUS_PUBLIK] } },
        select: { id: true },
      });
      if (!adaDanPublik) {
        throw new HttpException(
          { code: 'TIDAK_DITEMUKAN', message: 'Program tidak ditemukan atau belum disahkan untuk publik' },
          HttpStatus.NOT_FOUND,
        );
      }
    }

    const where: any = { periodeId };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      this.prisma.disbursementRecord.findMany({
        where,
        // Yang sudah cair tampil lebih dulu dan terbaru di atas; `reference`
        // jadi tie-break supaya urutan halaman stabil antar request.
        orderBy: [{ claimedAt: 'desc' }, { reference: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { rumahTangga: { select: { wilayah: { select: { desa: true, kecamatan: true } } } } },
      }),
      this.prisma.disbursementRecord.count({ where }),
    ]);

    return {
      periode_id: periodeId,
      data: rows.map((d) => ({
        reference: d.reference,
        desa: d.rumahTangga.wilayah.desa,
        kecamatan: d.rumahTangga.wilayah.kecamatan,
        amount: Number(d.amount),
        status: d.status,
        jenis_wallet: d.jenisWallet,
        tx_hash: d.txHash,
        leaf_hash: d.merkleLeafHash,
        claimed_at: d.claimedAt?.toISOString() ?? null,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Agregat dana + sebaran per wilayah dari sekumpulan disbursement record. */
  private agregatDisbursement(
    disbursements: { amount: any; status: string; rumahTangga: { wilayah: { desa: string } } }[],
  ) {
    const claimed = disbursements.filter((d) => d.status === 'claimed');
    const wilayahMap = new Map<string, { desa: string; jumlah_penerima: number; total_dana: number; total_cair: number }>();
    for (const d of disbursements) {
      const desa = d.rumahTangga.wilayah.desa;
      const existing = wilayahMap.get(desa) || { desa, jumlah_penerima: 0, total_dana: 0, total_cair: 0 };
      existing.jumlah_penerima++;
      existing.total_dana += Number(d.amount);
      if (d.status === 'claimed') existing.total_cair += Number(d.amount);
      wilayahMap.set(desa, existing);
    }

    return {
      jumlah_penerima: disbursements.length,
      jumlah_terklaim: claimed.length,
      total_tersalur: claimed.reduce((s, d) => s + Number(d.amount), 0),
      per_wilayah: Array.from(wilayahMap.values()).sort((a, b) => b.jumlah_penerima - a.jumlah_penerima),
    };
  }

  /**
   * Cek status klaim lewat alamat wallet atau kode penerima (REC-XXXX).
   *
   * Discope ke periode berstatus publik, sama seperti seluruh endpoint /public
   * lainnya. Tanpa ini, satu-satunya endpoint publik yang tidak memfilter
   * `STATUS_PUBLIK` membocorkan nominal & wallet penerima dari periode yang
   * masih draft/ranking — daftar yang belum disahkan dan masih bisa berubah.
   */
  async checkClaimStatus(query: string) {
    if (!query || query.trim().length === 0) {
      throw new HttpException(
        { code: 'PARAMETER_TIDAK_VALID', message: 'Parameter q harus diisi' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const q = query.trim();
    const where = q.startsWith('0x')
      ? { walletAddress: { equals: q, mode: 'insensitive' as const } }
      : { reference: { equals: q, mode: 'insensitive' as const } };

    const disbursement = await this.prisma.disbursementRecord.findFirst({
      where: { ...where, periode: { status: { in: [...STATUS_PUBLIK] } } },
      include: {
        periode: { select: { namaProgram: true, status: true } },
        rumahTangga: { select: { wilayah: { select: { desa: true, kecamatan: true } } } },
      },
    });

    if (!disbursement) {
      throw new HttpException(
        { code: 'TIDAK_DITEMUKAN', message: 'Data penerima tidak ditemukan' },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      reference: disbursement.reference,
      status: disbursement.status,
      amount: Number(disbursement.amount),
      wallet: disbursement.walletAddress,
      // `jenis_wallet` ikut dikirim karena portal menampilkannya ke warga:
      // custodial berarti dompetnya masih dikelola program, mandiri berarti
      // warga memegang kuncinya sendiri. Sebelumnya UI menuliskan "Milik
      // sendiri" secara hardcode untuk semua orang — keliru untuk penerima
      // custodial, dan sama-sama dipublikasikan lewat /public/transactions.
      jenis_wallet: disbursement.jenisWallet,
      desa: disbursement.rumahTangga.wilayah.desa,
      kecamatan: disbursement.rumahTangga.wilayah.kecamatan,
      tx_hash: disbursement.txHash,
      claimed_at: disbursement.claimedAt?.toISOString() || null,
      program: disbursement.periode.namaProgram,
      leaf_hash: disbursement.merkleLeafHash,
    };
  }
}
