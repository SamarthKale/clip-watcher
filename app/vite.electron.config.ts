import { defineConfig, transformWithEsbuild } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Electron main and preload scripts, bundled and minified for the installed app (`dist/electron/`).
 * The preload is minified on its own: a sandboxed preload can require only 'electron', so it must not
 * share a chunk with main.
 */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'electron/main.cjs',
    outDir: 'dist/electron',
    emptyOutDir: true,
    target: 'node22',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: ['electron'],
      output: { format: 'cjs', entryFileNames: 'main.cjs' },
    },
  },
  plugins: [
    {
      name: 'standalone-preload',
      async closeBundle() {
        const src = fs.readFileSync(path.resolve('electron/preload.cjs'), 'utf8');
        const out = await transformWithEsbuild(src, 'preload.cjs', { loader: 'js', format: 'cjs', minify: true, target: 'node22' });
        fs.writeFileSync(path.resolve('dist/electron/preload.cjs'), out.code);
      },
    },
  ],
});
