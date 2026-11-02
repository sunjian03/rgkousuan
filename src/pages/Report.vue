<script setup>
/**
 * Report.vue —— 学习报告（D7，对应原型 docs/report.html）
 * 日/周/月三粒度概览、正确率折线（ECharts）、每次用时柱状图、
 * 知识点掌握度列表（3.3.5 近 10 次口径）、学习建议。
 * 页面层只调用 2.4 接口：stats.getReport / getMastery、wrongbook.review、
 * achievement.streakOf。导出入口跳打印页（D9 生成 PDF）。
 *
 * 一致性说明：
 * - 「日」粒度按单次练习打点（原型 8:00/8:30 粒度即单次练习），
 *   周/月按 stats.getReport 的按日聚合趋势渲染；
 * - 无练习的日子正确率记 null（折线断点），避免 0% 污染趋势；
 * - 对比涨跌 = 本周期汇总 vs 上一等长周期汇总。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// 按需注册：只打包折线/柱状图（报告页仅用两种图，减小 chunk）
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer]);
import { store, repo, semShort, termOf, visibleKps } from '../store.js';
import { StatsService } from '../core/stats.js';
import { WrongBook } from '../core/wrongbook.js';
import { AchievementService } from '../core/achievement.js';
import { listKnowledgePoints } from '../core/generator.js';

const router = useRouter();
const stats = new StatsService(repo);
const wrongbook = new WrongBook(repo, { profileId: store.currentProfileId });
const achievement = new AchievementService(repo);
const pid = store.currentProfileId;
const profile = store.currentProfile;

const tab = ref('week');
const toast = ref('');
const rateChartEl = ref(null);
const timeChartEl = ref(null);
let rateChart = null;
let timeChart = null;
let onResize = null;

/** 本周期记录（createdAt 落在 [from, to]） */
function recordsBetween(from, to) {
  return stats.recordsOf(pid).filter((r) => {
    const ts = r.createdAt || 0;
    return ts >= from && ts <= to;
  });
}
function periodRange(days) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
  return { from, to: Date.now() };
}

/** 周期汇总（记录级）：平均正确率/总题量/平均用时/练习次数 */
function summarize(records) {
  const n = records.length;
  if (n === 0) {
    return { avgAccuracy: 0, totalQ: 0, avgMin: 0, count: 0 };
  }
  const acc = records.reduce((s, r) => s + (r.accuracy ?? 0), 0) / n;
  const totalQ = records.reduce((s, r) => s + (r.paper?.length ?? 0), 0);
  const dur = records.reduce((s, r) => s + (r.durationSec ?? 0), 0);
  return { avgAccuracy: acc, totalQ, avgMin: dur / 60 / n, count: n };
}

/** 各粒度数据：日=单次练习打点，周/月=按日聚合趋势 */
const view = computed(() => {
  if (tab.value === 'day') {
    const { from, to } = periodRange(1);
    const cur = recordsBetween(from, to);
    const prev = recordsBetween(from - 86400000, from - 1);
    const sorted = [...cur].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const hhmm = (ts) => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    return {
      x: sorted.map((r) => hhmm(r.createdAt)),
      rate: sorted.map((r) => Math.round((r.accuracy ?? 0) * 100)),
      time: sorted.map((r) => Math.round((r.durationSec ?? 0) / 60)),
      cur: summarize(cur),
      prev: summarize(prev),
    };
  }
  const days = tab.value === 'week' ? 7 : 30;
  const { from, to } = periodRange(days);
  const report = stats.getReport(pid, tab.value);
  const trend = Array.isArray(report?.trend) ? report.trend : [];
  return {
    x: trend.map((t) => t.date.slice(5).replace('-', '/')),
    rate: trend.map((t) => (t.practiceCount > 0 ? Math.round(t.avgAccuracy * 100) : null)),
    time: trend.map((t) => Math.round(t.totalDurationSec / 60)),
    cur: summarize(recordsBetween(from, to)),
    prev: summarize(recordsBetween(from - days * 86400000, from - 1)),
  };
});

/** 涨跌文案（与原型一致：正确率↑、用时↓为好） */
const rateDelta = computed(() => {
  const d = Math.round((view.value.cur.avgAccuracy - view.value.prev.avgAccuracy) * 100);
  if (view.value.prev.count === 0) {
    return '首周期';
  }
  return d > 0 ? `↑ ${d}%` : d < 0 ? `↓ ${-d}%` : '持平';
});
const minDelta = computed(() => {
  const d = view.value.cur.avgMin - view.value.prev.avgMin;
  if (view.value.prev.count === 0) {
    return '首周期';
  }
  return d < 0 ? `↓ ${(-d).toFixed(1)} 分` : d > 0 ? `↑ ${d.toFixed(1)} 分` : '持平';
});

/** 知识点掌握度（当前学期，3.3.5 近 10 次口径；null=未练习） */
const kpList = computed(() => {
  if (!profile) {
    return [];
  }
  const term = termOf(profile);
  return visibleKps(listKnowledgePoints(term)).map((kp) => {
    const m = stats.getMastery(pid, kp.id);
    return {
      ...kp,
      pct: m === null ? null : Math.round(m * 100),
      level: m === null ? '未练习' : m >= 0.9 ? '已掌握' : m >= 0.8 ? '基本掌握' : '需加强',
    };
  });
});

/** 学习建议（数据驱动，最多 3 条） */
const suggestions = computed(() => {
  const out = [];
  // 1) 反复出错的错题
  const hot = wrongbook
    .review({ profileId: pid, status: 'active' })
    .filter((it) => it.wrongCount >= 3)
    .sort((a, b) => b.wrongCount - a.wrongCount);
  if (hot.length > 0) {
    const name = listKnowledgePoints().find((k) => k.id === hot[0].kpId)?.name ?? '这个知识点';
    out.push(`「${name}」有 ${hot[0].wrongCount} 次反复出错，先回顾知识点再练 10 道专项。`);
  }
  // 2) 掌握度最低的已练知识点
  const weak = kpList.value.filter((k) => k.pct !== null && k.pct < 80).sort((a, b) => a.pct - b.pct)[0];
  if (weak) {
    out.push(`「${weak.name}」掌握度 ${weak.pct}%，建议每天 10 道专项练习。`);
  }
  // 3) 习惯建议
  const ach = repo.load('achievements', 'ach__' + pid);
  const streak = achievement.streakOf(ach?.checkinDates ?? [], achievement.fmtDate(Date.now()));
  out.push(
    streak >= 3
      ? `已连续打卡 ${streak} 天，保持每天一次短练习，进步更稳。`
      : '保持每天一次短练习，比周末集中练习更有效。'
  );
  return out.slice(0, 3);
});

/** ECharts 选项（配色沿用原型） */
function chartOption(kind) {
  const d = view.value;
  if (kind === 'rate') {
    return {
      grid: { left: 30, right: 12, top: 18, bottom: 22 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(75,59,50,.92)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
        formatter: (p) => (p[0].value == null ? p[0].axisValue + '：无练习' : p[0].axisValue + '：正确率 ' + p[0].value + '%'),
      },
      xAxis: {
        type: 'category',
        data: d.x,
        axisLine: { lineStyle: { color: '#F0E3D5' } },
        axisTick: { show: false },
        axisLabel: { color: '#B6A190', fontSize: 9, interval: d.x.length > 10 ? Math.ceil(d.x.length / 10) : 0 },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        interval: 20,
        axisLabel: { color: '#C8B5A3', fontSize: 9 },
        splitLine: { lineStyle: { color: '#F7EEE3' } },
      },
      series: [
        {
          type: 'line',
          data: d.rate,
          smooth: true,
          symbol: 'circle',
          symbolSize: 7,
          itemStyle: { color: '#E9824C', borderColor: '#fff', borderWidth: 2 },
          lineStyle: { width: 3, color: '#E9824C' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(233,130,76,.26)' },
              { offset: 1, color: 'rgba(233,130,76,.02)' },
            ]),
          },
        },
      ],
    };
  }
  return {
    grid: { left: 30, right: 12, top: 14, bottom: 20 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(75,59,50,.92)',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 11 },
      formatter: (p) => p[0].axisValue + '：用时 ' + p[0].value + ' 分钟',
    },
    xAxis: {
      type: 'category',
      data: d.x,
      axisLine: { lineStyle: { color: '#F0E3D5' } },
      axisTick: { show: false },
      axisLabel: { color: '#B6A190', fontSize: 9, interval: d.x.length > 10 ? Math.ceil(d.x.length / 10) : 0 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#C8B5A3', fontSize: 9 },
      splitLine: { lineStyle: { color: '#F7EEE3' } },
    },
    series: [
      {
        type: 'bar',
        data: d.time,
        barWidth: '46%',
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: '#C9B6E4' },
            { offset: 1, color: '#EFE7F9' },
          ]),
        },
      },
    ],
  };
}

function drawCharts() {
  if (rateChart && rateChartEl.value) {
    rateChart.setOption(chartOption('rate'));
  }
  if (timeChart && timeChartEl.value) {
    timeChart.setOption(chartOption('time'));
  }
}

onMounted(() => {
  rateChart = echarts.init(rateChartEl.value);
  timeChart = echarts.init(timeChartEl.value);
  drawCharts();
  onResize = () => {
    rateChart?.resize();
    timeChart?.resize();
  };
  window.addEventListener('resize', onResize);
});
onUnmounted(() => {
  if (onResize) {
    window.removeEventListener('resize', onResize);
  }
  rateChart?.dispose();
  timeChart?.dispose();
});
watch(tab, () => {
  // v-show 切换后容器尺寸就绪再重绘（空周期 ↔ 有数据周期）
  requestAnimationFrame(() => {
    drawCharts();
    rateChart?.resize();
    timeChart?.resize();
  });
});

/** 导出提示（D9 打印页生成 PDF） */
function exportTip() {
  toast.value = '报告可到打印页导出 PDF';
  setTimeout(() => {
    toast.value = '';
  }, 2000);
}
</script>

<template>
  <div>
    <!-- 顶部 -->
    <header class="bg-white px-5 pb-3 pt-4">
      <div class="flex items-center justify-between">
        <router-link to="/" class="flex h-9 w-9 items-center justify-center rounded-full bg-[#FBF6EE] text-[#8B7565]">‹</router-link>
        <h1 class="text-[16px] font-extrabold">学习报告</h1>
        <button class="flex h-9 w-9 items-center justify-center rounded-full bg-[#FBF6EE] text-[#8B7565]" @click="exportTip">⇪</button>
      </div>
      <div class="mt-3 flex items-center gap-2 text-[11px] text-[#8B7565]">
        <span class="flex h-6 w-6 items-center justify-center rounded-lg bg-[#FBE0CB] text-[13px]">🐣</span>
        <span class="font-bold text-[#4B3B32]">{{ profile?.nickname }}</span>
        <span class="text-[#C8B5A3]">·</span>
        <span>{{ ['一', '二', '三'][profile?.grade - 1] ?? '一' }}年级{{ semShort(profile?.semester) }}</span>
        <span v-if="rateDelta !== '首周期' && rateDelta !== '持平'" class="ml-auto rounded-full bg-[#EFF5EF] px-2 py-0.5 text-[#6A9A79]">本周进步明显</span>
      </div>
      <!-- 日/周/月 -->
      <div class="mt-3 grid grid-cols-3 gap-1 rounded-2xl bg-[#FBF3E9] p-1">
        <button
          v-for="t in [['day', '日'], ['week', '周'], ['month', '月']]"
          :key="t[0]"
          class="h-8 rounded-xl text-[12px] font-semibold transition"
          :class="tab === t[0] ? 'bg-[#E9824C] text-white shadow-[0_4px_10px_rgba(233,130,76,.25)]' : 'text-[#A99079]'"
          @click="tab = t[0]"
        >
          {{ t[1] }}
        </button>
      </div>
    </header>

    <main class="px-5 pb-5 pt-3">
      <!-- 概览 -->
      <section class="grid grid-cols-3 gap-2">
        <div class="card px-3 py-3">
          <p class="text-[20px] font-extrabold leading-none text-[#E9824C]">{{ Math.round(view.cur.avgAccuracy * 100) }}<span class="text-[11px]">%</span></p>
          <p class="mt-1.5 text-[10px] text-[#A99079]">平均正确率</p>
          <p class="mt-0.5 text-[9px] text-[#7D9A87]">{{ rateDelta }}</p>
        </div>
        <div class="card px-3 py-3">
          <p class="text-[20px] font-extrabold leading-none text-[#4B3B32]">{{ view.cur.totalQ }}<span class="text-[11px] font-medium">题</span></p>
          <p class="mt-1.5 text-[10px] text-[#A99079]">完成题量</p>
          <p class="mt-0.5 text-[9px] text-[#7D9A87]">{{ view.cur.count }} 次练习</p>
        </div>
        <div class="card px-3 py-3">
          <p class="text-[20px] font-extrabold leading-none text-[#4B3B32]">{{ view.cur.avgMin.toFixed(1) }}<span class="text-[11px] font-medium">分</span></p>
          <p class="mt-1.5 text-[10px] text-[#A99079]">平均用时</p>
          <p class="mt-0.5 text-[9px] text-[#B08F76]">{{ minDelta }}</p>
        </div>
      </section>

      <!-- 正确率趋势 -->
      <section class="card mt-3 p-4">
        <div class="flex items-center justify-between">
          <h2 class="flex items-center gap-1.5 text-[13px] font-bold"><span class="text-[#E9824C]">📈</span>正确率趋势</h2>
          <span class="text-[10px] text-[#B6A190]">单位：%</span>
        </div>
        <div v-show="view.cur.count > 0" ref="rateChartEl" class="mt-1 h-[168px] w-full"></div>
        <p v-if="view.cur.count === 0" class="mt-1 flex h-[168px] items-center justify-center text-[12px] text-[#B6A190]">本周期还没有练习记录</p>
      </section>

      <!-- 每次用时 -->
      <section class="card mt-3 p-4">
        <div class="flex items-center justify-between">
          <h2 class="flex items-center gap-1.5 text-[13px] font-bold"><span class="text-[#9A86C0]">⏱</span>每次用时</h2>
          <span class="text-[10px] text-[#B6A190]">单位：分钟</span>
        </div>
        <div v-show="view.cur.count > 0" ref="timeChartEl" class="mt-1 h-[120px] w-full"></div>
        <p v-if="view.cur.count === 0" class="mt-1 flex h-[120px] items-center justify-center text-[12px] text-[#B6A190]">本周期还没有练习记录</p>
      </section>

      <!-- 知识点掌握度 -->
      <section class="mt-4">
        <div class="mb-2.5 flex items-center justify-between">
          <h2 class="text-[13px] font-bold">知识点掌握度</h2>
          <router-link to="/mistakes" class="flex items-center gap-0.5 text-[11px] text-[#C97B49]">只看薄弱项 ›</router-link>
        </div>
        <div class="space-y-2">
          <div v-for="k in kpList" :key="k.id" class="card px-3.5 py-3">
            <div class="flex items-center justify-between">
              <p class="text-[12px] font-semibold">{{ k.name }}</p>
              <span
                class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                :class="k.level === '已掌握' ? 'bg-[#EFF5EF] text-[#6A9A79]' : k.level === '基本掌握' ? 'bg-[#FDF4E3] text-[#C99A3D]' : k.level === '需加强' ? 'bg-[#FDECEC] text-[#D4796A]' : 'bg-[#F5F1EC] text-[#A99079]'"
              >
                {{ k.level }}
              </span>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <div class="h-2 flex-1 overflow-hidden rounded-full bg-[#F6EDE3]">
                <div
                  class="h-full rounded-full"
                  :style="{ width: (k.pct ?? 0) + '%', background: k.pct === null ? '#E4D6C7' : k.pct >= 90 ? '#7BAE8B' : k.pct >= 80 ? '#E9A95A' : '#D9826A' }"
                ></div>
              </div>
              <span class="w-10 text-right text-[11px] font-bold" :class="k.pct === null ? 'text-[#B6A190]' : k.pct >= 90 ? 'text-[#7BAE8B]' : k.pct >= 80 ? 'text-[#E9A95A]' : 'text-[#D9826A]'">
                {{ k.pct === null ? '—' : k.pct + '%' }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- 学习建议 -->
      <section class="card mt-3 bg-gradient-to-br from-[#FFF8F0] to-white p-4">
        <div class="flex items-center gap-2">
          <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FDF0DE] text-[#D8A253]">💡</div>
          <h2 class="text-[13px] font-bold">本周学习建议</h2>
        </div>
        <ul class="mt-2.5 space-y-2 text-[11px] leading-relaxed text-[#8B7565]">
          <li v-for="(s, i) in suggestions" :key="i" class="flex gap-1.5">
            <span class="font-bold text-[#E9824C]">{{ i + 1 }}.</span>{{ s }}
          </li>
        </ul>
        <router-link to="/setup" class="mt-3 flex h-10 w-full items-center justify-center gap-1 rounded-xl bg-[#FBF1E6] text-[12px] font-bold text-[#C97B49]">
          ✨ 按建议生成专项练习
        </router-link>
      </section>
    </main>

    <!-- Toast -->
    <div v-if="toast" class="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#4B3B32]/90 px-4 py-2 text-[11px] text-white">
      {{ toast }}
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
