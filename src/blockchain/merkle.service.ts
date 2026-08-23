import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { keccak256, AbiCoder, concat, toBeHex, zeroPadValue } from 'ethers';

export interface MerkleLeaf {
  recipient: string;
  amount: bigint;
  periodeId: number;
  nikHash: string;
  leafHash: string;
}

export interface Invarian {
  nama: string;
  lolos: boolean;
  detail: string;
}

@Injectable()
export class MerkleService {
  private readonly logger = new Logger(MerkleService.name);
  private readonly abiCoder = AbiCoder.defaultAbiCoder();

  /**
   * Compute a leaf hash matching the Solidity contract:
   * keccak256(bytes.concat(keccak256(abi.encode(recipient, amount, periodeId, nikHash))))
   */
  computeLeafHash(
    recipient: string,
    amount: bigint,
    periodeId: number,
    nikHash: string,
  ): string {
    const encoded = this.abiCoder.encode(
      ['address', 'uint256', 'uint256', 'bytes32'],
      [recipient, amount, periodeId, nikHash],
    );
    const innerHash = keccak256(encoded);
    return keccak256(concat([innerHash]));
  }

  /**
   * Build a simple Merkle root from an array of leaf hashes.
   * Uses a standard bottom-up binary tree construction.
   */
  buildRoot(leafHashes: string[]): string {
    if (leafHashes.length === 0) return '0x' + '0'.repeat(64);
    if (leafHashes.length === 1) return leafHashes[0];

    let layer = [...leafHashes];

    while (layer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        if (i + 1 < layer.length) {
          // Sort pair to ensure deterministic ordering (OpenZeppelin convention)
          const [a, b] = [layer[i], layer[i + 1]].sort();
          nextLayer.push(keccak256(concat([a, b])));
        } else {
          // Odd element gets promoted
          nextLayer.push(layer[i]);
        }
      }
      layer = nextLayer;
    }

    return layer[0];
  }

  /**
   * Generate a Merkle proof for a specific leaf.
   */
  generateProof(leafHashes: string[], targetIndex: number): string[] {
    if (leafHashes.length <= 1) return [];

    const proof: string[] = [];
    let layer = [...leafHashes];
    let idx = targetIndex;

    while (layer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        if (i + 1 < layer.length) {
          const [a, b] = [layer[i], layer[i + 1]].sort();
          nextLayer.push(keccak256(concat([a, b])));
          // If our target is in this pair, add the sibling to proof
          if (i === idx || i + 1 === idx) {
            proof.push(i === idx ? layer[i + 1] : layer[i]);
          }
        } else {
          nextLayer.push(layer[i]);
        }
      }
      idx = Math.floor(idx / 2);
      layer = nextLayer;
    }

    return proof;
  }

  /**
   * Check allocation invariants before on-chain submission.
   */
  checkInvariants(
    leaves: MerkleLeaf[],
    totalAlokasi: number,
    anggaranEfektif: number,
    kuotaPenerima: number,
  ): Invarian[] {
    const invariants: Invarian[] = [];

    // 1. Sum amount == total alokasi
    const sumAmount = leaves.reduce((s, l) => s + Number(l.amount), 0);
    invariants.push({
      nama: 'sum_amount_eq_total_alokasi',
      lolos: Math.abs(sumAmount - totalAlokasi) < 1,
      detail: `Sum amount: ${sumAmount}, Total alokasi: ${totalAlokasi}`,
    });

    // 2. Total alokasi <= anggaran efektif
    invariants.push({
      nama: 'total_alokasi_lte_anggaran_efektif',
      lolos: totalAlokasi <= anggaranEfektif,
      detail: `Total alokasi: ${totalAlokasi}, Anggaran efektif: ${anggaranEfektif}`,
    });

    // 3. Wallet addresses unique
    const wallets = new Set(leaves.map((l) => l.recipient.toLowerCase()));
    invariants.push({
      nama: 'wallet_unik',
      lolos: wallets.size === leaves.length,
      detail: `Unique wallets: ${wallets.size}, Total leaves: ${leaves.length}`,
    });

    // 4. Leaves count == kuota penerima
    invariants.push({
      nama: 'leaves_eq_kuota',
      lolos: leaves.length === kuotaPenerima,
      detail: `Leaves: ${leaves.length}, Kuota: ${kuotaPenerima}`,
    });

    // 5. All amounts > 0
    const allPositive = leaves.every((l) => Number(l.amount) > 0);
    invariants.push({
      nama: 'semua_amount_positif',
      lolos: allPositive,
      detail: allPositive ? 'Semua amount > 0' : 'Terdapat amount <= 0',
    });

    return invariants;
  }
}
