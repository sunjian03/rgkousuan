<script setup>
/**
 * Setup.vue —— 出题设置页（D3，对应原型 docs/setup.html）
 * 学期网格 / 知识点多选 / 题量滑块 / 难度模式 / 语音与错题本开关。
 * 页面层只调用 2.4 接口：generator.generate + listKnowledgePoints、
 * wrongbook.review、repo 草稿与档案读写（NFR-06 开始即存草稿）。
 *
 * 与设计报告的一致性说明：
 * - 难度「简单/标准/挑战」为原型文案，映射 2.4 契约的
 *   difficultyMode basic/mixed/advance（profiles.prefs 存契约值）；
 * - 多知识点出卷：generate 按单知识点出题（2.4 M1），页面层将题量
 *   按知识点平均分摊、逐知识点生成后按轮转合并，保证各知识点均匀分布；
 * - 「语音读题」「错题自动加入错题本」为页面层交互偏好（设计报告
 *   FR-03/FR-05 的默认行为），存入 prefs 扩展字段，默认开启 = 设计行为。
 * - 产品决策（2026-11-02 用户确认）：单位换算类知识点（op='unit'，二下
 *   「长度单位」、三下「面积与周长」）不参与出题，页面层在
 *   listKnowledgePoints 结果上过滤；core 知识点配置（3.2.1(5)）与生成
 *   算法保留不动，本偏差以此说明为准（Home/Print/Report 同规则）。
 */
import { computed, ref, watchEffect } from 'vue';
import { useRouter } from 'vue-router';
import { store, repo, termOf, semShort, visibleKps } from '../store.js';
import { avatarOf } from '../avatars.js';
import { listKnowledgePoints, generate } from '../core/generator.js';
import { WrongBook } from '../core/wrongbook.js';
import { StatsService } from '../core/stats.js';

const router = useRouter();
const statsSvc = new StatsService(repo); // FR-11：开始练习前核对今日已用时长

const TERMS = ['一上', '一下', '二上', '二下', '三上', '三下'];
/** 原型三档难度 → 2.4 契约 difficultyMode */
const DIFFS = [
  { key: 'basic', label: '简单', desc: '数字温和，不涉及进退位混合，适合刚学完新知识点时巩固。' },
  { key: 'mixed', label: '标准', desc: '贴近课本常见题型，包含进位、退位与基础运算顺序，日常练习首选。' },
  { key: 'advance', label: '挑战', desc: '加入两步混合与干扰数字，限时更紧凑，适合冲刺与提升。' },
];
/** 知识点卡片图标（按列表位置循环，原型同款节奏） */
const KP_ICONS = ['➕', '➖', '✖️', '➗', '📝', '📖', '📏', '🕐'];

const wrongbook = new WrongBook(repo, { profileId: store.currentProfileId });
const profile = computed(() => store.currentProfile);
const profiles = computed(() => {
  void repo.version; // 数据版本依赖
  return repo.load('profiles');
});
const avatar = computed(() => avatarOf(profiles.value, store.currentProfileId));

const term = ref('一上');
const count = ref(30);
const difficulty = ref('mixed');
const voiceEnabled = ref(true);
const autoWrong = ref(true);
const selectedIds = ref([]);
const errMsg = ref('');

// 单位/面积周长知识点不参与出题（产品决策，见 store.visibleKps 说明）
const kps = computed(() => visibleKps(listKnowledgePoints(term.value)));
const estMin = computed(() => Math.max(3, Math.round(count.value * 0.26)));
const allSelected = computed(() => kps.value.length > 0 && selectedIds.value.length === kps.value.length);
const diffInfo = computed(() => DIFFS.find((d) => d.key === difficulty.value) ?? DIFFS[1]);
const sumDiffText = computed(() => diffInfo.value.label + '模式');

/** 档案就绪后初始化（App 的 ensureProfile 在首次挂载后才建默认档案） */
let initialized = false;
watchEffect(() => {
  if (initialized || !profile.value) {
    return;
  }
  term.value = termOf(profile.value); // semester 存「上/下」（3.2.1），合成知识点学期全称
  count.value = profile.value.prefs?.questionCount ?? 30;
  difficulty.value = profile.value.prefs?.difficultyMode ?? 'mixed';
  voiceEnabled.value = profile.value.prefs?.speechEnabled ?? true;
  autoWrong.value = profile.value.prefs?.autoWrongToBook ?? true;
  selectedIds.value = visibleKps(listKnowledgePoints(term.value)).map((k) => k.id);
  initialized = true;
});

function pickTerm(t) {
  term.value = t;
  selectedIds.value = visibleKps(listKnowledgePoints(t)).map((k) => k.id);
  errMsg.value = '';
}
function toggleKp(id) {
  const i = selectedIds.value.indexOf(id);
  if (i > -1) {
    selectedIds.value.splice(i, 1);
  } else {
    selectedIds.value.push(id);
  }
}
function selectAll() {
  selectedIds.value = allSelected.value ? [] : kps.value.map((k) => k.id);
}
function quickAmount(v) {
  count.value = v;
}

/**
 * startPractice —— 开始练习（原型底部按钮）
 * 分摊题量 → 逐知识点 generate（2.4 M1）→ 轮转合并 → 存草稿（NFR-06）
 * → 偏好写回档案 → 进入答题页（D4 从草稿续练）。
 */
function startPractice() {
  errMsg.value = '';
  const pid = store.currentProfileId;
  if (!pid || !profile.value) {
    return;
  }
  // FR-11 护眼与防沉迷：今日已用时长达到 prefs.dailyLimitMin 上限时阻止开新卷
  // （每日上限在家长中心 D8 设置；练习中途超时的提醒见 Practice 页）
  const limitMin = profile.value.prefs?.dailyLimitMin ?? 30;
  const usedSec = statsSvc.getReport(pid, 'day').summary.totalDurationSec;
  if (limitMin > 0 && usedSec >= limitMin * 60) {
    errMsg.value = `今日练习时长已达上限（${limitMin} 分钟），休息一下眼睛吧`;
    return;
  }
  if (selectedIds.value.length === 0) {
    errMsg.value = '请至少选择一个知识点';
    return;
  }

  // 题量按知识点平均分摊（余数从前往后各补 1）
  const n = selectedIds.value.length;
  const perKp = Math.floor(count.value / n);
  const extra = count.value % n;
  const recentPapers = repo.getRecentPapers(pid);
  // 错题优先：buildReviewPaper 输出题目快照（{id,kpId,expression,answer}），
  // 正是 generate({wrongQuestions}) 的入参形状（generator 文档：由 WrongBook 提供）；
  // 100 为宽松上限，generate 内部按 M = min(10, N×30%) 且仅取本知识点错题。
  const wrongQuestions = wrongbook.buildReviewPaper(100, pid);

  const papers = [];
  for (let i = 0; i < n; i++) {
    const kpId = selectedIds.value[i];
    const c = perKp + (i < extra ? 1 : 0);
    if (c < 1) {
      continue;
    }
    const out = generate({
      kpId,
      // M1 的 semester 参数为知识点配置格式（6 学期全称之一，3.2.1(5)），
      // 与档案 semester 短值「上/下」（3.2.1(1)）不是同一格式，这里直接传 term 全称
      semester: term.value,
      count: c,
      difficultyMode: difficulty.value,
      recentPapers,
      wrongQuestions,
    });
    if (!Array.isArray(out)) {
      errMsg.value = out.message ?? '出题失败，请重试';
      return;
    }
    papers.push(out);
  }

  // 轮转合并：各知识点题交错排列（卷内仍保持基础在前、进阶在后）
  const merged = [];
  const maxLen = Math.max(0, ...papers.map((p) => p.length));
  for (let i = 0; i < maxLen; i++) {
    for (const p of papers) {
      if (i < p.length) {
        merged.push(p[i]);
      }
    }
  }
  if (merged.length === 0) {
    errMsg.value = '该学期题目候选不足，请更换选择';
    return;
  }

  // 偏好写回档案（prefs 三字段为设计报告 3.2.1 契约；语音/错题开关为扩展项）
  repo.save('profiles', {
    ...profile.value,
    semester: semShort(term.value),
    prefs: {
      ...profile.value.prefs,
      questionCount: count.value,
      difficultyMode: difficulty.value,
      speechEnabled: voiceEnabled.value,
      autoWrongToBook: autoWrong.value,
    },
  });
  // 开始即存草稿：中途退出可续练（NFR-06 离线中断恢复）
  repo.saveDraft(pid, { paper: merged, answers: [], startedAt: Date.now() });
  router.push('/practice');
}
</script>

<template>
  <div>
    <!-- 顶部栏（原型同款） -->
    <header class="sticky top-0 z-40 flex items-center justify-between border-b border-[#F4E8DA] bg-white px-5 pb-3 pt-4">
      <router-link to="/" class="flex h-9 w-9 items-center justify-center rounded-full bg-[#FBF6EE] text-[#8B7565]">‹</router-link>
      <h1 class="text-[16px] font-extrabold">出题设置</h1>
      <router-link to="/report" class="text-[12px] font-semibold text-[#C97B49]">历史记录</router-link>
    </header>

    <main class="px-5 pb-40 pt-4">
      <!-- 当前孩子 -->
      <div class="mb-4 flex items-center gap-2.5">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FBE0CB]">{{ avatar }}</div>
        <p class="text-[12px] text-[#8B7565]">
          当前档案：<span class="font-bold text-[#4B3B32]">{{ profile?.nickname }}</span> ·
          {{ ['一', '二', '三'][profile?.grade - 1] ?? '一' }}年级{{ semShort(profile?.semester) }}
        </p>
        <router-link to="/parent" class="ml-auto text-[11px] text-[#C97B49]">切换</router-link>
      </div>

      <!-- 学期 -->
      <section class="mb-5">
        <div class="mb-2.5 flex items-center justify-between">
          <h2 class="flex items-center gap-1.5 text-[14px] font-bold">
            <span class="h-3.5 w-1.5 rounded-full bg-[#E9824C]"></span>选择学期
          </h2>
          <span class="text-[11px] text-[#A99079]">{{ term }} · {{ kps.length }} 个知识点</span>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <button
            v-for="t in TERMS"
            :key="t"
            class="h-11 rounded-xl border text-[13px] font-semibold transition"
            :class="t === term ? 'border-[#E9824C] bg-[#E9824C] text-white shadow-sm' : 'border-[#F0E3D5] bg-white text-[#8B7565]'"
            @click="pickTerm(t)"
          >
            {{ t }}
          </button>
        </div>
      </section>

      <!-- 知识点 -->
      <section class="mb-5">
        <div class="mb-2.5 flex items-center justify-between">
          <h2 class="flex items-center gap-1.5 text-[14px] font-bold">
            <span class="h-3.5 w-1.5 rounded-full bg-[#7BAE8B]"></span>知识点
          </h2>
          <button class="text-[11px] text-[#C97B49]" @click="selectAll">全选 / 清空</button>
        </div>
        <p class="mb-2 text-[11px] text-[#A99079]">已选 {{ selectedIds.length }} 个知识点</p>
        <div class="grid grid-cols-2 gap-2.5">
          <button
            v-for="(k, i) in kps"
            :key="k.id"
            class="relative rounded-2xl border bg-white p-3 text-left transition"
            :class="selectedIds.includes(k.id) ? 'border-[#E9824C] bg-[#FFF7EF] shadow-[0_4px_12px_rgba(233,130,76,.14)]' : 'border-[#F0E3D5]'"
            @click="toggleKp(k.id)"
          >
            <span
              class="absolute right-2 top-2 text-xs"
              :class="selectedIds.includes(k.id) ? 'text-[#E9824C] opacity-100' : 'opacity-0'"
            >✓</span>
            <div
              class="mb-2 flex h-8 w-8 items-center justify-center rounded-lg"
              :class="selectedIds.includes(k.id) ? 'bg-[#E9824C] text-white' : 'bg-[#FBF1E6] text-[#C98C5C]'"
            >
              {{ KP_ICONS[i % KP_ICONS.length] }}
            </div>
            <p class="pr-2 text-[12px] font-semibold leading-snug">{{ k.name }}</p>
            <p class="mt-1 text-[10px] text-[#A99079]">{{ selectedIds.includes(k.id) ? '已选择' : '点击加入' }}</p>
          </button>
        </div>
      </section>

      <!-- 题量 -->
      <section class="mb-3 rounded-[22px] border border-[#F6EADC] bg-white p-4 shadow-[0_6px_18px_rgba(139,112,86,.06)]">
        <div class="flex items-center justify-between">
          <h2 class="flex items-center gap-1.5 text-[14px] font-bold">
            <span class="text-[#C97B49]">🔢</span>题量
          </h2>
          <p class="text-[11px] text-[#A99079]">预计 {{ estMin }} 分钟</p>
        </div>
        <div class="mt-3 flex items-center gap-3">
          <span class="text-[11px] text-[#B6A190]">10</span>
          <input v-model.number="count" class="range flex-1" type="range" min="10" max="60" step="5" />
          <span class="text-[11px] text-[#B6A190]">60</span>
        </div>
        <div class="mt-3 flex items-center justify-center gap-1">
          <span class="text-[28px] font-extrabold leading-none text-[#E9824C]">{{ count }}</span>
          <span class="mb-0.5 text-[13px] text-[#A99079]">道</span>
          <div class="ml-3 flex gap-1.5">
            <button
              v-for="v in [20, 30, 50]"
              :key="v"
              class="rounded-full px-2.5 py-1 text-[11px]"
              :class="count === v ? 'bg-[#E9824C] text-white' : 'bg-[#FBF3E9] text-[#A9825F]'"
              @click="quickAmount(v)"
            >
              {{ v }}
            </button>
          </div>
        </div>
      </section>

      <!-- 难度 -->
      <section class="mb-3 rounded-[22px] border border-[#F6EADC] bg-white p-4 shadow-[0_6px_18px_rgba(139,112,86,.06)]">
        <h2 class="mb-3 flex items-center gap-1.5 text-[14px] font-bold">
          <span class="text-[#9A86C0]">⚡</span>难度模式
        </h2>
        <div class="grid grid-cols-3 gap-2">
          <button
            v-for="d in DIFFS"
            :key="d.key"
            class="h-10 rounded-xl border text-[13px] font-semibold transition"
            :class="difficulty === d.key ? 'border-[#E9824C] bg-[#FFF2E6] text-[#D1793F]' : 'border-[#F0E3D5] bg-white text-[#8B7565]'"
            @click="difficulty = d.key"
          >
            {{ d.label }}
          </button>
        </div>
        <p class="mt-3 rounded-xl bg-[#FBF7F1] px-3 py-2 text-[11px] leading-relaxed text-[#8B7565]">{{ diffInfo.desc }}</p>
      </section>

      <!-- 其他选项 -->
      <section class="space-y-3 rounded-[22px] border border-[#F6EADC] bg-white p-4 shadow-[0_6px_18px_rgba(139,112,86,.06)]">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-[13px] font-semibold">语音读题</p>
            <p class="mt-0.5 text-[10px] text-[#A99079]">低年级可开启，减少阅读负担</p>
          </div>
          <button
            class="relative h-6 w-11 rounded-full transition"
            :class="voiceEnabled ? 'bg-[#E9824C]' : 'bg-[#E3D6C8]'"
            @click="voiceEnabled = !voiceEnabled"
          >
            <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all" :class="voiceEnabled ? 'right-0.5' : 'left-0.5'"></span>
          </button>
        </div>
        <div class="h-px bg-[#F5EADF]"></div>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-[13px] font-semibold">错题自动加入错题本</p>
            <p class="mt-0.5 text-[10px] text-[#A99079]">练习结束后可一键重练</p>
          </div>
          <button
            class="relative h-6 w-11 rounded-full transition"
            :class="autoWrong ? 'bg-[#E9824C]' : 'bg-[#E3D6C8]'"
            @click="autoWrong = !autoWrong"
          >
            <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all" :class="autoWrong ? 'right-0.5' : 'left-0.5'"></span>
          </button>
        </div>
      </section>
    </main>

    <!-- 底部汇总与开始（悬浮于内容之上、全局导航之上方） -->
    <div class="sticky bottom-20 z-30 mt-3 bg-gradient-to-t from-white via-white to-white/70 px-5 pb-4 pt-3">
      <div class="mb-2 flex items-center justify-between px-1">
        <p class="text-[11px] text-[#A99079]">
          共 <span class="font-bold text-[#4B3B32]">{{ count }}</span> 题 · {{ selectedIds.length }} 个知识点
        </p>
        <p class="text-[11px] text-[#A99079]">{{ sumDiffText }}</p>
      </div>
      <p v-if="errMsg" class="mb-1.5 text-center text-[11px] text-red-500">{{ errMsg }}</p>
      <button
        class="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#E9824C] text-[16px] font-bold text-white shadow-lg shadow-[#E9824C]/25 transition active:scale-[.98]"
        @click="startPractice"
      >
        ▶ 开始练习
      </button>
    </div>
  </div>
</template>

<style scoped>
@reference '../style.css';

/* 题量滑块（原型同款：圆角轨道 + 橙色描边白色圆钮） */
.range {
  -webkit-appearance: none;
  appearance: none;
  height: 8px;
  border-radius: 99px;
  background: #f3e6d8;
  outline: none;
}
.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  border: 4px solid #e9824c;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  cursor: pointer;
}
.range::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  border: 4px solid #e9824c;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  cursor: pointer;
}
</style>
