import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const PEPPER = process.env.SYSTEM_PEPPER || 'default-pepper-change-me';
const ENC_KEY = process.env.DB_ENCRYPTION_KEY || '0'.repeat(64);
const ALGORITHM = 'aes-256-cbc';

/**
 * SHA-256 hash with system pepper.
 * Used for NIK, No. KK hashing to prevent rainbow table attacks on 16-digit NIK space.
 */
export function hashWithPepper(value: string): string {
  return createHash('sha256').update(value + PEPPER).digest('hex');
}

/**
 * Placeholder wallet address for penerima yang belum punya wallet sendiri
 * ("custodial" — dikelola pendamping desa, lihat 07-Security-Privacy-Ethics.md §6).
 * Deterministik dari `seed` (biasanya `rumahTangga.id`) + pepper terpisah, jadi tetap
 * stabil antar panggilan tanpa membocorkan `nikKkHash` lewat alamat yang tampil publik.
 *
 * INI BUKAN WALLET NYATA — tidak ada private key di baliknya, jadi tidak ada dana yang
 * benar-benar bisa diklaim ke alamat ini sampai penyediaan wallet custodial sungguhan
 * (mis. lewat MPC/HSM yang dikelola pendamping desa) dibangun. Dipakai supaya alur
 * build-merkle tetap punya `recipient` yang valid secara format untuk demo/testing.
 */
export function deriveCustodialWallet(seed: string): string {
  const hash = createHash('sha256').update(`custodial:${seed}:${PEPPER}`).digest('hex');
  return '0x' + hash.slice(0, 40);
}

/**
 * AES-256-CBC encrypt for PII storage.
 * Returns IV prepended to ciphertext as a single Buffer.
 */
export function encrypt(plaintext: string): Buffer {
  const key = Buffer.from(ENC_KEY, 'hex');
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

/**
 * AES-256-CBC decrypt for PII retrieval.
 */
export function decrypt(data: Buffer): string {
  const key = Buffer.from(ENC_KEY, 'hex');
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/**
 * Normalize a name for fuzzy matching: lowercase, remove punctuation, collapse whitespace.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Jaro-Winkler similarity (0–1). Used for fuzzy duplicate detection.
 */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;

  const matchDistance = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

  // Winkler bonus for common prefix (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}
