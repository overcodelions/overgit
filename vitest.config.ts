import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Separate from vite.config.ts because that one sets `root: src/renderer`
// for the renderer build, which would scope test discovery to the
// renderer tree and miss src/shared and src/main.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
