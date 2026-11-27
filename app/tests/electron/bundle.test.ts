import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';

describe('bundled Electron scripts', () => {
  it('the preload stands alone: a sandboxed preload can only require "electron"', async () => {
    await build({ configFile: path.resolve('vite.electron.config.ts'), logLevel: 'silent' });
    const preload = fs.readFileSync(path.resolve('dist/electron/preload.cjs'), 'utf8');
    const requires = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    expect(requires).toEqual(['electron']);
    expect(preload).toContain('exposeInMainWorld');
    expect(fs.existsSync(path.resolve('dist/electron/main.cjs'))).toBe(true);
  }, 60_000);
});
