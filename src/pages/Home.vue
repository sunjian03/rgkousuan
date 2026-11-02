<script setup>
/**
 * Home.vue —— 首页（D2，对应原型 docs/home.html）
 * 家长模式入口页：档案切换（FR-09 多档案）、今日练习卡片（草稿续练/
 * 今日成绩/开始练习）、一键出题、学习工具入口。
 * 页面层只调用 2.4 接口：repository / wrongbook / stats / achievement。
 */
import { computed, ref } from 'vue';
import { store, repo } from '../store.js';
import { AVATARS, avatarOf } from '../avatars.js';
import { WrongBook } from '../core/wrongbook.js';
import { StatsService } from '../core/stats.js';
import { AchievementService } from '../core/achievement.js';
import { listKnowledgePoints } from '../core/generator.js';

const showKidList = ref(false);

const wrongbook = new WrongBook(repo, { profileId: store.currentProfileId });
const stats = new StatsService(repo);
const achievement = new AchievementService(repo);

const profiles = computed(() => repo.load('profiles'));
const profile = computed(() => store.currentProfile);
const avatar = computed(() => avatarOf(profiles.value, store.currentProfileId));

/** 档案卡片的元信息：年级学期 + 已练习天数（打卡天数） */
const profileMeta = computed(() => {
  if (!profile.value) {
    return '';
  }
  const gradeName = ['一', '二', '三'][profile.value.grade - 1] ?? '一';
  const ach = repo.load('achievements', 'ach__' + profile.value._id);
  const days = ach?.checkinDates?.length ?? 0;
  return `${gradeName}年级${profile.value.semester} · 已练习 ${days} 天`;
});

/** 连击天数（连续打卡，M6 同款算法） */
const streakDays = computed(() => {
  if (!profile.value) {
    return 0;
  }
  const ach = repo.load('achievements', 'ach__' + profile.value._id);
  return achievement.streakOf(ach?.checkinDates ?? [], achievement.fmtDate(Date.now()));
});

/** 未完成草稿（NFR-06 离线中断恢复） */
const draft = computed(() => (store.currentProfileId ? repo.loadDraft(store.currentProfileId) : null));

/** 今日练习汇总（3.3.5 日报告） */
const todayReport = computed(() =>
  store.currentProfileId ? stats.getReport(store.currentProfileId, 'day').summary : null
);

/** 今日练习卡片状态 */
const todayState = computed(() => {
  if (draft.value) {
    const done = draft.value.answers?.length ?? 0;
    return { type: 'draft', title: '上次练习进行中', done, total: draft.value.paper?.length ?? 0, badge: '进行中', btn: '继续练习', to: '/practice' };
  }
  const r = todayReport.value;
  if (r && r.practiceCount > 0) {
    return { type: 'done', title: '今日已完成练习', done: r.practiceCount, total: Math.max(r.practiceCount, 1), badge: '已完成', btn: '再练一组', to: '/setup' };
  }
  return { type: 'new', title: '开始今日练习', done: 0, total: 1, badge: '未开始', btn: '开始练习', to: '/setup' };
});

/** 推荐知识点：该学期内掌握度最低（未练习优先），学习报告「薄弱环节」一致逻辑 */
const recommendKp = computed(() => {
  if (!profile.value) {
    return null;
  }
  const kps = listKnowledgePoints(profile.value.semester);
  let best = kps[0];
  let bestScore = Infinity;
  for (const kp of kps) {
    const m = stats.getMastery(profile.value._id, kp.id);
    const score = m === null ? -1 : m; // 未练习视为最需练习
    if (score < bestScore) {
      bestScore = score;
      best = kp;
    }
  }
  return best;
});

/** 待重练错题数（错题本入口角标） */
const activeWrongCount = computed(() =>
  store.currentProfileId ? wrongbook.review({ profileId: store.currentProfileId }).length : 0
);

function switchKid() {
  showKidList.value = !showKidList.value;
}
function pickKid(id) {
  store.currentProfileId = id;
  showKidList.value = false;
}

const today = new Date();
const todayText = `${today.getMonth() + 1}月${today.getDate()}日`;
</script>

<template>
  <div>
    <!-- 顶部栏（原型同款） -->
    <header class="px-5 pb-3 pt-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="flex h-9 w-9 items-center justify-center rounded-2xl bg-[#E9824C] text-white shadow-sm">🧮</div>
          <div>
            <p class="text-[15px] font-extrabold leading-tight">口算天天练</p>
            <p class="text-[10px] leading-tight text-[#B6A190]">家长模式 · 安心陪伴</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <router-link to="/calendar" class="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#8B7565] shadow-sm">📅</router-link>
          <router-link to="/parent" class="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#8B7565] shadow-sm">⚙️</router-link>
        </div>
      </div>

      <!-- 档案切换卡片 -->
      <div class="mt-4 rounded-2xl bg-white px-3.5 py-3 shadow-sm">
        <div class="flex items-center justify-between">
          <button class="flex items-center gap-3 text-left" @click="switchKid">
            <div class="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FBE0CB] text-2xl">{{ avatar }}</div>
            <div>
              <div class="flex items-center gap-1.5">
                <p class="text-[15px] font-bold">{{ profile?.nickname }}</p>
                <span class="text-xs text-[#C0AC9B]">▼</span>
              </div>
              <p class="mt-0.5 text-[11px] text-[#8B7565]">{{ profileMeta }}</p>
            </div>
          </button>
          <span class="rounded-full bg-[#F3F7F1] px-2.5 py-1 text-xs font-semibold text-[#6A9A79]">
            🔥 连击 {{ streakDays }} 天
          </span>
        </div>
        <div v-if="showKidList" class="mt-3 flex gap-2 border-t border-[#F5E9DC] pt-3">
          <button
            v-for="(p, i) in profiles"
            :key="p._id"
            class="flex-1 rounded-2xl border px-3 py-2 text-left"
            :class="p._id === store.currentProfileId ? 'border-[#E9824C] bg-[#FFF7EF]' : 'border-[#EAE3DA] bg-[#F8F8F6]'"
            @click="pickKid(p._id)"
          >
            <p class="text-[13px] font-bold">{{ AVATARS[i % AVATARS.length] }} {{ p.nickname }}</p>
            <p class="text-[10px] text-[#8B7565]">{{ ['一', '二', '三'][p.grade - 1] }}年级{{ p.semester }}</p>
          </button>
          <router-link to="/parent" class="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-[#DCCBB8] px-3 py-2 text-[#A99079]">
            <span>＋</span>
            <span class="mt-0.5 text-[10px]">添加档案</span>
          </router-link>
        </div>
      </div>
    </header>

    <main class="px-5 pb-5">
      <!-- 今日练习卡片 -->
      <section class="relative overflow-hidden rounded-2xl bg-white p-4 shadow-sm">
        <div class="absolute -right-6 -top-8 h-24 w-24 rounded-full bg-[#FBEFE2]"></div>
        <div class="relative">
          <div class="flex items-start justify-between">
            <div>
              <p class="text-[11px] font-semibold text-[#B08F76]">今日练习 · {{ todayText }}</p>
              <h2 class="mt-1 text-[19px] font-extrabold">{{ recommendKp?.name ?? '口算练习' }}</h2>
              <p class="mt-1 text-[11px] text-[#8B7565]">
                {{ profile?.semester }} · {{ todayState.type === 'draft' ? '上次练习未完成，可继续' : todayState.type === 'done' ? '今日已打卡，保持节奏' : '每天进步一点点' }}
              </p>
            </div>
            <span class="rounded-full px-2.5 py-1 text-xs font-semibold"
              :class="todayState.type === 'done' ? 'bg-[#F3F7F1] text-[#6A9A79]' : 'bg-[#FDF1E5] text-[#D1793F]'">
              {{ todayState.badge }}
            </span>
          </div>
          <div class="mt-3.5 flex items-end justify-between">
            <div class="flex items-baseline gap-1">
              <span class="text-[26px] font-extrabold leading-none text-[#E9824C]">{{ todayState.done }}</span>
              <span class="text-[12px] text-[#A99079]">
                {{ todayState.type === 'done' ? '组 今日练习' : '/ ' + todayState.total + ' 道' }}
              </span>
            </div>
            <span v-if="todayState.type === 'done'" class="text-[11px] text-[#8B7565]">
              正确率 {{ Math.round(todayReport.avgAccuracy * 100) }}%
            </span>
          </div>
          <div class="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-[#F6EDE3]">
            <div
              class="h-full rounded-full bg-gradient-to-r from-[#F5B98D] to-[#E9824C] transition-all"
              :style="{ width: Math.min(100, (todayState.done / todayState.total) * 100) + '%' }"
            ></div>
          </div>
          <div class="mt-4 flex gap-2">
            <router-link
              :to="todayState.to"
              class="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-[#E9824C] text-[15px] font-bold text-white transition active:scale-[.98]"
            >
              ▶ {{ todayState.btn }}
            </router-link>
            <router-link to="/setup" class="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#FBEFE2] text-lg text-[#C97B49]">
              🔀
            </router-link>
          </div>
        </div>
      </section>

      <!-- 一键出题 -->
      <router-link to="/setup" class="mt-3 flex items-center gap-3.5 rounded-2xl bg-white p-4 shadow-sm transition active:scale-[.99]">
        <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#F7C9A9] to-[#EFAF85] text-2xl text-white">✨</div>
        <div class="flex-1">
          <p class="text-[15px] font-extrabold">一键出题</p>
          <p class="mt-0.5 text-[11px] text-[#8B7565]">按学期自动组卷，30 道题只需 8 分钟</p>
        </div>
        <span class="text-[#C8B5A3]">›</span>
      </router-link>

      <!-- 学习工具 -->
      <section class="mt-5">
        <div class="mb-2.5 flex items-center justify-between">
          <h3 class="text-[14px] font-bold">学习工具</h3>
          <router-link to="/report" class="flex items-center gap-0.5 text-[11px] text-[#B08F76]">
            查看本周概览 <span>›</span>
          </router-link>
        </div>
        <div class="grid grid-cols-2 gap-2.5">
          <router-link to="/mistakes" class="flex items-center gap-2.5 rounded-2xl bg-white p-3.5 shadow-sm">
            <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-[#FCECE4] text-[#DE8A63]">📕</div>
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-bold">错题本</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">{{ activeWrongCount }} 道待重练</p>
            </div>
          </router-link>
          <router-link to="/report" class="flex items-center gap-2.5 rounded-2xl bg-white p-3.5 shadow-sm">
            <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-[#EFF4F0] text-[#7BAE8B]">📈</div>
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-bold">学习报告</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">正确率与掌握度</p>
            </div>
          </router-link>
          <router-link to="/print" class="flex items-center gap-2.5 rounded-2xl bg-white p-3.5 shadow-sm">
            <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-[#EDF1F8] text-[#7A8FB5]">🖨️</div>
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-bold">打印题纸</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">A4 打印离线练</p>
            </div>
          </router-link>
          <router-link to="/calendar" class="flex items-center gap-2.5 rounded-2xl bg-white p-3.5 shadow-sm">
            <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-[#FBF3E4] text-[#D9A94E]">🏅</div>
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-bold">打卡日历</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">连击 {{ streakDays }} 天</p>
            </div>
          </router-link>
        </div>
      </section>
    </main>
  </div>
</template>
