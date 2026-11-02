<script setup>
/**
 * Practice.vue —— 答题页（D4，对应原型 docs/practice.html）
 * 大字号题目、纯数字键盘、进度与计时、对错反馈动画、语音读题（FR-03）、
 * 防误触（反馈期间锁键盘 + 退出二次确认）、草稿续练（NFR-06）。
 * 页面层只调用 2.4 接口：judge.PracticeSession 逐题判分/汇总、
 * generator.listKnowledgePoints 取知识点名、repo 草稿读写。
 *
 * 输入约定（判题契约 3.3.3）：答案统一为字符串，整数答案输入纯数字；
 * 分数 "3/4"、有余数除法 "5余3" 用双输入框（分子/分母、商/余数）输入，
 * 提交时拼接为 "3/4"、"5余3" 交给 judge 规范化比较。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { store, repo } from '../store.js';
import { PracticeSession } from '../core/judge.js';
import { listKnowledgePoints } from '../core/generator.js';

const router = useRouter();

const ALL_KPS = listKnowledgePoints();
const kpOf = (id) => ALL_KPS.find((k) => k.id === id) ?? null;
const DIFF_LABEL = { basic: '简单', mixed: '标准', advance: '挑战' };
const PRAISES = ['太棒啦！答对咯', '真厉害！', '算得真快！', '继续保持！'];
/** 初始星星数（原型同款），答对 +1 */
const BASE_STARS = 4;

// ---- 草稿加载（NFR-06：无草稿说明未从设置页开始，回设置页） ----
const pid = store.currentProfileId;
const draft = pid ? repo.loadDraft(pid) : null;
const paper = Array.isArray(draft?.paper) ? draft.paper : [];
const total = paper.length;
const session = new PracticeSession(paper);
if (draft?.startedAt) {
  session.startedAt = draft.startedAt; // 总用时包含中断时段（3.3.3 用时口径）
}
let savedAnswers = Array.isArray(draft?.answers) ? draft.answers : [];

// ---- 答题状态 ----
const idx = ref(0);
const input = ref('');
const parts = ref(['', '']);
const activePart = ref(0);
const locked = ref(true); // 反馈动画期间锁键盘（FR-03 防误触）
const stars = ref(BASE_STARS);
const elapsed = ref(0);
const feedback = ref(null); // { ok, emoji, text } | null
const tipText = ref('答案填在方框里，按 ✔ 确认');

const q = computed(() => paper[idx.value] ?? null);
const answerStr = computed(() => {
  if (!q.value) {
    return '';
  }
  return String(q.value.presentMode === 'blank' ? q.value.blankAnswer : q.value.answer);
});
/** 双输入框：分数 "3/4"（分子/分母）、有余数除法 "5余3"（商/余数） */
const twoPart = computed(() => answerStr.value.includes('余') || answerStr.value.includes('/'));
const sepChar = computed(() => (answerStr.value.includes('余') ? '余' : '/'));

/** 表达式分词：数字、运算符、括号、分数线、填空位（单位/时制为词，长单位优先匹配） */
const tokens = computed(() => {
  if (!q.value) {
    return [];
  }
  return q.value.expression.match(/(\d+|dm|km|mm|cm|m|时|[+\-×÷()=]|\/|□)/g) ?? [];
});
const hasBlank = computed(() => tokens.value.includes('□'));
/** 长算式（连加连减/带括号混合）缩小字号防溢出 */
const bigExpr = computed(() => tokens.value.filter((t) => /^\d+$/.test(t)).length > 6);
const progressPct = computed(() => (total ? Math.round((idx.value / total) * 100) : 0));
const kpName = computed(() => kpOf(q.value?.kpId)?.name ?? '口算练习');
const headerLine = computed(() => `${kpName.value} · ${DIFF_LABEL[q.value?.difficulty] ?? '标准'}模式`);

/** 答案框显示内容与配色（对错反馈共用） */
const boxText = computed(() => {
  if (feedback.value && !feedback.value.ok) {
    return answerStr.value; // 答错展示正确答案（原型同款）
  }
  return input.value || '?';
});
const answerBoxClass = computed(() => {
  if (!feedback.value) {
    return '';
  }
  return feedback.value.ok ? 'ok' : 'no';
});

// ---- 计时 ----
let timer = null;
function tick() {
  elapsed.value = Math.floor((Date.now() - session.startedAt) / 1000);
}
const timeText = computed(() => {
  const m = String(Math.floor(elapsed.value / 60)).padStart(2, '0');
  const s = String(elapsed.value % 60).padStart(2, '0');
  return `${m}:${s}`;
});

// ---- 语音（FR-03 语音读题，Web Speech API；不支持时静默） ----
function speak(text) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.9;
    window.speechSynthesis.speak(u);
  } catch {
    /* 忽略语音异常 */
  }
}
function speechOn() {
  return store.currentProfile?.prefs?.speechEnabled !== false;
}
/** 算式转中文读法："7×8=" → "7乘8等于"，"1/4+2/4" → "4分之1加4分之2" */
function readExpr(question) {
  return String(question.expression)
    .replace(/□/g, '问号')
    .replace(/(\d+)\/(\d+)/g, '$2分之$1')
    .replace(/×/g, '乘')
    .replace(/÷/g, '除以')
    .replace(/\+/g, '加')
    .replace(/-/g, '减')
    .replace(/=/g, '等于')
    .replace(/dm/g, '分米')
    .replace(/km/g, '千米')
    .replace(/mm/g, '毫米')
    .replace(/cm/g, '厘米')
    .replace(/m/g, '米');
}

// ---- 挂载：续练恢复（重放已答记录，跳至第一道未答题） ----
onMounted(() => {
  if (total === 0) {
    router.replace('/setup');
    return;
  }
  for (const a of savedAnswers) {
    if (session.submit(a.questionId, a.userAnswer).correct) {
      stars.value++;
    }
  }
  idx.value = Math.min(savedAnswers.length, total);
  if (idx.value >= total) {
    finishAll();
    return;
  }
  locked.value = false;
  tick();
  timer = setInterval(tick, 1000);
  if (speechOn()) {
    speak(readExpr(paper[idx.value]));
  }
});
onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});

// ---- 键盘输入 ----
function press(d) {
  if (locked.value) {
    return;
  }
  if (twoPart.value) {
    if (activePart.value === 0) {
      parts.value[0] = d; // 第一部分 1 位（分子/商恒为个位数），输完自动跳格
      activePart.value = 1;
    } else if (parts.value[1].length < 2) {
      parts.value[1] += d;
    }
    return;
  }
  if (input.value.length >= 4) {
    return; // 整数答案上限 4 位（三下乘法最大 8991）
  }
  input.value += d;
}
function backspace() {
  if (locked.value) {
    return;
  }
  if (twoPart.value) {
    if (activePart.value === 1 && parts.value[1]) {
      parts.value[1] = parts.value[1].slice(0, -1);
    } else {
      parts.value[0] = '';
      activePart.value = 0;
    }
    return;
  }
  input.value = input.value.slice(0, -1);
}
function selectPart(p) {
  if (!locked.value) {
    activePart.value = p;
  }
}

// ---- 提交判分（2.4 M2 session.submit，幂等防双击） ----
function submitAnswer() {
  if (locked.value) {
    return;
  }
  let userAnswer;
  if (twoPart.value) {
    if (!parts.value[0] || !parts.value[1]) {
      return;
    }
    userAnswer = parts.value[0] + sepChar.value + parts.value[1];
  } else {
    if (!input.value) {
      return;
    }
    userAnswer = input.value;
  }
  locked.value = true;
  const r = session.submit(paper[idx.value].id, userAnswer);
  if (r.correct) {
    stars.value++;
    const praise = PRAISES[Math.floor(Math.random() * PRAISES.length)];
    feedback.value = { ok: true, emoji: '⭐', text: praise };
    if (speechOn()) {
      speak(praise);
    }
  } else {
    feedback.value = { ok: false, emoji: '🌱', text: `差一点点，答案是 ${r.correctAnswer}` };
  }
  savedAnswers.push({ questionId: paper[idx.value].id, userAnswer, correct: r.correct });
  // 逐题存草稿：任意时刻退出均可续练（NFR-06）
  repo.saveDraft(pid, { paper, answers: savedAnswers, startedAt: session.startedAt });
  setTimeout(advance, r.correct ? 900 : 1500);
}

function advance() {
  feedback.value = null;
  if (idx.value + 1 >= total) {
    finishAll();
    return;
  }
  idx.value++;
  input.value = '';
  parts.value = ['', ''];
  activePart.value = 0;
  tipText.value = '答案填在方框里，按 ✔ 确认';
  locked.value = false;
  if (speechOn()) {
    speak(readExpr(paper[idx.value]));
  }
}

/** 练习结束：汇总（3.3.3 finish）→ 清草稿 → 成绩页（D5 消费 store.lastSession） */
function finishAll() {
  const result = session.finish();
  repo.clearDraft(pid);
  store.lastSession = { result, questions: paper };
  router.replace('/result');
}

/** 退出：进度已存草稿，二次确认防误触（FR-03） */
function exitPractice() {
  if (window.confirm('练习还没完成，进度已保存，确定退出吗？')) {
    router.push('/');
  }
}

/** 提示（原型「需要一点提示？」） */
function showHint() {
  const op = kpOf(paper[idx.value]?.kpId)?.op;
  tipText.value =
    op === 'mixed'
      ? '先算乘除，后算加减，从左到右'
      : op === 'frac'
        ? '分母不变，分子相加减'
        : op === '÷'
          ? '先想商，再想余数'
          : '仔细看数字，慢慢算';
}

/** token 样式：数字大字 / 运算符橙色 / 符号与单位小字 */
function tokenClass(t) {
  if (/^\d+$/.test(t)) {
    return bigExpr.value ? 'text-[38px] font-extrabold' : 'text-[52px] font-extrabold';
  }
  if (['+', '-', '×', '÷'].includes(t)) {
    return 'text-[42px] font-bold text-[#E9824C]';
  }
  if (['(', ')', '=', '/'].includes(t)) {
    return 'text-[40px] font-bold text-[#8B7565]';
  }
  return 'text-[26px] font-bold text-[#8B7565]'; // m / cm / 时 等单位
}
</script>

<template>
  <div class="flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-4 pt-4">
    <!-- 顶部：退出 / 计时 / 星星 -->
    <header class="flex shrink-0 items-center justify-between">
      <button class="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#B6A190] shadow-sm" @click="exitPractice">✕</button>
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-1 rounded-full bg-white px-3 py-1.5 shadow-sm">
          <span class="text-sm text-[#E9824C]">⏱</span>
          <span class="text-[13px] font-bold tabular-nums">{{ timeText }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-white px-3 py-1.5 shadow-sm">
          <span class="text-sm text-[#F0B44E]">★</span>
          <span class="text-[13px] font-bold">{{ stars }}</span>
        </div>
      </div>
    </header>

    <!-- 进度条 -->
    <div class="mt-4 flex shrink-0 items-center gap-3">
      <div class="h-3 flex-1 overflow-hidden rounded-full bg-[#F2E7DA]">
        <div
          class="h-full rounded-full bg-gradient-to-r from-[#F8C89F] to-[#EC9257] transition-all duration-300"
          :style="{ width: progressPct + '%' }"
        ></div>
      </div>
      <span class="shrink-0 text-[12px] font-bold text-[#8B7565]">
        第 <span class="text-[#E9824C]">{{ idx + 1 }}</span>/{{ total }} 题
      </span>
    </div>

    <!-- 题目区 -->
    <main class="relative flex min-h-0 flex-1 flex-col items-center justify-center py-6">
      <p class="mb-3 flex items-center gap-1 text-[12px] text-[#B6A190]">💡 {{ headerLine }}</p>
      <div
        class="relative w-full rounded-[28px] border border-[#F5E8D8] bg-white px-4 py-7 text-center shadow-[0_10px_30px_rgba(180,140,100,.10)]"
        :class="{ shake: feedback && !feedback.ok }"
      >
        <div class="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#FDF0E2] px-3 py-1 text-[10px] font-semibold text-[#C58E5E]">
          想一想，再按数字
        </div>
        <div class="mt-2 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-2">
          <template v-for="(t, i) in tokens" :key="i">
            <template v-if="t === '□'">
              <!-- 填空位（单位换算/钟表题）内联答案框 -->
              <span
                class="answer-box inline-flex h-[64px] min-w-[80px] items-center justify-center rounded-2xl border-2 border-dashed px-2 text-[44px] font-extrabold leading-none"
                :class="answerBoxClass"
              >{{ boxText }}</span>
            </template>
            <span v-else class="leading-none" :class="tokenClass(t)">{{ t }}</span>
          </template>
          <!-- 无填空位：= 后追加答案框 -->
          <template v-if="!hasBlank">
            <template v-if="twoPart">
              <!-- 双输入框：分子/分母 或 商/余数 -->
              <span
                class="inline-flex h-[74px] items-center justify-center gap-1 rounded-2xl border-2 px-2 leading-none"
                :class="feedback && !feedback.ok ? 'border-[#EBA58E] bg-[#FDF1EC]' : 'border-dashed border-[#EBCBAF] bg-[#FBF3E9]'"
              >
                <button
                  class="flex h-[56px] min-w-[56px] items-center justify-center rounded-xl border-2 bg-white text-[40px] font-extrabold text-[#E9824C]"
                  :class="activePart === 0 ? 'border-[#E9824C]' : 'border-transparent'"
                  @click="selectPart(0)"
                >
                  {{ feedback && !feedback.ok ? answerStr.split(sepChar)[0] : parts[0] || '?' }}
                </button>
                <span class="text-[32px] font-bold text-[#8B7565]">{{ sepChar }}</span>
                <button
                  class="flex h-[56px] min-w-[56px] items-center justify-center rounded-xl border-2 bg-white text-[40px] font-extrabold text-[#E9824C]"
                  :class="activePart === 1 ? 'border-[#E9824C]' : 'border-transparent'"
                  @click="selectPart(1)"
                >
                  {{ feedback && !feedback.ok ? answerStr.split(sepChar)[1] : parts[1] || '?' }}
                </button>
              </span>
            </template>
            <span
              v-else
              class="answer-box inline-flex h-[74px] min-w-[86px] items-center justify-center rounded-2xl border-2 border-dashed px-2 text-[52px] font-extrabold leading-none"
              :class="answerBoxClass"
            >{{ boxText }}</span>
          </template>
        </div>
        <p class="mt-5 text-[12px] text-[#B6A190]">{{ tipText }}</p>
      </div>
    </main>

    <!-- 反馈层 -->
    <div v-if="feedback" class="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
      <div class="pop rounded-[28px] border-2 border-[#F7D9BB] bg-[#FFF7EC] px-7 py-5 text-center shadow-xl">
        <p class="text-[42px] leading-none">{{ feedback.emoji }}</p>
        <p class="mt-2 text-[18px] font-extrabold text-[#D1793F]">{{ feedback.text }}</p>
      </div>
    </div>

    <!-- 数字键盘 -->
    <section class="shrink-0 pt-1">
      <div class="grid grid-cols-3 gap-2.5">
        <button
          v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']"
          :key="d"
          class="key h-[54px] rounded-2xl border border-[#F2E5D6] bg-white text-[24px] font-bold shadow-sm"
          @click="press(d)"
        >
          {{ d }}
        </button>
        <button class="key flex h-[54px] items-center justify-center rounded-2xl border border-[#F2E0CC] bg-[#FBF1E6] text-[#C58E5E] shadow-sm" @click="backspace">
          <span class="text-2xl">⌫</span>
        </button>
        <button class="key h-[54px] rounded-2xl border border-[#F2E5D6] bg-white text-[24px] font-bold shadow-sm" @click="press('0')">0</button>
        <button class="key flex h-[54px] items-center justify-center rounded-2xl bg-[#7BAE8B] text-white shadow-md shadow-[#7BAE8B]/30" @click="submitAnswer">
          <span class="text-2xl">✔</span>
        </button>
      </div>
      <div class="mt-3 flex items-center justify-center gap-4 text-[11px] text-[#B6A190]">
        <button class="flex items-center gap-1" @click="speak(readExpr(paper[idx]))">🔊 读题</button>
        <span class="h-3 w-px bg-[#E4D6C7]"></span>
        <button class="flex items-center gap-1" @click="showHint">需要一点提示？</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
@reference '../style.css';

/* 键盘按压回弹（原型同款） */
.key {
  transition: transform 0.08s ease, background 0.15s ease;
}
.key:active {
  transform: scale(0.95);
  background: #fbe7d6;
}

/* 反馈弹层与卡片动画（原型同款） */
@keyframes pop {
  0% { transform: scale(0.4); opacity: 0; }
  60% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
.pop {
  animation: pop 0.45s ease-out both;
}
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-8px); }
  75% { transform: translateX(8px); }
}
.shake {
  animation: shake 0.3s ease-in-out;
}

/* 答案框对错配色（计算属性注入 ok/no 类名） */
.answer-box {
  border-color: #ebcbaf;
  background: #fbf3e9;
  color: #e9824c;
}
.answer-box.ok {
  border-color: #7bae8b;
  background: #f2f8f2;
}
.answer-box.no {
  border-color: #eba58e;
  background: #fdf1ec;
}
</style>
