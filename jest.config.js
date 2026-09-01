/** Unit test murni (tanpa database) untuk modul algoritma & Merkle.
 *  Dijalankan lewat `npm test`; lihat 15-Checklist-Belum-Terimplementasi.md item J. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
