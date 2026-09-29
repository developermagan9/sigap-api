/**
 * Pembatas percobaan login GAGAL per username (anti brute-force).
 *
 * Sengaja per username, bukan per IP: login dari UI selalu lewat route handler
 * Next.js (`app/api/auth/login`), jadi dari sisi API semua pengguna datang dari IP
 * server UI yang sama — throttle per IP akan mengunci semua orang sekaligus. Yang
 * dihitung hanya percobaan gagal; login sukses mengosongkan hitungan.
 *
 * Disimpan di memori proses: cukup untuk satu instance API (lingkup dev/demo).
 */
export class LoginLimiter {
  private readonly gagal = new Map<string, { jumlah: number; sejak: number }>();

  constructor(
    readonly maksGagal = 5,
    readonly jendelaMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private kunci(username: string) {
    return username.trim().toLowerCase();
  }

  /** Sisa detik penguncian, atau 0 kalau username ini boleh mencoba login. */
  sisaKunci(username: string): number {
    const entri = this.gagal.get(this.kunci(username));
    if (!entri) return 0;
    const lewat = this.now() - entri.sejak;
    if (lewat >= this.jendelaMs) {
      this.gagal.delete(this.kunci(username));
      return 0;
    }
    return entri.jumlah >= this.maksGagal ? Math.ceil((this.jendelaMs - lewat) / 1000) : 0;
  }

  catatGagal(username: string) {
    const k = this.kunci(username);
    const entri = this.gagal.get(k);
    if (!entri || this.now() - entri.sejak >= this.jendelaMs) {
      this.gagal.set(k, { jumlah: 1, sejak: this.now() });
    } else {
      entri.jumlah += 1;
    }
  }

  reset(username: string) {
    this.gagal.delete(this.kunci(username));
  }
}
