import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@net': path.resolve(__dirname, '../packages/core/src'),
      '@shared': path.resolve(__dirname, '../packages/core/src'),
    },
  },
  build: { outDir: 'dist' },
});
