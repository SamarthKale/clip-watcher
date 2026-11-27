import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/server/**/*.test.ts', 'tests/e2e/**/*.test.ts', 'tests/electron/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000 },
});
