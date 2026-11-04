/**
 * main.js —— 应用入口（D1）
 * 挂载 Vue 应用 + 路由；页面层只通过 core 模块与 Repository 访问业务逻辑
 * （设计报告 2.4 接口约定），不直接读写 localStorage。
 */
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.js';
import './style.css';

createApp(App).use(router).mount('#app');
