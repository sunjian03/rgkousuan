/**
 * store.js —— 页面层全局状态（D1 最小版，D2/D8 扩展）
 * 设计依据：页面层不直接读写 localStorage，统一经 Repository（设计报告 2.4 数据接口）。
 * - repo：Repository 单例（浏览器 localStorage 后端）
 * - currentProfileId：当前孩子档案（FR-09 多档案；首页/D8 家长中心读写）
 * - isParentMode：家长模式开关（FR-11 本机界面切换）
 */
import { reactive } from 'vue';
import { Repository } from './core/repository.js';

export const repo = new Repository(); // 浏览器环境默认 localStorage；数据损坏自动降级（NFR-06）

export const store = reactive({
  currentProfileId: null,
  isParentMode: false,
  /** 当前档案（profiles 实体）；未选择时返回 null */
  get currentProfile() {
    if (!this.currentProfileId) {
      return null;
    }
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
        semester: '一上',
        prefs: { questionCount: 30, difficultyMode: 'mixed', dailyLimitMin: 30 },
        createdAt: Date.now(),
      };
      repo.save('profiles', profile);
      this.currentProfileId = profile._id;
    }
  },
});
