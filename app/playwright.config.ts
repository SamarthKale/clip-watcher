import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/ui',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  // Uses the Microsoft Edge that ships with Windows, so no browser download is needed.
  use: { channel: 'msedge', headless: true },
});
