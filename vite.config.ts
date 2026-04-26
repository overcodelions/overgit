import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    // Off 5173 (overcli's dev port) and `strictPort` so we fail loudly if
    // it's also taken, rather than silently sliding to 5274 — the
    // dev:electron script bakes the URL in and won't follow.
    port: 5273,
    strictPort: true,
  },
});
