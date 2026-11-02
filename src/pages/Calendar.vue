<script setup>
/**
 * Calendar.vue —— 打卡日历（P9，对应原型 docs/calendar.html，随 D8 一起交付）
 * 连续打卡、月历（打卡日高亮）、今日练习状态、打卡勋章、最近打卡（含补签）。
 * 页面层只调用 2.4 接口：achievement（checkinDates / streakOf / checkin）、
 * stats（练习记录聚合）、repository。
 *
 * 与设计报告的一致性说明：
 * - 勋章区按设计报告 3.3.6 BADGES 表渲染 6 枚（原型 8 枚为交互草图，
 *   其中 5 枚不在设计报告中，不还原）；成就实体 badges 只存 id 无达成
 *   日期（3.2.1），原型日期一行不展示；
 * - 「补签」利用 2.4 M6 achievement.checkin(profileId, date) 手动打卡
 *   （achievement.js 注明打卡日历页复用），仅对最近 7 天内未练习的
 *   过去日期开放，避免随意补签破坏连续打卡记录的真实性；
 * - 连续打卡卡提示语对应设计报告勋章：3 天→「持之以恒」、7 天→「一周坚持」，
 *   原型「一月小达人」不在 BADGES 表中，不还原。
 */
import { computed, ref } from 'vue';
import { store, repo, semShort } from '../store.js';
import { avatarOf } from '../avatars.js';
import { AchievementService, BADGES } from '../core/achievement.js';
import { StatsService } from '../core/stats.js';

const achievement = new AchievementService(repo);
const stats = new StatsService(repo);
/** 档案可能在 App 挂载后才初始化，用 computed 保证切换/初始化后页面数据跟着更新 */
const pid = computed(() => store.currentProfileId);
const profile = computed(() => store.currentProfile);
const profiles = computed(() => repo.load('profiles'));

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const now = new Date();
const todayKey = keyOf(now.getFullYear(), now.getMonth() + 1, now.getDate());

/** 当前档案打卡记录（checkinDates，3.2.1 achievements） */
const ach = computed(() => achievement.getOrCreate(pid.value));
const checkedSet = computed(() => new Set(ach.value.checkinDates));

// ---- 连续打卡 ----
const streakDays = computed(() => achievement.streakOf(ach.value.checkinDates, todayKey));
/** 本月已打卡天数 / 当月总天数（原型 2/30，按当月实际天数） */
const monthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const monthCheckedCount = computed(() => ach.value.checkinDates.filter((d) => d.startsWith(monthKey)).length);
const daysInCurMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
const streakTip = computed(() => {
  if (streakDays.value < 3) {
    return `再练 ${3 - streakDays.value} 天解锁「${BADGES.streak_3.name}」`;
  }
  if (streakDays.value < 7) {
    return `再练 ${7 - streakDays.value} 天解锁「${BADGES.streak_7.name}」`;
  }
  return '连续打卡 7 天以上，继续保持！';
});

// ---- 月历（周一开头，原型同款） ----
const calYear = ref(now.getFullYear());
const calMonth = ref(now.getMonth() + 1);
const weekNames = ['一', '二', '三', '四', '五', '六', '日'];

const calCells = computed(() => {
  const y = calYear.value;
  const m = calMonth.value;
  const first = new Date(y, m - 1, 1);
  const startWeek = (first.getDay() + 6) % 7; // 周一为 0
  const daysInMonth = new Date(y, m, 0).getDate();
  const prevDays = new Date(y, m - 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeek; i++) {
    cells.push({ day: prevDays - startWeek + i + 1, kind: 'other' });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const k = keyOf(y, m, d);
    let kind = 'normal';
    if (checkedSet.value.has(k)) {
      kind = 'checked';
    }
    cells.push({ day: d, kind, key: k, isToday: k === todayKey });
  }
  const tail = (7 - ((startWeek + daysInMonth) % 7)) % 7;
  for (let i = 1; i <= tail; i++) {
    cells.push({ day: i, kind: 'other' });
  }
  return cells;
});
/** 当前月打卡天数 + 正确率（该月练习记录平均正确率，3.3.5 数据源） */
const calMonthStats = computed(() => {
  const prefix = keyOf(calYear.value, calMonth.value, 1).slice(0, 7);
  const checked = ach.value.checkinDates.filter((d) => d.startsWith(prefix)).length;
  const records = stats.recordsOf(pid.value).filter((r) => (r.date || '').startsWith(prefix));
  const acc = records.length > 0 ? records.reduce((s, r) => s + (r.accuracy ?? 0), 0) / records.length : null;
  return { checked, accuracy: acc === null ? null : Math.round(acc * 100) };
});
function changeMonth(delta) {
  let m = calMonth.value + delta;
  let y = calYear.value;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  calMonth.value = m;
  calYear.value = y;
}
function tapCell(cell) {
  if (cell.kind === 'other' || !cell.key) {
    return;
  }
  if (cell.isToday) {
    toast(checkedSet.value.has(cell.key) ? '今天已完成打卡，太棒了！' : '今天的练习还没开始，去练一练吧');
  } else if (checkedSet.value.has(cell.key)) {
    toast(`${cell.key.slice(5, 7)} 月 ${cell.key.slice(8)} 日已完成打卡`);
  } else {
    toast(`${cell.key.slice(5, 7)} 月 ${cell.key.slice(8)} 日未练习`);
  }
}

// ---- 今日练习状态 ----
const todayChecked = computed(() => checkedSet.value.has(todayKey));
const todayCount = computed(() => profile.value?.prefs?.questionCount ?? 30);

// ---- 勋章（设计报告 3.3.6 BADGES 表） ----
const badgeList = computed(() =>
  Object.entries(BADGES).map(([id, b]) => ({
    id,
    ...b,
    earned: ach.value.badges.includes(id),
  }))
);
const earnedCount = computed(() => badgeList.value.filter((b) => b.earned).length);

// ---- 最近打卡（最近 7 天，含补签） ----
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const recentDays = computed(() => {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = keyOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const records = stats.recordsOf(pid.value).filter((r) => (r.date || '') === key);
    let summary = null;
    if (records.length > 0) {
      const totalQ = records.reduce((s, r) => s + (r.paper?.length ?? 0), 0);
      const acc = records.reduce((s, r) => s + (r.accuracy ?? 0), 0) / records.length;
      const dur = records.reduce((s, r) => s + (r.durationSec ?? 0), 0);
      summary = {
        totalQ,
        accuracy: Math.round(acc * 100),
        durationText: `${Math.floor(dur / 60)}'${pad(dur % 60)}"`,
        rating: Math.round(acc * 5), // 星级 = round(正确率×5)，与 3.3.6 同规则
      };
    }
    const checked = checkedSet.value.has(key);
    days.push({
      key,
      label: `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK[d.getDay()]}`,
      isToday: key === todayKey,
      summary,
      checked,
      // 补签开放：最近 7 天内、过去日期、未练习、未打卡
      canMend: !summary && !checked && !isToday,
    });
  }
  // 最近打卡倒序展示（原型从最近往前）
  return days.reverse();
});

/** 补签（2.4 M6 achievement.checkin 手动打卡；补签日不会有练习记录） */
function mend(day) {
  achievement.checkin(pid.value, day.key);
  toast(`已补签 ${day.key.slice(5, 7)} 月 ${day.key.slice(8)} 日`);
}

// ---- 顶部铃铛（原型静态提示） ----
function remind() {
  toast('已开启打卡提醒：每天 19:00');
}

// ---- toast ----
const toastMsg = ref('');
const toastShow = ref(false);
let toastTimer = null;
function toast(msg) {
  toastMsg.value = msg;
  toastShow.value = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastShow.value = false;
  }, 2200);
}
</script>

<template>
  <div>
    <header class="shrink-0 px-5 pb-2 pt-4">
      <div class="flex items-center justify-between">
        <router-link to="/" class="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#8B7565] shadow-sm">‹</router-link>
        <h1 class="text-[16px] font-extrabold">打卡日历</h1>
        <button class="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#8B7565] shadow-sm" @click="remind">🔔</button>
      </div>
      <div class="mt-2.5 flex items-center justify-center gap-1.5 text-[11px] text-[#A99079]">
        <span class="flex h-5 w-5 items-center justify-center rounded-lg bg-[#FBE0CB] text-[11px]">{{ avatarOf(profiles, pid) }}</span>
        <span class="font-bold text-[#4B3B32]">{{ profile?.nickname }}</span> 的打卡记录
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 pb-5">
      <!-- 连续打卡 -->
      <section class="card relative mt-2 overflow-hidden bg-gradient-to-br from-[#FFF6EA] to-white p-4">
        <div class="absolute -right-5 -top-6 h-24 w-24 rounded-full bg-[#FDEFDB]"></div>
        <div class="relative flex items-center gap-3.5">
          <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#F7C77F] to-[#EAA25A] text-3xl shadow-md shadow-[#EAA25A]/30">🔥</div>
          <div class="flex-1">
            <p class="text-[11px] font-semibold text-[#B08F76]">连续打卡</p>
            <p class="text-[24px] font-extrabold leading-tight">{{ streakDays }} <span class="text-[13px] font-semibold text-[#8B7565]">天</span></p>
            <p class="mt-0.5 text-[10px] text-[#A99079]">{{ streakTip }}</p>
          </div>
          <div class="w-16 text-right">
            <p class="text-[10px] text-[#B6A190]">本月</p>
            <p class="text-[17px] font-extrabold text-[#E9824C]">{{ monthCheckedCount }}<span class="text-[10px] font-medium text-[#A99079]">/{{ daysInCurMonth }}</span></p>
          </div>
        </div>
        <div class="relative mt-3 h-2 overflow-hidden rounded-full bg-[#F8EFE3]">
          <div class="h-full rounded-full bg-gradient-to-r from-[#F5C88F] to-[#E9824C]" :style="{ width: Math.round((monthCheckedCount / daysInCurMonth) * 100) + '%' }"></div>
        </div>
      </section>

      <!-- 月历 -->
      <section class="card mt-3 p-4">
        <div class="flex items-center justify-between">
          <button class="flex h-7 w-7 items-center justify-center rounded-full bg-[#FBF6EE] text-[#B6A190]" @click="changeMonth(-1)">‹</button>
          <div class="text-center">
            <p class="text-[14px] font-extrabold">{{ calYear }} 年 {{ calMonth }} 月</p>
            <p class="mt-0.5 text-[9px] text-[#B6A190]">
              共打卡 <span>{{ calMonthStats.checked }}</span> 天{{ calMonthStats.accuracy !== null ? ` · 正确率 ${calMonthStats.accuracy}%` : '' }}
            </p>
          </div>
          <button class="flex h-7 w-7 items-center justify-center rounded-full bg-[#FBF6EE] text-[#B6A190]" @click="changeMonth(1)">›</button>
        </div>
        <div class="mt-3 grid grid-cols-7 gap-1 text-center">
          <span v-for="w in weekNames" :key="w" class="py-1 text-[10px]" :class="w === '六' || w === '日' ? 'text-[#D98A6A]' : 'text-[#B6A190]'">{{ w }}</span>
        </div>
        <div class="mt-1 grid grid-cols-7 gap-1">
          <div
            v-for="(c, i) in calCells"
            :key="i"
            class="relative flex aspect-square flex-col items-center justify-center rounded-[14px] text-[13px] font-semibold transition"
            :class="{
              'bg-[#FFF2E2] text-[#8B7565]': c.kind === 'checked' && !c.isToday,
              'outline-2 outline-offset-[-2px] outline-[#E9824C] font-extrabold text-[#D1793F]': c.isToday,
              'text-[#E3D9CE] font-medium': c.kind === 'other',
              'text-[#CFC3B7]': c.kind === 'normal' && !c.isToday && c.key && c.key < todayKey,
              'text-[#8B7565]': c.kind === 'normal' && !c.isToday && c.key && c.key >= todayKey,
            }"
            @click="tapCell(c)"
          >
            <span>{{ c.day }}</span>
            <span v-if="c.kind === 'checked' && !c.isToday" class="text-[9px] leading-none text-[#E9824C]">✓</span>
            <span v-if="c.isToday && c.kind === 'checked'" class="absolute bottom-[3px] h-1.5 w-1.5 rounded-full bg-[#E9824C]"></span>
          </div>
        </div>
        <div class="mt-3 flex items-center justify-center gap-4 text-[9px] text-[#A99079]">
          <span class="flex items-center gap-1"><span class="h-3 w-3 rounded border border-[#F5D7B5] bg-[#FFF2E2]"></span>已打卡</span>
          <span class="flex items-center gap-1"><span class="h-3 w-3 rounded border-2 border-[#E9824C]"></span>今天</span>
          <span class="flex items-center gap-1"><span class="h-3 w-3 rounded bg-[#F5F2EE]"></span>未练习</span>
        </div>
      </section>

      <!-- 今日打卡 -->
      <section class="card mt-3 flex items-center gap-3 p-3.5">
        <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-[#FDF3E4] text-[#D8A253]">{{ todayChecked ? '✅' : '🌅' }}</div>
        <div class="flex-1">
          <p class="text-[12px] font-bold">{{ todayChecked ? '今日练习已完成' : '今天的练习还没完成' }}</p>
          <p class="mt-0.5 text-[10px] text-[#A99079]">
            {{ todayChecked ? '已经点亮今天的小太阳，明天继续加油' : `完成 ${todayCount} 道题即可点亮 ${now.getMonth() + 1} 月 ${now.getDate()} 日` }}
          </p>
        </div>
        <router-link to="/setup" class="flex h-8 items-center rounded-full bg-[#E9824C] px-3 text-[11px] font-bold text-white">
          {{ todayChecked ? '再练一组' : '去练习' }}
        </router-link>
      </section>

      <!-- 勋章 -->
      <section class="mt-4">
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-[13px] font-bold">打卡勋章</h2>
          <span class="text-[10px] text-[#B6A190]">已获得 {{ earnedCount }} / {{ badgeList.length }}</span>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <div
            v-for="b in badgeList"
            :key="b.id"
            class="card p-2.5 text-center"
            :class="b.earned ? 'earned' : 'badge-item'"
          >
            <p class="text-2xl leading-none">{{ b.earned ? '🏅' : '🔒' }}</p>
            <p class="mt-1.5 text-[10px] font-semibold">{{ b.name }}</p>
            <p class="text-[9px] text-[#A99079]">{{ b.earned ? '已获得' : b.desc }}</p>
          </div>
        </div>
      </section>

      <!-- 最近打卡 -->
      <section class="mt-4">
        <h2 class="mb-2 text-[13px] font-bold">最近打卡</h2>
        <div class="card divide-y divide-[#F6EEE4]">
          <div v-for="d in recentDays" :key="d.key" class="flex items-center gap-3 px-3.5 py-3">
            <div class="flex h-8 w-8 items-center justify-center rounded-xl text-[#E9824C]" :class="d.summary || d.checked ? 'bg-[#FFF2E2]' : 'bg-[#F5F2EE] text-[#C0B3A6]'">
              <span class="text-sm">{{ d.summary || d.checked ? '✓' : '−' }}</span>
            </div>
            <div class="flex-1">
              <p class="text-[12px] font-semibold" :class="d.summary || d.checked ? '' : 'text-[#A99079]'">{{ d.label }}</p>
              <p class="mt-0.5 text-[10px]" :class="d.summary ? 'text-[#A99079]' : 'text-[#B6A190]'">
                <template v-if="d.summary">{{ d.summary.totalQ }} 题 · 正确率 {{ d.summary.accuracy }}% · 用时 {{ d.summary.durationText }}</template>
                <template v-else-if="d.checked">当天没有练习记录</template>
                <template v-else>当天没有练习记录</template>
              </p>
            </div>
            <span v-if="d.summary" class="text-[10px] text-[#C99A3D]">{{ '⭐'.repeat(Math.max(1, d.summary.rating)) }}</span>
            <span v-else-if="d.checked" class="text-[9px] text-[#C8B5A3]">已使用补签卡</span>
            <button v-else-if="d.canMend" class="h-7 rounded-full bg-[#FBF1E6] px-3 text-[10px] font-semibold text-[#C97B49]" @click="mend(d)">补签</button>
          </div>
        </div>
        <router-link to="/report" class="mt-3 flex h-11 w-full items-center justify-center gap-1.5 rounded-2xl border border-[#EBCBAF] bg-white text-[12px] font-bold text-[#C97B49]">
          📈 查看完整学习报告
        </router-link>
      </section>
    </main>

    <!-- toast -->
    <div v-if="toastShow" class="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#4B3B32]/90 px-4 py-2 text-[11px] text-white">
      {{ toastMsg }}
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
/* 未获得勋章置灰（原型同款） */
.badge-item {
  opacity: 0.42;
  filter: grayscale(0.9);
}
</style>
