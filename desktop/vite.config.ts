import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  root: r('src/renderer'),
  build: {
    outDir: r('dist/renderer'),
    emptyOutDir: true,
  },
  plugins: [
    // React 插件作用于 renderer（阶段 1：聊天式 UI 用共享 @vibe-remote/ui React 组件）。
    react(),
    electron([
      {
        // Main process
        entry: r('src/main/index.ts'),
        vite: {
          build: {
            outDir: r('dist/main'),
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        // Preload script
        entry: r('src/main/preload.ts'),
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: r('dist/main'),
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
});
