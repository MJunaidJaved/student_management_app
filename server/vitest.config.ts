import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
     * Integration tests share one database and one pool. Running files in
     * parallel would exhaust the pool's connection ceiling and, worse, let two
     * files' fixtures interleave in the same tables. Single-threaded is slower
     * and correct.
     */
    fileParallelism: false,
    // Supabase is a network hop away; the default 5s is too tight for a suite
    // that opens transactions and runs EXPLAIN.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    // Runs once before any file. Stops the suite if live records are present.
    globalSetup: ['src/core/testing/refuse-real-data.ts'],
    env: {
      NODE_ENV: 'test',
    },
  },
});
