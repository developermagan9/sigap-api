import { keccak256, concat, AbiCoder } from 'ethers';
import { MerkleService, MerkleLeaf } from './merkle.service';

/**
 * Test permanen untuk modul yang riwayatnya paling rapuh (Bug #4 & #12 di
 * 09-Implementation-Checklist.md baru ketahuan saat dipanggil manual, bukan lewat test).
 *
 * `verifikasiManual` sengaja TIDAK memakai MerkleService — ia menirukan
 * `MerkleProof.verify()` milik OpenZeppelin (hash pasangan yang diurutkan) supaya
 * test benar-benar memeriksa proof terhadap implementasi acuan on-chain, bukan
 * mengecek implementasi terhadap dirinya sendiri.
 */
function verifikasiManual(leaf: string, proof: string[], root: string): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    const [a, b] = [computed, sibling].sort();
    computed = keccak256(concat([a, b]));
  }
  return computed === root;
}

function leafDummy(i: number): string {
  return keccak256(concat([keccak256(new TextEncoder().encode(`leaf-${i}`))]));
}

describe('MerkleService', () => {
  let service: MerkleService;

  beforeEach(() => {
    service = new MerkleService();
  });

  const RECIPIENT = '0x1234567890AbcdEF1234567890aBcdef12345678';
  const NIK_HASH = '0x' + 'ab'.repeat(32);

  describe('computeLeafHash', () => {
    it('deterministik: input sama -> hash sama persis', () => {
      const a = service.computeLeafHash(RECIPIENT, 500_000n, 12, NIK_HASH);
      const b = service.computeLeafHash(RECIPIENT, 500_000n, 12, NIK_HASH);
      expect(a).toBe(b);
      expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('cocok dengan keccak256(bytes.concat(keccak256(abi.encode(...)))) di Solidity', () => {
      const encoded = AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256', 'uint256', 'bytes32'],
        [RECIPIENT, 500_000n, 12, NIK_HASH],
      );
      const diharapkan = keccak256(concat([keccak256(encoded)]));
      expect(service.computeLeafHash(RECIPIENT, 500_000n, 12, NIK_HASH)).toBe(diharapkan);
    });

    it('berubah kalau salah satu komponen berubah', () => {
      const dasar = service.computeLeafHash(RECIPIENT, 500_000n, 12, NIK_HASH);
      const lain = '0x000000000000000000000000000000000000dEaD';
      expect(service.computeLeafHash(lain, 500_000n, 12, NIK_HASH)).not.toBe(dasar);
      expect(service.computeLeafHash(RECIPIENT, 500_001n, 12, NIK_HASH)).not.toBe(dasar);
      expect(service.computeLeafHash(RECIPIENT, 500_000n, 13, NIK_HASH)).not.toBe(dasar);
      expect(service.computeLeafHash(RECIPIENT, 500_000n, 12, '0x' + 'cd'.repeat(32))).not.toBe(dasar);
    });

    it('checksum alamat tidak mengubah hasil (address di-normalisasi ABI coder)', () => {
      const a = service.computeLeafHash(RECIPIENT, 500_000n, 12, NIK_HASH);
      const b = service.computeLeafHash(RECIPIENT.toLowerCase(), 500_000n, 12, NIK_HASH);
      expect(a).toBe(b);
    });
  });

  describe('buildRoot', () => {
    it('daftar kosong -> bytes32(0)', () => {
      expect(service.buildRoot([])).toBe('0x' + '0'.repeat(64));
    });

    it('satu leaf -> leaf itu sendiri jadi root', () => {
      const leaf = leafDummy(0);
      expect(service.buildRoot([leaf])).toBe(leaf);
    });

    it('dua leaf -> keccak256 dari pasangan yang diurutkan', () => {
      const l0 = leafDummy(0);
      const l1 = leafDummy(1);
      const [a, b] = [l0, l1].sort();
      expect(service.buildRoot([l0, l1])).toBe(keccak256(concat([a, b])));
    });

    it('deterministik untuk daftar yang sama', () => {
      const leaves = Array.from({ length: 7 }, (_, i) => leafDummy(i));
      expect(service.buildRoot(leaves)).toBe(service.buildRoot(leaves));
    });

    it('root berubah kalau salah satu leaf berubah', () => {
      const leaves = Array.from({ length: 5 }, (_, i) => leafDummy(i));
      const diubah = [...leaves];
      diubah[2] = leafDummy(99);
      expect(service.buildRoot(diubah)).not.toBe(service.buildRoot(leaves));
    });
  });

  describe('generateProof', () => {
    // Jumlah leaf ganjil/genap dan bukan pangkat dua ikut diuji: konstruksi pohon
    // di sini "menaikkan" elemen ganjil terakhir ke layer berikutnya, jalur yang
    // paling gampang salah saat menghitung indeks sibling.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17]) {
      it(`proof tiap leaf terverifikasi terhadap root (n = ${n})`, () => {
        const leaves = Array.from({ length: n }, (_, i) => leafDummy(i));
        const root = service.buildRoot(leaves);

        for (let i = 0; i < n; i++) {
          const proof = service.generateProof(leaves, i);
          expect(verifikasiManual(leaves[i], proof, root)).toBe(true);
        }
      });
    }

    it('proof milik leaf lain tidak lolos verifikasi', () => {
      const leaves = Array.from({ length: 6 }, (_, i) => leafDummy(i));
      const root = service.buildRoot(leaves);
      const proof = service.generateProof(leaves, 1);
      expect(verifikasiManual(leaves[4], proof, root)).toBe(false);
    });

    it('leaf palsu dengan proof sah tetap ditolak', () => {
      const leaves = Array.from({ length: 5 }, (_, i) => leafDummy(i));
      const root = service.buildRoot(leaves);
      const proof = service.generateProof(leaves, 2);
      expect(verifikasiManual(leafDummy(1000), proof, root)).toBe(false);
    });

    it('pohon satu leaf menghasilkan proof kosong', () => {
      expect(service.generateProof([leafDummy(0)], 0)).toEqual([]);
    });
  });

  describe('checkInvariants — 05-Algorithm-Design.md §5.4', () => {
    function leaves(jumlah: number, amount = 500_000n): MerkleLeaf[] {
      return Array.from({ length: jumlah }, (_, i) => ({
        recipient: `0x${String(i + 1).padStart(40, '0')}`,
        amount,
        periodeId: 12,
        nikHash: '0x' + String(i).padStart(64, '0'),
        leafHash: leafDummy(i),
      }));
    }

    it('semua invarian lolos untuk alokasi yang konsisten', () => {
      const hasil = service.checkInvariants(leaves(3), 1_500_000, 2_000_000, 3);
      expect(hasil.every((i) => i.lolos)).toBe(true);
    });

    it('gagal kalau Σ amount ≠ total_alokasi', () => {
      const hasil = service.checkInvariants(leaves(3), 9_999_999, 20_000_000, 3);
      expect(hasil.find((i) => i.nama === 'sum_amount_eq_total_alokasi')?.lolos).toBe(false);
    });

    it('gagal kalau total_alokasi melebihi anggaran efektif', () => {
      const hasil = service.checkInvariants(leaves(3), 1_500_000, 1_000_000, 3);
      expect(hasil.find((i) => i.nama === 'total_alokasi_lte_anggaran_efektif')?.lolos).toBe(false);
    });

    it('gagal kalau ada wallet duplikat (satu KK bisa kehilangan haknya)', () => {
      const duplikat = leaves(3);
      duplikat[2].recipient = duplikat[0].recipient;
      const hasil = service.checkInvariants(duplikat, 1_500_000, 2_000_000, 3);
      expect(hasil.find((i) => i.nama === 'wallet_unik')?.lolos).toBe(false);
    });

    it('perbedaan huruf besar/kecil alamat tetap dihitung duplikat', () => {
      const duplikat = leaves(2);
      duplikat[1].recipient = duplikat[0].recipient.toUpperCase().replace('0X', '0x');
      const hasil = service.checkInvariants(duplikat, 1_000_000, 2_000_000, 2);
      expect(hasil.find((i) => i.nama === 'wallet_unik')?.lolos).toBe(false);
    });

    it('gagal kalau jumlah leaf ≠ kuota penerima', () => {
      const hasil = service.checkInvariants(leaves(3), 1_500_000, 2_000_000, 4);
      expect(hasil.find((i) => i.nama === 'leaves_eq_kuota')?.lolos).toBe(false);
    });

    it('gagal kalau ada amount nol', () => {
      const nol = leaves(2);
      nol[1].amount = 0n;
      const hasil = service.checkInvariants(nol, 500_000, 2_000_000, 2);
      expect(hasil.find((i) => i.nama === 'semua_amount_positif')?.lolos).toBe(false);
    });
  });
});
