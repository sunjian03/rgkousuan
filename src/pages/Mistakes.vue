<script setup>
/**
 * Mistakes.vue —— 错题本（D6，对应原型 docs/mistakes.html）
 * 概览统计、时间/知识点筛选、三种排序、单题重练与整卷重练。
 * 页面层只调用 2.4 接口：wrongbook.review / buildReviewPaper，
 * 重练经草稿通道进入答题页（D4 复用，NFR-06）。
 *
 * 一致性说明：
 * - 时间筛选映射 review 的 dateRange（按 lastWrongAt）；今天/本周/本月
 *   口径与统计服务一致（1/7/30 个日历日）；
 * - 错题条目按设计报告 3.2.1 只存题目快照与状态，未存「当时的错误答案」，
 *   卡片展示题目 + 正确答案（原型中红色错误答案一项不还原）；
 * - 「来自」按题目快照 source 标记区分（今日练习 / 错题重练）。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { store, repo } from '../store.js';
import { WrongBook } from '../core/wrongbook.js';
import { listKnowledgePoints } from '../core/generator.js';

const router = useRouter();
const ALL_KPS = listKnowledgePoints();
const kpNameOf = (id) => ALL_KPS.find((k) => k.id === id)?.name ?? '口算练习';
const kpShortOf = (id) => {
  const name = kpNameOf(id);
  return name.length > 8 ? name.slice(0, 8) + '…' : name;
};

const wrongbook = new WrongBook(repo, { profileId: store.currentProfileId });
const pid = store.currentProfileId;
const profile = store.currentProfile;

// ---- 筛选与排序状态 ----
const TIME_OPTS = ['全部', '今天', '本周', '本月'];
const SORT_OPTS = ['错误次数最多', '最近出错', '按知识点分组'];
const filterTime = ref('全部');
const filterKp = ref('全部');
const sortMode = ref('错误次数最多');
const showSort = ref(false);
const reviewingId = ref(null); // 单题重练按钮反馈态

/** 时间筛选 → review.dateRange（今天/本周/本月 = 1/7/30 个日历日） */
function rangeOf() {
  if (filterTime.value === '全部') {
    return null;
  }
  const days = filterTime.value === '今天' ? 0 : filterTime.value === '本周' ? 6 : 29;
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
  return { from, to: Date.now() };
}

/** 全部待巩固错题（未筛选） */
const allActive = computed(() => wrongbook.review({ profileId: pid, status: 'active' }));
/** 按筛选条件取数（默认 active；排序在页面层实现三种模式） */
const filtered = computed(() => {
  const range = rangeOf();
  const list = wrongbook.review({
    profileId: pid,
    kpId: filterKp.value === '全部' ? undefined : filterKp.value,
    dateRange: range ?? undefined,
  });
  if (sortMode.value === '最近出错') {
    return [...list].sort((a, b) => b.lastWrongAt - a.lastWrongAt);
  }
  if (sortMode.value === '按知识点分组') {
    const groupWeight = new Map();
    for (const it of list) {
      groupWeight.set(it.kpId, (groupWeight.get(it.kpId) || 0) + it.wrongCount);
    }
    const rank = [...groupWeight.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const pos = new Map(rank.map((k, i) => [k, i]));
    return [...list].sort((a, b) => pos.get(a.kpId) - pos.get(b.kpId) || b.wrongCount - a.wrongCount || b.lastWrongAt - a.lastWrongAt);
  }
  return [...list].sort((a, b) => b.wrongCount - a.wrongCount || b.lastWrongAt - a.lastWrongAt);
});

// ---- 概览统计（全部时间口径，与原型一致） ----
const masteredCount = computed(() => wrongbook.review({ profileId: pid, status: 'mastered' }).length);
const weakKpCount = computed(() => new Set(allActive.value.map((it) => it.kpId)).size);
const kpChips = computed(() => [...new Set(allActive.value.map((it) => it.kpId))]);

/** 时间显示：今天 HH:MM / 昨天 HH:MM / M 月 D 日 */
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (day(d) === day(now)) {
    return `今天 ${hh}:${mm}`;
  }
  if (day(d) === day(now) - 86400000) {
    return `昨天 ${hh}:${mm}`;
  }
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 单题重练：题目快照入草稿（source 标记 'wrong'），经 D4 通道练习 */
function startSingle(item) {
  reviewingId.value = item._id;
  repo.saveDraft(pid, { paper: [{ ...item.question, source: 'wrong' }], answers: [], startedAt: Date.now() });
  setTimeout(() => router.push('/practice'), 450);
}

/** 整卷重练：buildReviewPaper（2.4 M3，按累计错次取前 N）→ 草稿 → 答题页 */
function startAll() {
  if (filtered.value.length === 0) {
    return;
  }
  const paper = wrongbook.buildReviewPaper(filtered.value.length, pid);
  if (paper.length === 0) {
    return;
  }
  repo.saveDraft(pid, { paper, answers: [], startedAt: Date.now() });
  router.push('/practice');
}

function resetFilter() {
  filterTime.value = '全部';
  filterKp.value = '全部';
}
</script>

<template>
  <div>
    <!-- 顶部 -->
    <header class="bg-white px-5 pb-0 pt-4">
      <div class="flex items-center justify-between">
        <router-link to="/" class="flex h-9 w-9 items-center justify-center rounded-full bg-[#FBF6EE] text-[#8B7565]">‹</router-link>
        <div class="text-center">
          <h1 class="text-[16px] font-extrabold leading-tight">错题本</h1>
          <p class="text-[10px] text-[#B6A190]">{{ profile?.nickname }} · {{ ['一', '二', '三'][profile?.grade - 1] ?? '一' }}年级{{ profile?.semester }}</p>
        </div>
        <button class="flex h-9 w-9 items-center justify-center rounded-full bg-[#FBF6EE] text-[#8B7565]" @click="showSort = true">⇅</button>
      </div>
      <!-- 概览 -->
      <div class="mt-3 flex gap-2">
        <div class="flex-1 rounded-2xl bg-[#FFF4E9] px-3 py-2">
          <p class="text-[17px] font-extrabold leading-none text-[#D1793F]">{{ allActive.length }} <span class="text-[10px] font-medium text-[#B08F76]">道</span></p>
          <p class="mt-1 text-[10px] text-[#A99079]">待重练</p>
        </div>
        <div class="flex-1 rounded-2xl bg-[#F2F7F2] px-3 py-2">
          <p class="text-[17px] font-extrabold leading-none text-[#6A9A79]">{{ masteredCount }} <span class="text-[10px] font-medium text-[#8AA895]">道</span></p>
          <p class="mt-1 text-[10px] text-[#7D9A87]">已订正</p>
        </div>
        <div class="flex-1 rounded-2xl bg-[#F8F5FB] px-3 py-2">
          <p class="text-[17px] font-extrabold leading-none text-[#8E7BB3]">{{ weakKpCount }} <span class="text-[10px] font-medium text-[#A79BBF]">个</span></p>
          <p class="mt-1 text-[10px] text-[#9A8DB0]">薄弱知识点</p>
        </div>
      </div>
      <!-- 时间筛选 -->
      <div class="mt-3 flex items-center gap-2">
        <span class="shrink-0 text-[11px] text-[#B6A190]">时间</span>
        <div class="flex gap-1.5 overflow-x-auto">
          <button
            v-for="t in TIME_OPTS"
            :key="t"
            class="whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-semibold transition"
            :class="filterTime === t ? 'bg-[#E9824C] text-white' : 'bg-[#FBF3E9] text-[#8B7565]'"
            @click="filterTime = t"
          >
            {{ t }}
          </button>
        </div>
      </div>
    </header>

    <main class="px-5 pb-32 pt-3">
      <!-- 知识点筛选 -->
      <div class="mb-3 flex items-center gap-2">
        <span class="shrink-0 text-[11px] text-[#B6A190]">知识点</span>
        <div class="flex gap-1.5 overflow-x-auto pb-0.5">
          <button
            class="whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] font-semibold transition"
            :class="filterKp === '全部' ? 'border-[#4B3B32] bg-[#4B3B32] text-white' : 'border-[#F0E3D5] bg-white text-[#8B7565]'"
            @click="filterKp = '全部'"
          >
            全部
          </button>
          <button
            v-for="id in kpChips"
            :key="id"
            class="whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] font-semibold transition"
            :class="filterKp === id ? 'border-[#4B3B32] bg-[#4B3B32] text-white' : 'border-[#F0E3D5] bg-white text-[#8B7565]'"
            @click="filterKp = id"
          >
            {{ kpShortOf(id) }}
          </button>
        </div>
      </div>

      <div class="mb-2.5 flex items-center justify-between">
        <p class="text-[11px] text-[#A99079]">
          共 <span class="font-bold text-[#4B3B32]">{{ filtered.length }}</span> 道错题 · 按{{ sortMode }}排序
        </p>
      </div>

      <!-- 空状态 -->
      <div v-if="filtered.length === 0" class="card p-8 text-center">
        <p class="text-[38px]">🎉</p>
        <p class="mt-2 text-[14px] font-bold">这个范围内没有错题</p>
        <p class="mt-1 text-[11px] text-[#A99079]">真棒！换个筛选条件看看其它记录吧</p>
        <button class="mt-3 h-9 rounded-full bg-[#FBF1E6] px-4 text-[11px] font-semibold text-[#C97B49]" @click="resetFilter">重置筛选</button>
      </div>

      <!-- 错题列表 -->
      <div class="space-y-2.5">
        <div v-for="it in filtered" :key="it._id" class="card p-3.5">
          <div class="flex items-start justify-between">
            <div class="flex items-center gap-2">
              <span class="rounded-full bg-[#F5F1EC] px-2 py-0.5 text-[10px] font-semibold text-[#8B7565]">{{ kpShortOf(it.kpId) }}</span>
              <span v-if="it.wrongCount >= 3" class="rounded-full bg-[#FDECEC] px-2 py-0.5 text-[10px] font-semibold text-[#D4796A]">高频</span>
            </div>
            <span class="text-[10px] text-[#B6A190]">{{ fmtTime(it.lastWrongAt) }}</span>
          </div>
          <div class="mt-2.5 flex items-end justify-between">
            <div class="min-w-0">
              <p class="text-[22px] font-extrabold leading-tight tracking-wide">{{ it.question.expression }}</p>
              <p class="mt-1 flex items-center gap-1 text-[11px] text-[#7D9A87]">
                ✔ 正确答案 <span class="font-bold">{{ it.question.presentMode === 'blank' ? it.question.blankAnswer : it.question.answer }}</span>
              </p>
            </div>
            <button
              class="h-8 shrink-0 rounded-full px-3.5 text-[11px] font-bold text-white"
              :class="reviewingId === it._id ? 'bg-[#7BAE8B]' : 'bg-[#E9824C]'"
              @click="startSingle(it)"
            >
              {{ reviewingId === it._id ? '已加入 ✓' : '重练' }}
            </button>
          </div>
          <div class="mt-2.5 flex items-center justify-between border-t border-[#F7EEE3] pt-2 text-[10px] text-[#B6A190]">
            <span>来自「{{ it.question.source === 'wrong' ? '错题重练' : '今日练习' }}」</span>
            <span>共错 {{ it.wrongCount }} 次</span>
          </div>
        </div>
      </div>

      <!-- 整卷重练 -->
      <div v-if="filtered.length > 0" class="mb-2 mt-4">
        <button
          class="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-[#F3D3B4] bg-[#FFF2E6] py-3.5 text-[14px] font-bold text-[#C97B49]"
          @click="startAll"
        >
          ▶ 一次重练这 {{ filtered.length }} 道题
        </button>
        <p class="mt-2 text-center text-[10px] text-[#B6A190]">重练后连续答对 3 次，错题会自动移出错题本（3.3.4 巩固规则）</p>
      </div>
    </main>

    <!-- 排序底部弹层 -->
    <div v-if="showSort" class="fixed inset-0 z-50 flex items-end bg-black/30" @click.self="showSort = false">
      <div class="w-full rounded-t-3xl bg-white p-5 pb-6">
        <div class="mx-auto mb-4 h-1 w-10 rounded-full bg-[#EDE2D6]"></div>
        <h3 class="mb-3 text-[14px] font-bold">排序方式</h3>
        <div class="space-y-1">
          <button
            v-for="s in SORT_OPTS"
            :key="s"
            class="flex w-full items-center justify-between py-3 text-[13px] text-[#4B3B32]"
            @click="sortMode = s; showSort = false"
          >
            {{ s }} <span :class="sortMode === s ? 'text-[#E9824C]' : 'text-transparent'">✔</span>
          </button>
        </div>
        <button class="mt-3 h-11 w-full rounded-xl bg-[#FBF3E9] text-[13px] font-semibold text-[#8B7565]" @click="showSort = false">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference '../style.css';

.card {
  background: #fff;
  border-radius: 22px;
  border: 1px solid #f6eadc;
  box-shadow: 0 6px 18px rgba(139, 112, 86, 0.06);
}
</style>
