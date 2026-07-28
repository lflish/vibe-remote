import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  // 阶段 2：mobile 改用共享 @vibe-remote/ui 的 React 视图（ChatView）。
  plugins: [react()],
  resolve: {
    alias: {
      // 阶段 0a：@net/@shared 从「反向引用 desktop 源码」改为指向共享 core 包。
      // @net/client → @vibe-remote/core/src/client，@shared/protocol → core/src/protocol。
      '@net': path.resolve(__dirname, '../packages/core/src'),
      '@shared': path.resolve(__dirname, '../packages/core/src'),
    },
  },
  build: { outDir: 'dist' },
});
