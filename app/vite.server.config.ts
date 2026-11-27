import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The upload server as one minified file for the installed app (`dist/server/index.mjs`).
 * npm packages stay external (they ship in node_modules); only our own code is bundled.
 * The SQL files the database reads at start-up are copied next to it.
 */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node22',
    minify: true,
    sourcemap: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } },
  },
  plugins: [
    {
      name: 'copy-sql',
      closeBundle() {
        const from = path.resolve('src/server/db');
        fs.copyFileSync(path.join(from, 'schema.sql'), path.resolve('dist/server/schema.sql'));
        fs.cpSync(path.join(from, 'migrations'), path.resolve('dist/server/migrations'), { recursive: true });
      },
    },
  ],
});
