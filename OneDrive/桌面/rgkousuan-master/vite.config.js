import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// base 用相对路径：产物部署到任意子目录（GitHub Pages 的 /rgkousuan/）都能访问
// outDir 输出到仓库内 pages/ 目录：GitHub Pages 部署「gh-pages 分支」，
// 每次发布 = npm run deploy（build → git subtree push --prefix pages github gh-pages），
// GitHub 仓库 Settings → Pages 已固定选择 gh-pages 分支，推送后自动更新（E4 公开发布）
// 说明：Gitee 个人免费 Pages 服务已停用，改为 GitHub Pages；pages/ 目录保留在 master 中作构建记录
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
