<script setup>
/**
 * Result.vue —— 成绩页（D5，对应原型 docs/result.html）
 * 星星动画、正确率环形图、错题清单、小老师点评、再来一组/错题重练。
 * 页面层只调用 2.4 接口；挂载时执行设计报告 5.2 结束流程：
 *   错题入错题本（3.3.4 状态机）→ 巩固回写 → achievement.record（练习记录
 *   落库 + 星星 + 打卡 + 勋章）→ 近 3 次快照（R2）→ 消费 store.lastSession。
 *
 * 一致性说明：
 * - 错题重练卷/混合卷中错题题号带 'w' 前缀（generator 标记 source='wrong'），
 *   回写错题本时剥掉前缀，保证与 3.2.1 主键 pid__questionId 对齐、重复答错
 *   累加而非重复收录（页面层归一化，不改 core 契约）；
 * - 原型「超越 86% 同龄人」需要同龄数据（本应用 3.4 纯本地无后端），
 *   按 3.3.6 星级规则展示「星级 rating/5」作为等价激励；
 * - 结算只执行一次：消费后 lastSession 置空，刷新/回退重进会重定向首页，
 *   练习记录不会重复落库。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { store, repo } from '../store.js';
import { WrongBook } from '../core/wrongbook.js';
import { StatsService } from '../core/stats.js';
import { AchievementService } from '../core/achievement.js';
import { listKnowledgePoints } from '../core/generator.js';

const router = useRouter();
const ALL_KPS = listKnowledgePoints();
const kpOf = (id) => ALL_KPS.find((k) => k.id === id) ?? null;

const stats = new StatsService(repo);
const achievement = new AchievementService(repo);
const wrongbook = new WrongBook(repo, { profileId: store.currentProfileId });

// ---- 会话守卫：只结算一次 ----
const session = store.lastSession;
if (!session || !session.result) {
  router.replace('/');
}
const result = session?.result ?? null;
const questions = session?.questions ?? [];
const pid = store.currentProfileId;
const profile = store.currentProfile;

/** 剥掉错题题号的 'w' 前缀（generator 对 source='wrong' 的标记），对齐错题本主键 */
const stripW = (id) => (typeof id === 'string' && id.startsWith('w') ? id.slice(1) : id);

// ---- 挂载结算（5.2 流程图：错题入本 → 报告数据生成 → 打卡/激励） ----
const reward = ref(null);
const prevRecord = ref(null);
const autoWrong = profile?.prefs?.autoWrongToBook !== false;
/** 已收录标记（错题自动收录时为全部；手动模式点击「加入」后标记） */
const addedIds = reactive(new Set());

if (session && result && pid) {
  // 比上次：结算前取最近一次练习记录
  const prev = stats.recordsOf(pid);
  prevRecord.value = prev.length > 0 ? prev[prev.length - 1] : null;

  // 1) 错题入错题本（FR-05 自动收录；3.3.4 [*] --> active）
  if (autoWrong) {
    wrongbook.add(
      {
        wrongQuestions: result.wrongQuestions.map((w) => ({
          ...w,
          question: { ...w.question, id: stripW(w.question.id) },
        })),
      },
      pid
    );
    // 答对的题回写巩固连击（连续答对 3 次自动巩固，3.3.4）
    for (const d of result.detail) {
      if (d.answered && d.correct) {
        wrongbook.updateStreak(stripW(d.question.id), true, pid);
      }
    }
    for (const w of result.wrongQuestions) {
      addedIds.add(w.question.id);
    }
  }

  // 2) 练习记录落库 + 星星/星级/打卡/勋章（2.4 M6）
  reward.value = achievement.record(result, pid);

  // 3) 近 3 次练习快照（R2 防重复数据源）
  repo.saveRecentPapers(pid, questions);

  // 4) 消费会话，防止刷新/重进重复结算
  store.lastSession = null;
}

// ---- 展示数据 ----
const accuracyPct = computed(() => Math.round((result?.accuracy ?? 0) * 100));
const wrongCount = computed(() => (result ? result.total - result.correctCount : 0));
const avgSeconds = computed(() =>
  result && result.total > 0 ? (result.durationSeconds / result.total).toFixed(1) : '0'
);
const durationText = computed(() => {
  const s = result?.durationSeconds ?? 0;
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
});
const diffText = computed(() => {
  const prev = prevRecord.value;
  if (!prev || result.total === 0) {
    return '首次';
  }
  const d = result.correctCount - prev.score;
  return d > 0 ? `+${d}题` : d < 0 ? `${d}题` : '持平';
});
const streakDays = computed(() => reward.value?.checkin?.streakDays ?? 0);
/** 卷面知识点（多知识点只列第一个 + 等 N 个） */
const kpSummary = computed(() => {
  const ids = [...new Set(questions.map((q) => q.kpId))];
  if (ids.length === 0) {
    return '口算练习';
  }
  const first = kpOf(ids[0])?.name ?? '';
  return ids.length > 1 ? `${first} 等 ${ids.length} 个知识点` : first;
});
const profileLine = computed(() => {
  const g = ['一', '二', '三'][profile?.grade - 1] ?? '一';
  return `${profile?.nickname ?? ''} · ${g}年级${profile?.semester ?? ''}`;
});
const nowText = (() => {
  const d = new Date();
  const ap = d.getHours() < 12 ? '上午' : '下午';
  const hh = String(d.getHours() % 12 || 12).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${ap} ${hh}:${mm}`;
})();

/** 小老师点评：按本次错题最多的知识点给建议 */
const comment = computed(() => {
  if (!result) {
    return '';
  }
  if (result.correctCount === result.total) {
    return '全部答对，太厉害了！明天继续加油。';
  }
  const byKp = new Map();
  for (const w of result.wrongQuestions) {
    byKp.set(w.question.kpId, (byKp.get(w.question.kpId) || 0) + 1);
  }
  const top = [...byKp.entries()].sort((a, b) => b[1] - a[1])[0];
  const name = top ? kpOf(top[0])?.name ?? '这个知识点' : '这个知识点';
  if (result.accuracy >= 0.8) {
    return `整体表现不错！「${name}」错了 ${top[1]} 道，明天可以花几分钟专项练一练。`;
  }
  return `「${name}」还需要多练练，错题已收进错题本，随时可以重练。`;
});

/** 手动模式：单题加入错题本 */
function addOne(w) {
  if (!pid || addedIds.has(w.question.id)) {
    return;
  }
  wrongbook.add(
    { wrongQuestions: [{ ...w, question: { ...w.question, id: stripW(w.question.id) } }] },
    pid
  );
  addedIds.add(w.question.id);
}

/** 正确率环形图动画（原型同款：延迟后过渡 stroke-dashoffset） */
const ringEl = ref(null);
onMounted(() => {
  setTimeout(() => {
    if (ringEl.value) {
      ringEl.value.style.strokeDashoffset = String(314 - 314 * (result?.accuracy ?? 0));
    }
  }, 120);
});
</script>

<template>
  <div v-if="result">
    <!-- 顶部：时间 + 关闭 -->
    <header class="flex items-center justify-between px-5 pt-4">
      <span class="text-[11px] font-semibold text-[#B6A190]">{{ nowText }}</span>
      <router-link to="/" class="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#B6A190] shadow-sm">✕</router-link>
    </header>

    <main class="px-5 pb-32">
      <!-- 大星星 -->
      <section class="pt-2 text-center">
        <div class="relative inline-block">
          <div class="absolute inset-0 scale-110 rounded-full bg-[#FDF0DE] blur-xl"></div>
          <span class="star-pop relative text-[104px] leading-none text-[#F5B94F] drop-shadow-[0_8px_16px_rgba(245,185,79,.35)]">★</span>
        </div>
        <h1 class="mt-1 text-[22px] font-extrabold">练习完成，好厉害！</h1>
        <p class="mt-1 text-[12px] text-[#8B7565]">{{ profileLine }} · {{ kpSummary }}</p>
        <div class="mt-2 flex flex-wrap items-center justify-center gap-1">
          <span class="rounded-full bg-[#FDF4E3] px-2.5 py-1 text-[11px] font-semibold text-[#C99A3D]">⭐ 星星 ×{{ reward?.starsEarned ?? result.correctCount }}</span>
          <span class="rounded-full bg-[#EFF5EF] px-2.5 py-1 text-[11px] font-semibold text-[#6A9A79]">🎯 星级 {{ reward?.rating ?? 0 }}/5</span>
          <span
            v-for="b in reward?.newBadges ?? []"
            :key="b.id"
            class="rounded-full bg-[#FDF0E6] px-2.5 py-1 text-[11px] font-semibold text-[#D1793F]"
          >🎖 新勋章：{{ b.name }}</span>
        </div>
      </section>

      <!-- 数据环 -->
      <section class="card mt-4 p-4">
        <div class="flex items-center gap-4">
          <div class="relative h-[110px] w-[110px] shrink-0">
            <svg class="h-full w-full -rotate-90" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="50" fill="none" stroke="#F5EBDF" stroke-width="12"></circle>
              <circle
                ref="ringEl"
                cx="60"
                cy="60"
                r="50"
                fill="none"
                stroke="#E9824C"
                stroke-width="12"
                stroke-linecap="round"
                stroke-dasharray="314"
                stroke-dashoffset="314"
                class="transition-[stroke-dashoffset] duration-1000 ease-out"
              ></circle>
            </svg>
            <div class="absolute inset-0 flex flex-col items-center justify-center">
              <span class="text-[24px] font-extrabold leading-none text-[#E9824C]">{{ accuracyPct }}%</span>
              <span class="mt-1 text-[10px] text-[#B6A190]">正确率</span>
            </div>
          </div>
          <div class="flex-1 space-y-2.5">
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1 text-[11px] text-[#8B7565]"><span class="text-[#7BAE8B]">✔</span>答对</span>
              <span class="text-[14px] font-extrabold">{{ result.correctCount }} <span class="text-[10px] font-normal text-[#A99079]">道</span></span>
            </div>
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1 text-[11px] text-[#8B7565]"><span class="text-[#E2A08A]">✘</span>答错</span>
              <span class="text-[14px] font-extrabold">{{ wrongCount }} <span class="text-[10px] font-normal text-[#A99079]">道</span></span>
            </div>
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1 text-[11px] text-[#8B7565]"><span class="text-[#C29B55]">⏱</span>用时</span>
              <span class="text-[14px] font-extrabold">{{ durationText }}</span>
            </div>
          </div>
        </div>
        <div class="mt-3 grid grid-cols-3 divide-x divide-[#F6ECE0] border-t border-[#F6ECE0] pt-3 text-center">
          <div>
            <p class="text-[13px] font-bold">{{ avgSeconds }}<span class="text-[9px] font-normal">秒</span></p>
            <p class="mt-0.5 text-[10px] text-[#A99079]">平均每题</p>
          </div>
          <div>
            <p class="text-[13px] font-bold">{{ diffText }}</p>
            <p class="mt-0.5 text-[10px] text-[#A99079]">比上次</p>
          </div>
          <div>
            <p class="text-[13px] font-bold">{{ streakDays }} <span class="text-[9px] font-normal">天</span></p>
            <p class="mt-0.5 text-[10px] text-[#A99079]">连续打卡</p>
          </div>
        </div>
      </section>

      <!-- 错题清单 -->
      <section v-if="result.wrongQuestions.length > 0" class="mt-4">
        <div class="mb-2.5 flex items-center justify-between">
          <h2 class="flex items-center gap-1.5 text-[14px] font-bold"><span class="text-[#E9824C]">📕</span>本次错题</h2>
          <router-link to="/mistakes" class="flex items-center gap-0.5 text-[11px] text-[#C97B49]">进入错题本 ›</router-link>
        </div>
        <div class="space-y-2">
          <div v-for="w in result.wrongQuestions" :key="w.question.id" class="card flex items-center gap-3 p-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FDF1EC] text-[#D9826A]">✘</div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[16px] font-bold tracking-wide">
                {{ w.question.expression }} <span class="text-[#D9826A]">{{ w.userAnswer ?? '未作答' }}</span>
              </p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">正确答案 {{ w.correctAnswer }} · {{ kpOf(w.question.kpId)?.name ?? '' }}</p>
            </div>
            <button
              v-if="!addedIds.has(w.question.id)"
              class="h-8 shrink-0 rounded-full bg-[#FBF1E6] px-3 text-[11px] font-semibold text-[#C97B49]"
              @click="addOne(w)"
            >
              加入错题本
            </button>
            <span v-else class="h-8 shrink-0 rounded-full bg-[#EFF5EF] px-3 text-[11px] font-semibold leading-8 text-[#6A9A79]">已收录 ✓</span>
          </div>
        </div>
      </section>

      <!-- 小老师点评 -->
      <div class="card mt-3 flex items-start gap-2.5 p-3.5">
        <span class="mt-0.5 shrink-0 text-lg text-[#F0B44E]">✨</span>
        <p class="text-[11px] leading-relaxed text-[#8B7565]">
          <span class="font-bold text-[#4B3B32]">小老师点评：</span>{{ comment }}
        </p>
      </div>
    </main>

    <!-- 底部按钮 -->
    <div class="sticky bottom-20 z-30 bg-gradient-to-t from-[#FBF6EE] via-[#FBF6EE] to-[#FBF6EE]/60 px-5 pb-4 pt-2.5">
      <div class="flex gap-2.5">
        <router-link to="/setup" class="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-[#E9824C] text-[14px] font-bold text-white shadow-md shadow-[#E9824C]/25 transition active:scale-[.98]">
          🔄 再来一组
        </router-link>
        <router-link to="/mistakes" class="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-2xl border border-[#EBCBAF] bg-white text-[14px] font-bold text-[#C97B49] transition active:scale-[.98]">
          🎯 错题重练
        </router-link>
      </div>
      <div class="mt-2.5 flex items-center justify-center gap-4">
        <router-link to="/report" class="text-[11px] text-[#A99079]">查看学习报告</router-link>
        <span class="h-3 w-px bg-[#E4D6C7]"></span>
        <router-link to="/calendar" class="text-[11px] text-[#A99079]">今日打卡</router-link>
        <span class="h-3 w-px bg-[#E4D6C7]"></span>
        <router-link to="/" class="text-[11px] text-[#A99079]">返回首页</router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference '../style.css';

/* 卡片与星星动画（原型同款） */
.card {
  background: #fff;
  border-radius: 24px;
  border: 1px solid #f6eadc;
  box-shadow: 0 6px 18px rgba(139, 112, 86, 0.06);
}
@keyframes starPop {
  0% { transform: scale(0.3) rotate(-20deg); opacity: 0; }
  70% { transform: scale(1.12) rotate(6deg); opacity: 1; }
  100% { transform: scale(1) rotate(0); opacity: 1; }
}
.star-pop {
  animation: starPop 0.6s cubic-bezier(0.2, 0.8, 0.3, 1.2) both;
}
</style>
