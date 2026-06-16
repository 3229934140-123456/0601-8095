module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  collectCoverageFrom: [
    'services/**/*.js',
    'middleware/**/*.js',
    'models/**/*.js'
  ],
  coverageDirectory: 'coverage',
  testTimeout: 10000
};
