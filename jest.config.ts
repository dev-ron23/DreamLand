import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts', '**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          strict: true,
          esModuleInterop: true,
          target: 'ES2020',
          module: 'commonjs',
        },
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/server.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
  restoreMocks: true,
};

export default config;
