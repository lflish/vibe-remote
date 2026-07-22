import { defineConfig } from 'vite';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@net': path.resolve(__dirname, '../desktop/src/renderer'),
      '@shared': path.resolve(__dirname, '../desktop/src/shared'),
    },
  },
  build: { outDir: 'dist' },
});
