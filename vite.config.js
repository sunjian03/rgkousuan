import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// base 用相对路径：产物部署到任意子目录（Gitee Pages 的 /rgkousuan/）都能访问
// outDir 输出到仓库内 pages/ 目录：Gitee Pages 部署「master 分支 + pages 目录」，
// 每次发布 = npm run build → 提交 pages/ → 推送 → Gitee Pages 点更新（E4）
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'pages',
  },
});
