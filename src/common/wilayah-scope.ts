/**
 * Batas kewenangan wilayah untuk role non-admin (12-Alur-Fitur-per-Role.md §6).
 *
 * Sejak relasi many-to-many `UserWilayah` ada, kewenangan seorang user bukan lagi
 * satu `wilayah_id` melainkan **gabungan** wilayah utama + seluruh wilayah akses
 * tambahannya. Semua pemanggil memakai daftar itu lewat helper di file ini supaya
 * aturannya cuma ditulis sekali — sebelumnya tiap service menulis ulang
 * `user.wilayahId ?? '__no_wilayah__'` sendiri-sendiri dan keduanya harus
 * diperbaiki terpisah setiap kali aturannya berubah.
 *
 * **Kenapa bukan sentinel string lagi.** Pola lama `where.wilayahId =
 * user.wilayahId ?? '__no_wilayah__'` dimaksudkan fail-closed ("tanpa wilayah =
 * tidak melihat apa pun"), tapi `'__no_wilayah__'` bukan UUID yang sah sementara
 * kolomnya `@db.Uuid` — Prisma menolaknya di level driver dengan
 * `Inconsistent column data: Error creating UUID`, jadi hasil nyatanya **HTTP 500
 * berisi stack trace Prisma**, bukan daftar kosong. Fail-closed yang meledak
 * bukan fail-closed. `{ in: [] }` menghasilkan daftar kosong yang benar tanpa
 * pernah menyentuh parser UUID.
 */

/** Bentuk `req.user` yang dihasilkan `JwtStrategy.validate()`. */
export interface PenggunaBerwilayah {
  role?: string;
  /** Wilayah utama — tetap ada untuk kompatibilitas & tampilan. */
  wilayahId?: string | null;
  /** Kewenangan efektif: wilayah utama + seluruh `UserWilayah`. */
  wilayahIds?: string[];
}

/** `admin` melihat seluruh wilayah; `undefined` (pemanggil internal/test) juga tidak dibatasi. */
export function tanpaBatasWilayah(user?: PenggunaBerwilayah): boolean {
  return !user || user.role === 'admin';
}

/**
 * Daftar wilayah yang boleh diakses user. Kosong = tidak berwenang atas apa pun
 * (bukan "semua") — pemanggil harus memperlakukannya sebagai fail-closed.
 */
export function daftarWilayah(user: PenggunaBerwilayah): string[] {
  const dari = user.wilayahIds?.length ? user.wilayahIds : user.wilayahId ? [user.wilayahId] : [];
  return [...new Set(dari.filter((w): w is string => Boolean(w)))];
}

/**
 * Filter Prisma untuk kolom `wilayah_id`.
 *
 * `undefined` = tanpa batas (jangan pasang filter sama sekali); selain itu selalu
 * `{ in: [...] }` — termasuk `{ in: [] }` untuk user tanpa wilayah, yang benar
 * mengembalikan nol baris.
 */
export function filterWilayah(user?: PenggunaBerwilayah): { in: string[] } | undefined {
  if (tanpaBatasWilayah(user)) return undefined;
  return { in: daftarWilayah(user!) };
}

/** Apakah user berwenang atas satu wilayah tertentu (dipakai guard aksi TULIS). */
export function bolehAksesWilayah(user: PenggunaBerwilayah | undefined, wilayahId: string): boolean {
  if (tanpaBatasWilayah(user)) return true;
  return daftarWilayah(user!).includes(wilayahId);
}
