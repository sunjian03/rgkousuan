<script setup>
/**
 * Parent.vue —— 家长中心（D8，对应原型 docs/parent.html，设计报告 4.2 P8）
 * 孩子档案管理（FR-09 多档案 ≤3 个）、练习设置、护眼时长限制（FR-11）、
 * 数据导出/导入/删除（2.4 数据接口 + FR-09 跨设备迁移）、退出儿童模式。
 * 页面层只调用 2.4 接口：repository.save/load/exportJson/importJson/clear、
 * stats.getReport（今日已用时长）、achievement（打卡天数）。
 *
 * 与设计报告的一致性说明：
 * - 档案 semester 存「上/下」（3.2.1），显示/表单用 GRADE_NAMES 合成；
 * - 练习设置写入 profiles.prefs 契约字段 {questionCount, difficultyMode,
 *   dailyLimitMin}；「错题自动收集」「答题音效」与 D3 一致存扩展字段
 *   autoWrongToBook / speechEnabled（默认开启 = 设计行为）；
 * - 导出格式为 JSON 备份（3.3.6 流程），原型「导出 Excel」文案不还原；
 *   导入（importJson）为 2.4 契约能力，原型未画，按 FR-09 迁移需求补上；
 * - 原型「6 岁」档案无 age 字段（3.2.1 未定义），改展示「已练 N 天」
 *   （打卡天数）；原型「20:30 后停用 / 每 15 分钟远眺提醒」为示意 chip，
 *   实际 FR-11 防沉迷落地在 prefs.dailyLimitMin（本节设置，D4/D3 入口检查，
 *   D4 练中每分钟检查），chips 文案按真实行为改为「每日上限 N 分钟 /
 *   练中每分钟检查提醒」；
 * - 无后端，家长验证按 FR-11「本机界面切换」：进入本页即视为验证通过，
 *   30 分钟有效期与原型一致（到期提示重新进入）。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { store, repo, GRADE_NAMES, semShort } from '../store.js';
import { avatarOf } from '../avatars.js';
import { StatsService } from '../core/stats.js';
import { AchievementService } from '../core/achievement.js';

const router = useRouter();
const stats = new StatsService(repo);
const achievement = new AchievementService(repo);

store.ensureProfile();
store.isParentMode = true; // FR-11 本机界面切换：进入家长中心即家长模式

// ---- 家长验证有效期（原型同款：30 分钟） ----
const enterAt = Date.now();
const VALID_MIN = 30;
const nowTick = ref(Date.now());
let tickTimer = null;
onMounted(() => {
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 30000);
});
onUnmounted(() => clearInterval(tickTimer));
const expired = computed(() => nowTick.value > enterAt + VALID_MIN * 60000);
const expireText = computed(() => {
  const d = new Date(enterAt + VALID_MIN * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 到期`;
});

// ---- 孩子档案（FR-09 多档案，上限 3 个） ----
const profiles = computed(() => {
  void repo.version; // 数据版本依赖：增改档案/导入/清空后列表即时刷新
  return repo.load('profiles');
});
const profile = computed(() => store.currentProfile);
const pid = computed(() => store.currentProfileId);
const MAX_KIDS = 3;

/** 已练天数 = 打卡天数（achievements.checkinDates，3.2.1） */
function trainedDays(id) {
  return achievement.getOrCreate(id).checkinDates.length;
}
function metaOf(p) {
  return `${GRADE_NAMES[p.grade - 1] ?? '一'}年级${semShort(p.semester)} · 已练 ${trainedDays(p._id)} 天`;
}

// ---- 档案表单（添加/编辑共用） ----
const kidFormOpen = ref(false);
const kidFormMode = ref('add'); // add | edit
const kidForm = reactive({ _id: '', nickname: '', grade: 1, semester: '上' });
const GRADE_OPTS = [1, 2, 3];
const SEM_OPTS = ['上', '下'];

function openAdd() {
  if (profiles.value.length >= MAX_KIDS) {
    toast(`本机最多创建 ${MAX_KIDS} 个孩子档案（FR-09）`);
    return;
  }
  kidFormMode.value = 'add';
  Object.assign(kidForm, { _id: '', nickname: '', grade: 1, semester: '上' });
  kidFormOpen.value = true;
}
function openEdit(p) {
  kidFormMode.value = 'edit';
  Object.assign(kidForm, { _id: p._id, nickname: p.nickname, grade: p.grade, semester: semShort(p.semester) });
  kidFormOpen.value = true;
}
function saveKid() {
  const name = kidForm.nickname.trim();
  if (!name) {
    toast('请填写孩子昵称');
    return;
  }
  if (kidFormMode.value === 'edit') {
    const p = repo.load('profiles', kidForm._id);
    if (p) {
      repo.save('profiles', { ...p, nickname: name, grade: kidForm.grade, semester: kidForm.semester });
      toast(`已保存「${name}」的档案`);
    }
  } else {
    const p = {
      _id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      nickname: name,
      grade: kidForm.grade,
      semester: kidForm.semester,
      prefs: { questionCount: 30, difficultyMode: 'mixed', dailyLimitMin: 30 },
      createdAt: Date.now(),
    };
    repo.save('profiles', p);
    store.currentProfileId = p._id; // 新档案自动切换为当前
    toast(`新档案已创建：${name} · ${GRADE_NAMES[p.grade - 1]}年级${p.semester}`);
  }
  kidFormOpen.value = false;
}
function switchTo(p) {
  if (p._id === store.currentProfileId) {
    return;
  }
  store.currentProfileId = p._id;
  toast(`已切换到「${p.nickname}」的学习档案`);
}

// ---- 练习设置（当前档案 prefs；改动即保存） ----
const DIFF_OPTS = [
  { key: 'basic', label: '简单' },
  { key: 'mixed', label: '标准' },
  { key: 'advance', label: '挑战' },
];
const AMOUNT_MIN = 10;
const AMOUNT_MAX = 60;

function patchPrefs(patch) {
  const p = repo.load('profiles', pid.value);
  if (!p) {
    return;
  }
  repo.save('profiles', { ...p, prefs: { ...p.prefs, ...patch } });
}
function changeAmount(delta) {
  const q = Math.min(AMOUNT_MAX, Math.max(AMOUNT_MIN, (profile.value.prefs?.questionCount ?? 30) + delta));
  patchPrefs({ questionCount: q });
}
function setDifficulty(key) {
  patchPrefs({ difficultyMode: key });
}

// ---- 护眼时长限制（FR-11：prefs.dailyLimitMin） ----
/** 今日已用（分钟）：3.3.5 日报告 totalDurationSec */
const todayUsedMin = computed(() => {
  if (!pid.value) {
    return 0;
  }
  void repo.version; // 数据版本依赖：导入备份/清空数据后已用时长即时刷新
  return Math.round(stats.getReport(pid.value, 'day').summary.totalDurationSec / 60);
});
const limitMin = computed(() => profile.value?.prefs?.dailyLimitMin ?? 30);
const usagePct = computed(() =>
  limitMin.value > 0 ? Math.min(100, Math.round((todayUsedMin.value / limitMin.value) * 100)) : 0
);
const leftMin = computed(() => Math.max(0, limitMin.value - todayUsedMin.value));
function setLimit(v) {
  patchPrefs({ dailyLimitMin: Number(v) });
}

// ---- 数据管理（2.4：exportJson / importJson / clear） ----
function exportData() {
  const json = repo.exportJson();
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `口算天天练_备份_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 JSON 备份（档案/练习记录/错题/成就）');
}

/** 导入入口：隐藏 file input，读文本后走 importJson（校验+合并写入） */
const fileInput = ref(null);
function pickImport() {
  fileInput.value?.click();
}
function importFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const out = repo.importJson(String(reader.result));
    if (out.ok) {
      toast(`导入成功：记录 ${out.imported.practice_records} 条、错题 ${out.imported.wrong_items} 道`);
    } else {
      toast(out.message);
    }
  };
  reader.readAsText(file);
}

/** 删除确认弹窗里的真实数据量（原型同款文案） */
const deleteStats = computed(() => {
  void repo.version; // 数据版本依赖
  return {
    records: repo.load('practice_records').length,
    wrong: repo.load('wrong_items').length,
  };
});
const showDelete = ref(false);
function doDelete() {
  repo.clear();
  store.currentProfileId = null;
  store.ensureProfile(); // 清空后重建默认档案（AC-06 游客可用）
  showDelete.value = false;
  toast('数据已删除');
}

// ---- 其他入口 ----
function about() {
  toast('已是最新版本 v2.4.0');
}

// ---- 退出儿童模式 ----
const showExit = ref(false);
function exitParent() {
  store.isParentMode = false;
  router.push('/');
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
    <header class="shrink-0 px-5 pb-3 pt-4">
      <div class="flex items-center justify-between">
        <router-link to="/" class="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#8B7565] shadow-sm">‹</router-link>
        <h1 class="text-[16px] font-extrabold">家长中心</h1>
        <router-link to="/calendar" class="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#8B7565] shadow-sm">📅</router-link>
      </div>
      <!-- 家长验证卡片 -->
      <div class="card mt-3 flex items-center gap-3 px-4 py-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#EAF1EA] text-[#6A9A79]">🛡️</div>
        <div class="flex-1">
          <p class="text-[12px] font-bold">{{ expired ? '家长验证已过期' : '家长验证已通过' }}</p>
          <p class="mt-0.5 text-[10px]" :class="expired ? 'text-[#D4796A]' : 'text-[#A99079]'">
            {{ expired ? '请返回首页重新进入以延长有效期' : `验证有效期 ${VALID_MIN} 分钟 · ${expireText}` }}
          </p>
        </div>
        <span class="rounded-full px-2 py-0.5 text-[10px]" :class="expired ? 'bg-[#FDECEC] text-[#D4796A]' : 'bg-[#EFF5EF] text-[#6A9A79]'">{{ expired ? '过期' : '安全' }}</span>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 pb-6">
      <!-- 孩子档案 -->
      <section class="mt-1">
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-[13px] font-bold">孩子档案</h2>
          <button class="flex items-center gap-0.5 text-[11px] text-[#C97B49]" @click="openAdd">＋ 添加孩子</button>
        </div>
        <div class="space-y-2">
          <div
            v-for="p in profiles"
            :key="p._id"
            class="card flex cursor-pointer items-center gap-3 p-3.5"
            :class="p._id === store.currentProfileId ? 'border-2 border-[#F3D3B4]' : ''"
            @click="switchTo(p)"
          >
            <div class="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FBE0CB] text-2xl">{{ avatarOf(profiles, p._id) }}</div>
            <div class="flex-1">
              <div class="flex items-center gap-1.5">
                <p class="text-[14px] font-bold">{{ p.nickname }}</p>
                <span v-if="p._id === store.currentProfileId" class="rounded-full bg-[#FFF2E6] px-2 py-0.5 text-[10px] font-semibold text-[#C97B49]">当前</span>
              </div>
              <p class="mt-0.5 text-[10px] text-[#A99079]">{{ metaOf(p) }}</p>
            </div>
            <button class="flex h-8 w-8 items-center justify-center rounded-full bg-[#FBF6EE] text-[#B6A190]" @click.stop="openEdit(p)">✏️</button>
          </div>
        </div>
        <p class="mt-2 text-[10px] leading-relaxed text-[#B6A190]">每位孩子拥有独立的学习记录、错题本与打卡日历，切换档案不影响数据。</p>
      </section>

      <!-- 练习设置 -->
      <section class="mt-4">
        <h2 class="mb-2 text-[13px] font-bold">练习设置</h2>
        <div class="card divide-y divide-[#F6EEE4]">
          <div class="flex items-center justify-between px-3.5 py-3">
            <div>
              <p class="text-[12px] font-semibold">默认题量</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">一键出题时使用的题量</p>
            </div>
            <div class="flex items-center gap-1.5">
              <button class="flex h-7 w-7 items-center justify-center rounded-full bg-[#FBF3E9] text-[#B08F76]" @click="changeAmount(-5)">−</button>
              <span class="w-10 text-center text-[13px] font-bold">{{ profile?.prefs?.questionCount ?? 30 }} 题</span>
              <button class="flex h-7 w-7 items-center justify-center rounded-full bg-[#FBF3E9] text-[#B08F76]" @click="changeAmount(5)">＋</button>
            </div>
          </div>
          <div class="flex items-center justify-between px-3.5 py-3">
            <div>
              <p class="text-[12px] font-semibold">默认难度</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">可在出题时临时调整</p>
            </div>
            <select
              class="rounded-lg border border-[#F3D3B4] bg-[#FFF7EF] px-2 py-1.5 text-[12px] font-semibold text-[#C97B49] outline-none"
              :value="profile?.prefs?.difficultyMode ?? 'mixed'"
              @change="setDifficulty($event.target.value)"
            >
              <option v-for="d in DIFF_OPTS" :key="d.key" :value="d.key">{{ d.label }}</option>
            </select>
          </div>
          <div class="flex items-center justify-between px-3.5 py-3">
            <div>
              <p class="text-[12px] font-semibold">错题自动收集</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">练习结束后自动写入错题本</p>
            </div>
            <button
              class="relative h-6 w-11 rounded-full transition"
              :class="(profile?.prefs?.autoWrongToBook ?? true) ? 'bg-[#E9824C]' : 'bg-[#E3D6C8]'"
              @click="patchPrefs({ autoWrongToBook: !(profile?.prefs?.autoWrongToBook ?? true) })"
            >
              <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all" :class="(profile?.prefs?.autoWrongToBook ?? true) ? 'right-0.5' : 'left-0.5'"></span>
            </button>
          </div>
          <div class="flex items-center justify-between px-3.5 py-3">
            <div>
              <p class="text-[12px] font-semibold">答题音效</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">答题时朗读题目与提示音</p>
            </div>
            <button
              class="relative h-6 w-11 rounded-full transition"
              :class="(profile?.prefs?.speechEnabled ?? true) ? 'bg-[#E9824C]' : 'bg-[#E3D6C8]'"
              @click="patchPrefs({ speechEnabled: !(profile?.prefs?.speechEnabled ?? true) })"
            >
              <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all" :class="(profile?.prefs?.speechEnabled ?? true) ? 'right-0.5' : 'left-0.5'"></span>
            </button>
          </div>
        </div>
      </section>

      <!-- 护眼时长限制 -->
      <section class="mt-4">
        <h2 class="mb-2 text-[13px] font-bold">护眼时长限制</h2>
        <div class="card p-3.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-[#F3F7F2] text-[#6A9A79]">👁</div>
              <div>
                <p class="text-[12px] font-semibold">每日使用上限</p>
                <p class="mt-0.5 text-[10px] text-[#A99079]">今天已用 {{ todayUsedMin }} 分钟</p>
              </div>
            </div>
            <span class="text-[13px] font-extrabold text-[#E9824C]">{{ limitMin }} 分钟</span>
          </div>
          <input
            class="mt-3 w-full accent-[#E9824C]"
            type="range"
            min="10"
            max="90"
            step="10"
            :value="limitMin"
            @input="setLimit($event.target.value)"
          />
          <div class="mt-0.5 flex justify-between text-[9px] text-[#C8B5A3]">
            <span>10 分钟</span><span>{{ limitMin }} 分钟</span><span>90 分钟</span>
          </div>
          <div class="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[#F3EBE1]">
            <div class="h-full rounded-full bg-[#7BAE8B]" :style="{ width: usagePct + '%' }"></div>
          </div>
          <p class="mt-1.5 text-[10px]" :class="leftMin > 0 ? 'text-[#7D9A87]' : 'text-[#D4796A]'">
            {{ leftMin > 0 ? `还可使用 ${leftMin} 分钟，超时后将自动进入休息提醒。` : '今日时长已用完，建议休息一下。' }}
          </p>
          <div class="mt-3 flex gap-2">
            <span class="rounded-full bg-[#FBF3E9] px-2.5 py-1 text-[10px] text-[#A9825F]">🌙 每日上限 {{ limitMin }} 分钟</span>
            <span class="rounded-full bg-[#FBF3E9] px-2.5 py-1 text-[10px] text-[#A9825F]">练中每分钟检查提醒</span>
          </div>
        </div>
      </section>

      <!-- 数据管理 -->
      <section class="mt-4">
        <h2 class="mb-2 text-[13px] font-bold">数据管理</h2>
        <div class="card divide-y divide-[#F6EEE4]">
          <button class="flex w-full items-center gap-3 px-3.5 py-3.5" @click="exportData">
            <span class="text-lg text-[#6A9A79]">⬇️</span>
            <div class="flex-1 text-left">
              <p class="text-[12px] font-semibold">导出数据</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">档案、练习记录、错题、成就（JSON 备份）</p>
            </div>
            <span class="text-[#D5C4B4]">›</span>
          </button>
          <button class="flex w-full items-center gap-3 px-3.5 py-3.5" @click="pickImport">
            <span class="text-lg text-[#6A9A79]">⬆️</span>
            <div class="flex-1 text-left">
              <p class="text-[12px] font-semibold">导入数据</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">从 JSON 备份恢复（跨设备迁移）</p>
            </div>
            <span class="text-[#D5C4B4]">›</span>
          </button>
          <input ref="fileInput" type="file" accept=".json,application/json" class="hidden" @change="importFile" />
          <button class="flex w-full items-center gap-3 px-3.5 py-3.5" @click="showDelete = true">
            <span class="text-lg text-[#D4796A]">🗑</span>
            <div class="flex-1 text-left">
              <p class="text-[12px] font-semibold text-[#C96B5A]">删除数据</p>
              <p class="mt-0.5 text-[10px] text-[#A99079]">不可恢复，请谨慎操作</p>
            </div>
            <span class="text-[#D5C4B4]">›</span>
          </button>
        </div>
      </section>

      <!-- 其他 -->
      <section class="card mt-3 divide-y divide-[#F6EEE4]">
        <router-link to="/print" class="flex items-center gap-3 px-3.5 py-3.5">
          <span class="text-lg text-[#8B7565]">🖨</span>
          <p class="flex-1 text-[12px] font-semibold">打印题纸</p>
          <span class="text-[#D5C4B4]">›</span>
        </router-link>
        <router-link to="/calendar" class="flex items-center gap-3 px-3.5 py-3.5">
          <span class="text-lg text-[#8B7565]">📅</span>
          <p class="flex-1 text-[12px] font-semibold">打卡日历</p>
          <span class="text-[#D5C4B4]">›</span>
        </router-link>
        <button class="flex w-full items-center gap-3 px-3.5 py-3.5" @click="about">
          <span class="text-lg text-[#8B7565]">ℹ️</span>
          <p class="flex-1 text-left text-[12px] font-semibold">关于口算天天练</p>
          <span class="text-[10px] text-[#B6A190]">v2.4.0</span>
        </button>
      </section>

      <!-- 退出儿童模式 -->
      <button class="mt-4 flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl border border-[#EBCBAF] bg-white text-[13px] font-bold text-[#C97B49]" @click="showExit = true">
        🚪 退出儿童模式
      </button>
      <p class="mb-2 mt-2 text-center text-[10px] text-[#B6A190]">退出后将回到家长首页，需要重新验证才能进入设置</p>
    </main>

    <!-- 档案表单弹层 -->
    <div v-if="kidFormOpen" class="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-8" @click.self="kidFormOpen = false">
      <div class="w-full rounded-3xl bg-white p-5">
        <h3 class="text-[15px] font-extrabold">{{ kidFormMode === 'add' ? '添加孩子' : '编辑档案' }}</h3>
        <p class="mt-1 text-[10px] text-[#A99079]">昵称用于区分档案，请勿填写孩子真名（最小化采集）</p>
        <div class="mt-4 space-y-3">
          <div>
            <label class="text-[11px] font-semibold text-[#8B7565]">昵称</label>
            <input v-model="kidForm.nickname" maxlength="12" placeholder="如：小满" class="mt-1 w-full rounded-xl border border-[#F0E3D5] bg-[#FBF6EE] px-3 py-2.5 text-[13px] outline-none focus:border-[#E9824C]" />
          </div>
          <div class="flex gap-3">
            <div class="flex-1">
              <label class="text-[11px] font-semibold text-[#8B7565]">年级</label>
              <select v-model.number="kidForm.grade" class="mt-1 w-full rounded-xl border border-[#F0E3D5] bg-[#FBF6EE] px-3 py-2.5 text-[13px] outline-none">
                <option v-for="g in GRADE_OPTS" :key="g" :value="g">{{ GRADE_NAMES[g - 1] }}年级</option>
              </select>
            </div>
            <div class="flex-1">
              <label class="text-[11px] font-semibold text-[#8B7565]">学期</label>
              <select v-model="kidForm.semester" class="mt-1 w-full rounded-xl border border-[#F0E3D5] bg-[#FBF6EE] px-3 py-2.5 text-[13px] outline-none">
                <option v-for="s in SEM_OPTS" :key="s" :value="s">{{ s }}学期</option>
              </select>
            </div>
          </div>
        </div>
        <div class="mt-4 flex gap-2.5">
          <button class="h-11 flex-1 rounded-xl bg-[#FBF3E9] text-[13px] font-semibold text-[#8B7565]" @click="kidFormOpen = false">取消</button>
          <button class="h-11 flex-1 rounded-xl bg-[#E9824C] text-[13px] font-bold text-white" @click="saveKid">保存</button>
        </div>
      </div>
    </div>

    <!-- 退出确认弹窗 -->
    <div v-if="showExit" class="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-8" @click.self="showExit = false">
      <div class="w-full rounded-3xl bg-white p-5 text-center">
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#FFF2E6] text-[#E9824C]">🚪</div>
        <h3 class="mt-3 text-[15px] font-extrabold">确认退出儿童模式？</h3>
        <p class="mt-1.5 text-[11px] leading-relaxed text-[#8B7565]">
          当前孩子「{{ profile?.nickname }}」的练习进度会保存。<br />退出后需家长验证才能再次修改设置。
        </p>
        <div class="mt-4 flex gap-2.5">
          <button class="h-11 flex-1 rounded-xl bg-[#FBF3E9] text-[13px] font-semibold text-[#8B7565]" @click="showExit = false">再练一会</button>
          <button class="flex h-11 flex-1 items-center justify-center rounded-xl bg-[#E9824C] text-[13px] font-bold text-white" @click="exitParent">确认退出</button>
        </div>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="showDelete" class="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-8" @click.self="showDelete = false">
      <div class="w-full rounded-3xl bg-white p-5 text-center">
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#FDECEC] text-[#D4796A]">⚠️</div>
        <h3 class="mt-3 text-[15px] font-extrabold">删除全部练习数据？</h3>
        <p class="mt-1.5 text-[11px] leading-relaxed text-[#8B7565]">
          将删除 {{ deleteStats.records }} 条练习记录、{{ deleteStats.wrong }} 道错题与打卡记录，且无法恢复。
        </p>
        <div class="mt-4 flex gap-2.5">
          <button class="h-11 flex-1 rounded-xl bg-[#FBF3E9] text-[13px] font-semibold text-[#8B7565]" @click="showDelete = false">取消</button>
          <button class="h-11 flex-1 rounded-xl bg-[#D4796A] text-[13px] font-bold text-white" @click="doDelete">确认删除</button>
        </div>
      </div>
    </div>

    <!-- toast -->
    <div v-if="toastShow" class="fixed bottom-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#4B3B32]/90 px-4 py-2 text-[11px] text-white">
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
</style>
