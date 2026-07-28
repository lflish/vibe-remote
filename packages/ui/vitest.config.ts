import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 第一期组件以桌面/web 真机冒烟为主；此项保证无单测时根级 test 不失败。
    passWithNoTests: true,
  },
});
