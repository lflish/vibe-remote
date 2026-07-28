import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 阶段 0a-1 骨架期尚无测试；0a-3 补齐 chat 内核测试后此项仍安全保留。
    passWithNoTests: true,
  },
});
