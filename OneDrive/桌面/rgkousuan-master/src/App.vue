<script setup>
/**
 * App.vue —— 根组件（D1）
 * 全局布局：移动端优先（设计报告 NFR-02 移动适配），内容区居中限宽，
 * 底部为主要功能导航（儿童模式 4 项；家长模式显示家长中心入口，FR-11）。
 */
import { onMounted } from 'vue';
import { store } from './store.js';

onMounted(() => {
  store.ensureProfile(); // 打开即用（AC-06：无需注册即可完成一次完整练习）
});
</script>

<template>
  <div class="min-h-screen bg-amber-50 font-sans text-slate-800">
    <div class="mx-auto flex min-h-screen w-full max-w-[393px] flex-col bg-amber-50 shadow-xl">
      <main class="flex-1 pb-20">
        <router-view />
      </main>
      <nav
        class="fixed bottom-0 left-1/2 z-50 w-full max-w-[393px] -translate-x-1/2 border-t border-amber-200 bg-white/95 backdrop-blur"
      >
        <div class="grid grid-cols-5 text-xs">
          <router-link to="/" class="nav-item" :class="{ active: $route.path === '/' }">
            <span class="text-xl">🏠</span>今日练习
          </router-link>
          <router-link to="/mistakes" class="nav-item" :class="{ active: $route.path === '/mistakes' }">
            <span class="text-xl">📕</span>错题本
          </router-link>
          <router-link to="/report" class="nav-item" :class="{ active: $route.path === '/report' }">
            <span class="text-xl">📊</span>学习报告
          </router-link>
          <router-link to="/calendar" class="nav-item" :class="{ active: $route.path === '/calendar' }">
            <span class="text-xl">📅</span>打卡日历
          </router-link>
          <router-link to="/parent" class="nav-item" :class="{ active: $route.path === '/parent' }">
            <span class="text-xl">👨‍👩‍👧</span>家长中心
          </router-link>
        </div>
      </nav>
    </div>
  </div>
</template>

<style scoped>
@reference './style.css';

.nav-item {
  @apply flex flex-col items-center gap-0.5 py-2 text-slate-500 transition-colors;
}
.nav-item.active {
  @apply text-orange-500;
}
</style>
