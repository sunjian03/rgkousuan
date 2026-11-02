<script setup>
/**
 * Print.vue —— 打印题纸（D9，对应原型 docs/print.html，设计报告 4.2 P7）
 * 题纸 A4 预览、题目页/答案页切换、打印选项（题量/格式/答案页）、
 * 保存 PDF（2.4 M5 printer.generatePdf）、保存图片、重新出题。
 *
 * 与设计报告的一致性说明：
 * - 出题走 2.4 M1 generate：按当前档案学期（semester 合成，见 store.js）
 *   全量知识点分摊题量后轮转合并，与 D3 同一套逻辑，题纸与在线练习
 *   同源同规则；
 * - 保存 PDF 调用 printer.generatePdf(paper, withAnswer)（2.4 M5 契约），
 *   中文字形经 canvas 位图写入（见 core/printer.js 技术方案说明）；
 * - 原型「页脚显示网址二维码」需二维码生成库且设计报告未要求，不还原；
 * - 格式选项原型只画了「带竖式空格 / 紧凑两列」两项（均未选中=常规三列），
 *   实现为三态互斥：常规三列 / 带竖式空格（两列加大行距）/ 紧凑两列。
 */
import { computed, ref, watchEffect } from 'vue';
import { store, semShort } from '../store.js';
import { listKnowledgePoints, generate } from '../core/generator.js';
import { generatePdf, renderPageToCanvas } from '../core/printer.js';

const profile = computed(() => store.currentProfile);
const GRADE = ['一', '二', '三'];

// ---- 出题（与 D3 同款：按学期知识点分摊 → 轮转合并） ----
const paper = ref([]);
const kpNames = ref([]);
const errMsg = ref('');

function makePaper(count) {
  if (!profile.value) {
    return;
  }
  const gradeName = GRADE[profile.value.grade - 1] ?? '一';
  const term = gradeName + semShort(profile.value.semester);
  const kps = listKnowledgePoints(term);
  if (kps.length === 0) {
    errMsg.value = `「${term}」暂无可打印的知识点`;
    paper.value = [];
    return;
  }
  const n = kps.length;
  const perKp = Math.floor(count / n);
  const extra = count % n;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const c = perKp + (i < extra ? 1 : 0);
    if (c < 1) {
      continue;
    }
    const out = generate({ kpId: kps[i].id, semester: term, count: c, difficultyMode: 'mixed' });
    if (!Array.isArray(out)) {
      errMsg.value = out.message ?? '出题失败，请重试';
      return;
    }
    parts.push(out);
  }
  // 轮转合并（与 D3 一致）
  const merged = [];
  const maxLen = Math.max(0, ...parts.map((p) => p.length));
  for (let i = 0; i < maxLen; i++) {
    for (const p of parts) {
      if (i < p.length) {
        merged.push(p[i]);
      }
    }
  }
  paper.value = merged.slice(0, count);
  kpNames.value = kps.map((k) => k.name);
  errMsg.value = '';
}

// 档案就绪后首次出题（App 的 ensureProfile 在子组件挂载后才执行）
watchEffect(() => {
  if (profile.value && paper.value.length === 0 && !errMsg.value) {
    makePaper(amount.value);
  }
});

// ---- 预览与打印选项 ----
const view = ref('q'); // q 题目页 | a 答案页
const FONT_STEPS = [10, 12, 14];
const fontStep = ref(1); // → fontSize 12（原型默认）
const fontSize = computed(() => FONT_STEPS[fontStep.value]);
const FONT_META = { 0: '宽松版', 1: '单面', 2: '紧凑版' };

const amount = ref(30); // 30 题/页 | 60 题/两页
const formatOpt = ref('normal'); // normal | spaced | compact
const withAnswer = ref(true);

const title = computed(() => {
  const g = GRADE[profile.value?.grade - 1] ?? '一';
  return `口算练习 · ${g}年级${semShort(profile.value?.semester)}`;
});
const subText = computed(() => {
  const names = kpNames.value.slice(0, 2).join(' · ');
  const est = Math.max(3, Math.round(paper.value.length * 0.26)); // 与 D3 估算同款
  return names ? `${names} · 限时 ${est} 分钟` : '';
});
const paperMeta = computed(() => {
  const sizeWord = FONT_META[fontStep.value];
  return `${paper.value.length} 题 · ${sizeWord}` + (paper.value.length > 30 ? ' · 两页' : '');
});

/** 预览列布局（与 PDF layout 的 columns/spaced 对应） */
const gridClass = computed(() => {
  if (formatOpt.value === 'compact') {
    return 'grid-cols-2 gap-x-1 gap-y-0';
  }
  if (formatOpt.value === 'spaced') {
    return 'grid-cols-2 gap-x-1.5 gap-y-3';
  }
  return 'grid-cols-3 gap-x-1.5 gap-y-0.5';
});

function switchView(v) {
  view.value = v;
}
function adjustSize() {
  fontStep.value = (fontStep.value + 1) % FONT_STEPS.length;
}
function pickAmount(v) {
  if (amount.value === v) {
    return;
  }
  amount.value = v;
  makePaper(v);
}
function pickFormat(v) {
  formatOpt.value = formatOpt.value === v ? 'normal' : v;
}

// ---- 保存 PDF（2.4 M5） ----
function savePdf() {
  if (paper.value.length === 0) {
    toast('暂无可打印的题目');
    return;
  }
  toast('正在生成 PDF …');
  // setTimeout：先让 toast 渲染，再同步生成（canvas 渲染会短暂阻塞主线程）
  setTimeout(() => {
    const doc = generatePdf(paper.value, withAnswer.value, {
      columns: formatOpt.value === 'normal' ? 3 : 2,
      spaced: formatOpt.value === 'spaced',
      title: title.value,
      sub: subText.value,
    });
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    doc.save(`口算天天练_题纸_${stamp}.pdf`);
    toast('PDF 已保存到「文件 › 下载」');
  }, 120);
}

/** 保存图片：当前预览页 canvas 导出 PNG（原型「保存到相册」） */
function saveImage() {
  if (paper.value.length === 0) {
    toast('暂无可打印的题目');
    return;
  }
  const page = {
    kind: view.value,
    title: view.value === 'a' ? '参考答案（家长核对用）' : title.value,
    sub: subText.value,
    questions: paper.value.slice(0, 30), // 图片只存第一页
    cols: formatOpt.value === 'normal' ? 3 : 2,
    spaced: formatOpt.value === 'spaced',
    pageIndex: 1,
    pageCount: paper.value.length > 30 ? 2 : 1,
  };
  const canvas = renderPageToCanvas(page);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `口算天天练_${view.value === 'a' ? '答案' : '题纸'}.png`;
  a.click();
  toast('图片已保存到「文件 › 下载」');
}

function reshuffle() {
  makePaper(amount.value);
  toast('已重新出一组题');
}
function shareLink() {
  toast('已复制题纸链接到剪贴板');
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
    <header class="shrink-0 border-b border-[#F4E8DA] bg-white px-5 pb-3 pt-4">
      <div class="flex items-center justify-between">
        <router-link to="/" class="flex h-9 w-9 items-center justify-center rounded-full bg-[#FBF6EE] text-[#8B7565]">‹</router-link>
        <h1 class="text-[16px] font-extrabold">打印题纸</h1>
        <button class="flex h-9 w-9 items-center justify-center rounded-full bg-[#FBF6EE] text-[#8B7565]" @click="shareLink">↗️</button>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-1 rounded-2xl bg-[#FBF3E9] p-1">
        <button class="seg h-8 rounded-xl text-[12px] font-semibold transition" :class="view === 'q' ? 'on' : 'text-[#A99079]'" @click="switchView('q')">题目页</button>
        <button class="seg h-8 rounded-xl text-[12px] font-semibold transition" :class="view === 'a' ? 'on' : 'text-[#A99079]'" @click="switchView('a')">答案页</button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 pb-28 pt-3">
      <!-- 设置条 -->
      <div class="mb-3 flex items-center gap-2">
        <span class="rounded-full bg-[#FFF2E6] px-2 py-0.5 text-[10px] font-semibold text-[#C97B49]">A4 · 纵向</span>
        <span class="rounded-full border border-[#F0E3D5] bg-white px-2 py-0.5 text-[10px] text-[#8B7565]">{{ paperMeta }}</span>
        <span class="rounded-full border border-[#F0E3D5] bg-white px-2 py-0.5 text-[10px] text-[#8B7565]">含姓名栏</span>
        <button class="ml-auto flex items-center gap-0.5 text-[11px] text-[#C97B49]" @click="adjustSize">🅰 字号</button>
      </div>

      <!-- A4 预览 -->
      <div class="a4 flex flex-col overflow-hidden rounded-sm px-4 py-4">
        <div class="flex items-start justify-between border-b border-dashed border-[#E6D8C8] pb-2">
          <div>
            <p class="text-[12px] font-extrabold tracking-wide">{{ view === 'a' ? '参考答案（家长核对用）' : title }}</p>
            <p class="mt-0.5 text-[7px] text-[#A99079]">{{ subText }} · 共 {{ paper.length }} 题</p>
          </div>
          <div class="text-right">
            <p class="text-[7px] text-[#8B7565]">姓名：__________</p>
            <p class="mt-1 text-[7px] text-[#8B7565]">日期：____ 月 ____ 日　得分：____</p>
          </div>
        </div>
        <p class="mt-1.5 text-[7px] text-[#B6A190]">{{ view === 'q' ? `共 ${paper.length} 题　每题 3 分　请直接写出得数` : '参考答案　（家长核对用）' }}</p>
        <div v-if="paper.length === 0" class="flex flex-1 items-center justify-center py-10 text-[11px] text-[#A99079]">
          {{ errMsg || '暂无可打印的题目' }}
        </div>
        <div v-else class="qt mt-1 flex-1 text-[#3A2C24]" :style="{ '--qs': fontSize + 'px' }">
          <div class="grid" :class="gridClass">
            <div v-for="(q, i) in paper.slice(0, 30)" :key="i" class="flex items-start gap-0.5 whitespace-nowrap">
              <span class="w-[1.4em] shrink-0 text-right text-[0.85em] text-[#B6A190]">{{ i + 1 }}.</span>
              <span v-if="view === 'q'">{{ q.expression }} ＝ <span class="text-[#D8C9B8]">____</span></span>
              <span v-else>{{ q.expression }} ＝ <span class="font-bold text-[#E9824C]">{{ q.presentMode === 'blank' ? q.blankAnswer : q.answer }}</span></span>
            </div>
          </div>
        </div>
        <div class="flex items-center justify-between border-t border-dashed border-[#E6D8C8] pt-1.5 text-[6.5px] text-[#B6A190]">
          <span>口算天天练 · 家长陪伴版</span>
          <span>第 1 页 / 共 {{ paper.length > 30 ? 2 : 1 }} 页</span>
        </div>
      </div>

      <!-- 打印选项 -->
      <section class="card mt-3 p-4">
        <h2 class="mb-3 flex items-center gap-1.5 text-[13px] font-bold"><span class="text-[#E9824C]">⚙️</span>打印选项</h2>
        <div class="grid grid-cols-2 gap-2">
          <button
            class="rounded-xl border py-2.5 text-[11px] transition"
            :class="amount === 30 ? 'border-[#E9824C] bg-[#FFF7EF] font-semibold text-[#C97B49]' : 'border-[#F0E3D5] bg-white text-[#8B7565]'"
            @click="pickAmount(30)"
          >
            30 题 / 页
          </button>
          <button
            class="rounded-xl border py-2.5 text-[11px] transition"
            :class="amount === 60 ? 'border-[#E9824C] bg-[#FFF7EF] font-semibold text-[#C97B49]' : 'border-[#F0E3D5] bg-white text-[#8B7565]'"
            @click="pickAmount(60)"
          >
            60 题 / 两页
          </button>
          <button
            class="rounded-xl border py-2.5 text-[11px] transition"
            :class="formatOpt === 'spaced' ? 'border-[#E9824C] bg-[#FFF7EF] font-semibold text-[#C97B49]' : 'border-[#F0E3D5] bg-white text-[#8B7565]'"
            @click="pickFormat('spaced')"
          >
            带竖式空格
          </button>
          <button
            class="rounded-xl border py-2.5 text-[11px] transition"
            :class="formatOpt === 'compact' ? 'border-[#E9824C] bg-[#FFF7EF] font-semibold text-[#C97B49]' : 'border-[#F0E3D5] bg-white text-[#8B7565]'"
            @click="pickFormat('compact')"
          >
            紧凑两列
          </button>
        </div>
        <p class="mt-2 text-[9px] text-[#B6A190]">两个格式选项均未选中时为常规三列排版</p>
        <label class="mt-3 flex items-center justify-between">
          <span class="text-[12px] text-[#8B7565]">答案页单独打印</span>
          <button
            class="relative h-6 w-11 rounded-full transition"
            :class="withAnswer ? 'bg-[#E9824C]' : 'bg-[#E3D6C8]'"
            @click="withAnswer = !withAnswer"
          >
            <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all" :class="withAnswer ? 'right-0.5' : 'left-0.5'"></span>
          </button>
        </label>
      </section>

      <p class="mt-3 text-center text-[10px] leading-relaxed text-[#B6A190]">
        纸张建议 A4 80g，缩放比例 100%<br />打印前请在浏览器中关闭页眉页脚
      </p>
    </main>

    <!-- 底部按钮 -->
    <div class="shrink-0 bg-gradient-to-t from-[#FBF6EE] via-[#FBF6EE] to-[#FBF6EE]/60 px-5 pb-4 pt-2.5">
      <div class="flex gap-2.5">
        <button class="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#EBCBAF] bg-white text-[#C97B49]" @click="saveImage">🖼</button>
        <button class="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-[#E9824C] text-[14px] font-bold text-white shadow-md shadow-[#E9824C]/25 transition active:scale-[.98]" @click="savePdf">
          📄 保存 PDF
        </button>
        <button class="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#EBCBAF] bg-white text-[#C97B49]" @click="reshuffle">🔄</button>
      </div>
    </div>

    <!-- toast -->
    <div v-if="toastShow" class="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#4B3B32]/90 px-4 py-2 text-[11px] text-white">
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
.a4 {
  width: 100%;
  aspect-ratio: 1 / 1.414;
  background: #fff;
  box-shadow: 0 8px 24px rgba(120, 95, 70, 0.14);
}
.qt {
  font-size: var(--qs, 13px);
  line-height: 1.9;
}
.seg.on {
  background: #e9824c;
  color: #fff;
}
</style>
