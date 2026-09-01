import { validateEnv } from './env.validation';

/**
 * Regression test untuk temuan 2026-08-29: aplikasi berhasil start memakai
 * pepper/kunci/JWT secret yang tertulis di source code ketika variabel
 * lingkungannya lupa diisi — kegagalan yang tidak terlihat sama sekali dari luar.
 */
const LENGKAP = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  JWT_SECRET: 'a'.repeat(64),
  SYSTEM_PEPPER: 'b'.repeat(64),
  DB_ENCRYPTION_KEY: 'c'.repeat(64),
};

describe('validateEnv', () => {
  const asli = process.env;

  beforeEach(() => {
    // Env bersih tiap test — menyalin `asli` akan membawa nilai .env mesin dev.
    process.env = {} as NodeJS.ProcessEnv;
  });

  afterAll(() => {
    process.env = asli;
  });

  function pasang(over: Record<string, string | undefined> = {}) {
    Object.assign(process.env, LENGKAP, over);
  }

  describe('di production — harus fail-fast', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('lolos ketika seluruh variabel wajib benar', () => {
      pasang();
      expect(() => validateEnv()).not.toThrow();
    });

    for (const nama of Object.keys(LENGKAP)) {
      it(`menolak start ketika ${nama} kosong`, () => {
        pasang({ [nama]: undefined });
        expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
      });
    }

    it('menolak SYSTEM_PEPPER yang masih berisi nilai contoh .env.example', () => {
      pasang({ SYSTEM_PEPPER: 'change-me-to-a-64-char-hex-string' });
      expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
    });

    it('menolak JWT_SECRET yang masih berisi nilai contoh .env.example', () => {
      pasang({ JWT_SECRET: 'change-me-to-a-strong-random-string' });
      expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
    });

    it('menolak fallback hardcode lama sebagai nilai yang sah', () => {
      pasang({ SYSTEM_PEPPER: 'default-pepper-change-me' });
      expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
      pasang({ JWT_SECRET: 'sigap-secret' });
      expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
    });

    it('menolak DB_ENCRYPTION_KEY yang bukan 64 karakter hex', () => {
      pasang({ DB_ENCRYPTION_KEY: 'd'.repeat(32) });
      expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
      pasang({ DB_ENCRYPTION_KEY: 'z'.repeat(64) }); // 'z' bukan hex
      expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
    });

    it('menolak SYSTEM_PEPPER yang terlalu pendek', () => {
      pasang({ SYSTEM_PEPPER: 'abc123' });
      expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
    });

    it('menolak JWT_SECRET pendek walau bukan placeholder', () => {
      pasang({ JWT_SECRET: 'pendek' });
      expect(() => validateEnv()).toThrow(/Startup dibatalkan/);
    });

    it('kredensial blockchain kosong TIDAK menggagalkan start (mode simulasi sah)', () => {
      pasang();
      expect(() => validateEnv()).not.toThrow();
    });

    it('kredensial blockchain salah format tetap tidak menggagalkan start', () => {
      // Hanya diperingatkan: menghentikan seluruh aplikasi karena alamat kontrak
      // salah ketik terlalu keras — alur non-blockchain masih berguna sepenuhnya.
      pasang({ REGISTRY_CONTRACT_ADDRESS: '0xbukan-alamat' });
      expect(() => validateEnv()).not.toThrow();
    });
  });

  describe('di luar production — memperingatkan, bukan menghentikan', () => {
    it('tetap jalan walau seluruh variabel wajib kosong', () => {
      process.env.NODE_ENV = 'development';
      expect(() => validateEnv()).not.toThrow();
    });
  });
});
