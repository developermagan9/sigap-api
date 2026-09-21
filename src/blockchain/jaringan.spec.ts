import { explorerBase, namaJaringan, periodeIdNumerik } from './blockchain.service';

describe('namaJaringan', () => {
  it('memetakan chain id yang dikenal', () => {
    expect(namaJaringan(80002)).toBe('polygon-amoy');
    expect(namaJaringan(137)).toBe('polygon');
    expect(namaJaringan(31337)).toBe('hardhat-local');
  });

  it('tidak mengaku Amoy untuk chain yang tidak dikenal', () => {
    expect(namaJaringan(11155111)).toBe('chain-11155111');
  });
});

describe('explorerBase', () => {
  const asli = { ...process.env };
  afterEach(() => {
    process.env = { ...asli };
  });

  it('default Polygonscan Amoy', () => {
    delete process.env.EXPLORER_BASE_URL;
    delete process.env.CHAIN_ID;
    expect(explorerBase()).toBe('https://amoy.polygonscan.com');
  });

  it('chain lokal Hardhat tidak punya explorer', () => {
    delete process.env.EXPLORER_BASE_URL;
    process.env.CHAIN_ID = '31337';
    expect(explorerBase()).toBeNull();
  });

  it('EXPLORER_BASE_URL eksplisit selalu menang', () => {
    process.env.CHAIN_ID = '31337';
    process.env.EXPLORER_BASE_URL = 'http://localhost:4000';
    expect(explorerBase()).toBe('http://localhost:4000');
  });
});

describe('periodeIdNumerik', () => {
  it('delapan hex pertama UUID mod 1_000_000 — harus sama dengan yang dikunci on-chain', () => {
    // f77328e2 = 4151519458 -> 519458; terverifikasi terhadap registerPeriode() di chain lokal.
    expect(periodeIdNumerik('f77328e2-982e-4803-b49a-bb9a110a5ab5')).toBe(519458);
  });
});
