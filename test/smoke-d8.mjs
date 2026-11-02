// 冒烟：模拟 D8 家长中心 + P9 打卡日历页面链路
// （档案增改与上限、prefs 偏好写回、导出/导入/删除、护眼时长统计、
//   手动补签与连续打卡、月历单元格算法、最近 7 天汇总）
import { Repository, MemoryStorage } from '../src/core/repository.js';
import { AchievementService } from '../src/core/achievement.js';
import { StatsService } from '../src/core/stats.js';

const repo = new Repository(new MemoryStorage());
const achievement = new AchievementService(repo);
const stats = new StatsService(repo);

// ============ D8 家长中心链路 ============
// 1) 档案创建（FR-09 上限 3 个；Parent.openAdd 同款拦截：数量达上限则不打开表单）
const MAX_KIDS = 3;
const GRADE_NAMES = ['一', '二', '三'];
function createKid(nickname, grade, semester) {
  if (repo.load('profiles').length >= MAX_KIDS) {
    return null; // openAdd 拦截：不进入表单、不创建
  }
  const p = {
    _id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    nickname,
    grade,
    semester, // 设计报告 3.2.1：值「上/下」
    prefs: { questionCount: 30, difficultyMode: 'mixed', dailyLimitMin: 30 },
    createdAt: Date.now(),
  };
  repo.save('profiles', p);
  return p;
}
const p1 = createKid('小满', 2, '上');
const p2 = createKid('果果', 3, '下');
createKid('小星星', 1, '上');
if (repo.load('profiles').length !== 3) {
  console.error('FAIL 档案数量错误');
  process.exit(1);
}
if (createKid('第四个', 1, '上') !== null) {
  console.error('FAIL 上限拦截未生效');
  process.exit(1);
}
// 2) 编辑档案（Parent.saveKid 编辑分支）
const edited = { ...p1, nickname: '小满新', grade: 2, semester: '下' };
repo.save('profiles', edited);
if (repo.load('profiles', p1._id).semester !== '下') {
  console.error('FAIL 档案编辑未生效');
  process.exit(1);
}
// 3) prefs 偏好写回（Parent.patchPrefs：改动即保存）
function patchPrefs(pid, patch) {
  const p = repo.load('profiles', pid);
  repo.save('profiles', { ...p, prefs: { ...p.prefs, ...patch } });
}
// 默认题量步进（10~60 夹紧，Parent.changeAmount）
const stepAmount = (pid, delta) => {
  const p = repo.load('profiles', pid);
  const q = Math.min(60, Math.max(10, (p.prefs.questionCount ?? 30) + delta));
  patchPrefs(pid, { questionCount: q });
  return q;
};
if (stepAmount(p1._id, -5) !== 25 || stepAmount(p1._id, -40) !== 10 || stepAmount(p1._id, 500) !== 60) {
  console.error('FAIL 题量步进/夹紧错误');
  process.exit(1);
}
patchPrefs(p1._id, { difficultyMode: 'advance', autoWrongToBook: false, speechEnabled: false, dailyLimitMin: 40 });
const prefs = repo.load('profiles', p1._id).prefs;
if (prefs.difficultyMode !== 'advance' || prefs.autoWrongToBook !== false || prefs.dailyLimitMin !== 40) {
  console.error('FAIL prefs 写回错误', prefs);
  process.exit(1);
}
console.log('家长中心链路 OK：3 档案上限、编辑、prefs 写回（题量夹紧 10~60、难度/开关/护眼时长）');

// 4) 导出 → 导入往返（2.4 exportJson/importJson，FR-09 跨设备迁移）
// 先给 p1 造一条练习记录，让备份包含实体
achievement.record(
  {
    total: 5,
    correctCount: 4,
    accuracy: 0.8,
    durationSeconds: 90,
    wrongQuestions: [],
    detail: [
      { question: { id: 'q1', kpId: 'k1', expression: '1+1', answer: '2', difficulty: 'basic', source: 'normal', presentMode: 'direct' }, userAnswer: '2', correct: true },
      { question: { id: 'q2', kpId: 'k1', expression: '1+2', answer: '3', difficulty: 'basic', source: 'normal', presentMode: 'direct' }, userAnswer: '3', correct: true },
      { question: { id: 'q3', kpId: 'k1', expression: '2+2', answer: '4', difficulty: 'basic', source: 'normal', presentMode: 'direct' }, userAnswer: '4', correct: true },
      { question: { id: 'q4', kpId: 'k1', expression: '3+3', answer: '6', difficulty: 'basic', source: 'normal', presentMode: 'direct' }, userAnswer: '6', correct: true },
      { question: { id: 'q5', kpId: 'k1', expression: '4+4', answer: '8', difficulty: 'basic', source: 'normal', presentMode: 'direct' }, userAnswer: '0', correct: false },
    ],
  },
  p1._id
);
const json = repo.exportJson();
const target = new Repository(new MemoryStorage());
const out = target.importJson(json);
if (!out.ok || out.imported.profiles !== 3 || out.imported.practice_records !== 1) {
  console.error('FAIL 导入往返错误', out);
  process.exit(1);
}
// 合并写入：再次导入同一备份不重复
const out2 = target.importJson(json);
if (!out2.ok || target.load('profiles').length !== 3) {
  console.error('FAIL 重复导入未保持合并语义');
  process.exit(1);
}
// 非法文件
if (target.importJson('not json').ok !== false || target.importJson('{"app":"other"}').ok !== false) {
  console.error('FAIL 非法导入未拒绝');
  process.exit(1);
}
// 5) 删除 + 重建默认档案（Parent.doDelete → store.ensureProfile 同款）
target.clear();
if (target.load('profiles').length !== 0) {
  console.error('FAIL clear 未清空');
  process.exit(1);
}
const fresh = { _id: 'p_new', nickname: '小朋友', grade: 1, semester: '上', prefs: { questionCount: 30, difficultyMode: 'mixed', dailyLimitMin: 30 }, createdAt: Date.now() };
target.save('profiles', fresh);
console.log('数据管理链路 OK：导出/导入往返（合并语义）、非法文件拒绝、清空后重建默认档案');

// ============ P9 打卡日历链路 ============
// 6) 手动补签（2.4 M6 checkin(profileId, date)，Calendar.mend 复用）
const today = new Date();
const d = (offset) => {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
};
const pid = 'p_cal';
const out3 = achievement.checkin(pid, d(-2));
if (out3.date !== d(-2) || out3.streakDays !== 1) {
  console.error('FAIL 补签失败', out3);
  process.exit(1);
}
// 同一天重复补签去重
achievement.checkin(pid, d(-2));
const ach = repo.load('achievements', 'ach__' + pid);
if (ach.checkinDates.filter((x) => x === d(-2)).length !== 1) {
  console.error('FAIL 补签未去重');
  process.exit(1);
}
// 连续打卡：今天 + 昨天 + 前天 → 3 天，达成 streak_3 勋章
achievement.checkin(pid, d(-1));
const todayOut = achievement.checkin(pid, d(0));
if (todayOut.streakDays !== 3 || !todayOut.newBadges.some((b) => b.id === 'streak_3')) {
  console.error('FAIL 连续打卡/勋章错误', todayOut);
  process.exit(1);
}
// streakOf：从两天前数应为 3（断档于 d(-3)）
if (achievement.streakOf(ach.checkinDates, d(-2)) !== 1) {
  console.error('FAIL streakOf 断档计算错误');
  process.exit(1);
}
console.log('补签链路 OK：手动补签去重、连续 3 天自动达成「持之以恒」勋章、断档 streak 计算正确');

// 7) 月历单元格算法（Calendar.calCells 同款：周一开头、前后补齐）
function calCells(year, month, checkedSet, todayKey) {
  const first = new Date(year, month - 1, 1);
  const startWeek = (first.getDay() + 6) % 7; // 周一为 0
  const daysInMonth = new Date(year, month, 0).getDate();
  const prevDays = new Date(year, month - 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeek; i++) {
    cells.push({ day: prevDays - startWeek + i + 1, kind: 'other' });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const k = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    cells.push({ day, kind: checkedSet.has(k) ? 'checked' : 'normal', key: k, isToday: k === todayKey });
  }
  const tail = (7 - ((startWeek + daysInMonth) % 7)) % 7;
  for (let i = 1; i <= tail; i++) {
    cells.push({ day: i, kind: 'other' });
  }
  return cells;
}
// 2026-11-01 是周日 → startWeek=6（周一开头）；11 月 30 天 → 总 36 格 → 补 6 格
const cells = calCells(2026, 11, new Set(['2026-11-01', '2026-11-02']), '2026-11-02');
if (cells.length !== 42 || cells.length % 7 !== 0) {
  console.error('FAIL 月历行数错误', cells.length);
  process.exit(1);
}
if (cells[6].day !== 1 || cells[0].kind !== 'other') {
  console.error('FAIL 月历首格/开头偏移错误（应周一开头）', cells[0], cells[6]);
  process.exit(1);
}
const nov1 = cells[6];
const nov2 = cells[7];
if (nov1.kind !== 'checked' || nov2.isToday !== true || nov2.kind !== 'checked') {
  console.error('FAIL 打卡日/今日标记错误', nov1, nov2);
  process.exit(1);
}
console.log('月历算法 OK：2026-11（周日开头）→ 周一制偏移 6 格、42 格 6 行、打卡日与今日标记正确');

// 8) 最近 7 天汇总（Calendar.recentDays 同款口径）
const calRepo = new Repository(new MemoryStorage());
const calAch = new AchievementService(calRepo);
const calStats = new StatsService(calRepo, { now: () => new Date('2026-11-02T12:00:00').getTime() });
const cp = 'p_cal2';
calAch.checkin(cp, '2026-11-01');
const rec = {
  _id: 'pr_1',
  profileId: cp,
  date: '2026-11-01',
  paper: new Array(30).fill({ id: 'q', kpId: 'k', expression: '1+1', answer: '2', difficulty: 'basic', source: 'normal', presentMode: 'direct' }),
  answers: [],
  score: 28,
  accuracy: 0.93,
  durationSec: 365,
  wrongIds: ['q1', 'q2'],
  createdAt: new Date('2026-11-01T10:00:00').getTime(),
};
calRepo.save('practice_records', rec);
const keyOf = (y, m, dd) => `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
const now2 = new Date(2026, 10, 2); // 2026-11-02
const days = [];
for (let i = 6; i >= 0; i--) {
  const t = new Date(now2.getFullYear(), now2.getMonth(), now2.getDate() - i);
  const key = keyOf(t.getFullYear(), t.getMonth() + 1, t.getDate());
  const records = calStats.recordsOf(cp).filter((r) => (r.date || '') === key);
  let summary = null;
  if (records.length > 0) {
    const totalQ = records.reduce((s, r) => s + (r.paper?.length ?? 0), 0);
    const acc = records.reduce((s, r) => s + (r.accuracy ?? 0), 0) / records.length;
    const dur = records.reduce((s, r) => s + (r.durationSec ?? 0), 0);
    summary = { totalQ, accuracy: Math.round(acc * 100), durationSec: dur, rating: Math.round(acc * 5) };
  }
  days.push({ key, summary, checked: new Set(calAch.getOrCreate(cp).checkinDates).has(key) });
}
days.reverse(); // Calendar.recentDays 同款：最近在前
const day1101 = days[1]; // 11-01
if (!day1101.summary || day1101.summary.totalQ !== 30 || day1101.summary.accuracy !== 93 || day1101.summary.rating !== 5) {
  console.error('FAIL 最近 7 天汇总错误', day1101);
  process.exit(1);
}
const day1102 = days[0]; // 11-02（今天，无记录）
if (day1102.summary !== null) {
  console.error('FAIL 无记录日不应有汇总');
  process.exit(1);
}
console.log('最近 7 天汇总 OK：有练习日（30 题 / 93% / 5 星），无练习日为空');

// ============ FR-11 防沉迷落地（Setup 入口拦截 + Practice 练中检查） ============
// Setup.startPractice 同款拦截：今日已结算时长 ≥ prefs.dailyLimitMin 时阻止开新卷
function setupBlocked(usedSec, limitMin) {
  return limitMin > 0 && usedSec >= limitMin * 60;
}
if (setupBlocked(25 * 60, 30) !== false || setupBlocked(30 * 60, 30) !== true || setupBlocked(60 * 60, 0) !== false) {
  console.error('FAIL Setup 防沉迷拦截边界错误');
  process.exit(1);
}
// Practice.checkEyeLimit 同款：已结算 + 本次进行中 ≥ 上限时触发一次提醒
function eyeCheck(doneSec, curSec, limitMin, notified) {
  if (!limitMin || notified) {
    return false;
  }
  return doneSec + curSec >= limitMin * 60;
}
if (eyeCheck(1500, 299, 30, false) !== false || eyeCheck(1500, 300, 30, false) !== true || eyeCheck(1500, 300, 30, true) !== false) {
  console.error('FAIL Practice 护眼提醒边界/去重错误');
  process.exit(1);
}
console.log('FR-11 防沉迷 OK：Setup 入口拦截（达上限阻止开新卷）、Practice 练中提醒（触发一次不重复）');
console.log('D8+P9 冒烟全部通过');
