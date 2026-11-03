/**
 * store.js —— 页面层全局状态（D1 最小版，D2/D8 扩展）
 * 设计依据：页面层不直接读写 localStorage，统一经 Repository（设计报告 2.4 数据接口）。
 * - repo：Repository 单例（浏览器 localStorage 后端）
 * - currentProfileId：当前孩子档案（FR-09 多档案；首页/D8 家长中心读写）
 * - isParentMode：家长模式开关（FR-11 本机界面切换）
 */
import { reactive } from 'vue';
import { Repository } from './core/repository.js';

// 包成 reactive：repo.version（core 侧写入即 +1 的版本号）成为响应式字段，
// 页面 computed 里 touch 它即可在任意写入后失效缓存（如家长中心改 prefs 即时刷新）。
export const repo = reactive(new Repository()); // 浏览器环境默认 localStorage；数据损坏自动降级（NFR-06）

/** 年级汉字表（1~3 年级，3.2.1 档案 grade 字段展示用） */
export const GRADE_NAMES = ['一', '二', '三'];

/**
 * semester 字段约定（设计报告 3.2.1：学期，值「上/下」）：
 * - 存储值：'上' / '下'；
 * - 兼容旧数据：早期版本误存了 '一上' 等学期全称，读取时取末字归一。
 */
export function semShort(semester) {
  if (!semester) {
    return '上';
  }
  return semester === '上' || semester === '下' ? semester : semester.slice(-1);
}

/** 档案 → 知识点学期全称（如 二上），generator.listKnowledgePoints 的入参格式 */
export function termOf(profile) {
  const g = GRADE_NAMES[(profile?.grade ?? 1) - 1] ?? '一';
  return g + semShort(profile?.semester);
}

/**
 * 产品决策（2026-11-02 用户确认）：以下知识点不参与出题、推荐与掌握度展示
 * （二下「长度单位换算」op=unit；三下「面积与周长口算」op=mixed）。
 * core 知识点配置（设计报告 3.2.1(5)）与生成算法保留不动，偏差以此说明为准。
 */
export const HIDDEN_KP_IDS = ['g2b-unit-length', 'g3b-area-perimeter'];
/** listKnowledgePoints 结果过滤出可见知识点（Setup/Print/Home/Report 共用） */
export function visibleKps(kps) {
  return kps.filter((k) => !HIDDEN_KP_IDS.includes(k.id));
}

export const store = reactive({
  currentProfileId: null,
  isParentMode: false,
  /** 最近一次练习会话（D4 答题页写入，D5 成绩页消费后置空；内存态，刷新即丢，数据已入库不受影响） */
  lastSession: null,
  /** 当前档案（profiles 实体）；未选择时返回 null */
  get currentProfile() {
    if (!this.currentProfileId) {
      return null;
    }
    void repo.version; // 依赖数据版本号：repo 任意写入（改 prefs 等）后强制重新求值
    return repo.load('profiles', this.currentProfileId);
  },
  /** 首次进入：无档案自动建一个默认档案（AC-06 游客可用） */
  ensureProfile() {
    if (this.currentProfileId) {
      return;
    }
    const profiles = repo.load('profiles');
    if (profiles.length > 0) {
      this.currentProfileId = profiles[0]._id;
    } else {
      const profile = {
        _id: 'p_' + Date.now().toString(36),
        nickname: '小朋友',
        grade: 1,
        semester: '上',
        prefs: { questionCount: 30, difficultyMode: 'mixed', dailyLimitMin: 30 },
        createdAt: Date.now(),
      };
      repo.save('profiles', profile);
      this.currentProfileId = profile._id;
    }
  },
});
