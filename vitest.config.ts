import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live alongside the modules they exercise so finding +
    // editing them tracks the source.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Each test file gets a fresh memory.db via env override (see
    // tests/setup.ts) so they don't cross-contaminate.
    setupFiles: ['./tests/setup.ts'],
    environment: 'node',
    // Hard-path: tests must finish in 20s or they're a bug. The daemon's
    // claude -p calls are mocked at the runClaude boundary, never real.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/server/**/*.ts'],
      exclude: ['src/server/**/*.test.ts'],
    },
  },
});
