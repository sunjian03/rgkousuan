/**
 * router.js —— 路由表（D1）
 * 页面与原型一一对应（docs/ 下同名 html），Vue 化后仍保持同一套页面结构：
 * 首页 → 出题设置 → 答题 → 成绩，外加错题本/报告/打卡/家长中心/打印。
 */
import { createRouter, createWebHashHistory } from 'vue-router';

export const router = createRouter({
  // hash 模式：静态托管（GitHub Pages 等）无需服务端重写配置即可直接访问
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./pages/Home.vue') },
    { path: '/setup', name: 'setup', component: () => import('./pages/Setup.vue') },
    { path: '/practice', name: 'practice', component: () => import('./pages/Practice.vue') },
    { path: '/result', name: 'result', component: () => import('./pages/Result.vue') },
    { path: '/mistakes', name: 'mistakes', component: () => import('./pages/Mistakes.vue') },
    { path: '/report', name: 'report', component: () => import('./pages/Report.vue') },
    { path: '/calendar', name: 'calendar', component: () => import('./pages/Calendar.vue') },
    { path: '/parent', name: 'parent', component: () => import('./pages/Parent.vue') },
    { path: '/print', name: 'print', component: () => import('./pages/Print.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
