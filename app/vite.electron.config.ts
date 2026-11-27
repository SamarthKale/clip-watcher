import { defineConfig } from 'vite';

/** The Electron main and preload scripts, bundled and minified for the installed app (`dist/electron/`). */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    outDir: 'dist/electron',
    emptyOutDir: true,
    target: 'node22',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      input: { main: 'electron/main.cjs', preload: 'electron/preload.cjs' },
      external: ['electron'],
      output: { format: 'cjs', entryFileNames: '[name].cjs' },
    },
  },
});
