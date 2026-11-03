/**
 * C5 冒烟测试：wrongbook / stats / achievement 三服务（内存假 Repository）
 * 覆盖：3.3.4 状态机全路径、review 过滤、R4 重练卷排序、
 * 3.3.5 报告/掌握度、record 结算 + 打卡 + 勋章。
 */
import { generate } from '../src/core/generator.js';
import { PracticeSession } from '../src/core/judge.js';
import { WrongBook } from '../src/core/wrongbook.js';
import { StatsService } from '../src/core/stats.js';
import { AchievementService, BADGES } from '../src/core/achievement.js';

// ---- 内存假 Repository（C6 契约预览：save/load，load(type) 省略 id 返回集合）----
function makeRepo() {
  const store = new Map(); // type__id → entity
  return {
    save(type, entity) {
      store.set(type + '__' + entity._id, entity);
    },
    load(type, id) {
      if (id != null) {
        return store.get(type + '__' + id) ?? null;
      }
      return [...store.entries()]
        .filter(([k]) => k.startsWith(type + '__'))
        .map(([, v]) => v);
    },
    _store: store,
  };
}

const errors = [];
function assert(cond, msg) {
  if (!cond) {
    errors.push(msg);
    console.log('  ✗ ' + msg);
  } else {
    console.log('  ✓ ' + msg);
  }
}

let fakeNow = new Date('2026-11-01T10:00:00').getTime();
const nowFn = () => fakeNow;

// 种子随机数（LCG）：固定 random 会让约束生成永远同一候选而失败，用伪随机保证可复现
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rng = seeded(20261101);

// ---- 1. 生成 5 题练习卷，前 3 对后 2 错 ----
const paper = generate({ kpId: 'g1a-add-carry-20', count: 5, difficultyMode: 'mixed', random: rng });
assert(paper.length === 5, '出卷 5 题');
const session = new PracticeSession(paper, { now: nowFn });
const q0 = paper[0], q1 = paper[1], q2 = paper[2], q3 = paper[3], q4 = paper[4];
assert(session.submit(q0.id, q0.answer).correct, 'q0 答对');
assert(session.submit(q1.id, q1.answer).correct, 'q1 答对');
assert(session.submit(q2.id, q2.answer).correct, 'q2 答对');
assert(!session.submit(q3.id, '999').correct, 'q3 答错');
assert(!session.submit(q4.id, '').correct, 'q4 空输入答错');
const result = session.finish();
assert(result.correctCount === 3 && result.wrongQuestions.length === 2, 'finish：3 对 2 错');

// ---- 2. WrongBook.add：错题入库 ----
const repo = makeRepo();
const wb = new WrongBook(repo, { now: nowFn });
const added = wb.add(result, 'p1');
assert(added.length === 2, 'add 入库 2 条错题');
assert(added.every((i) => i.status === 'active' && i.wrongCount === 1 && i.correctStreak === 0), '新错题 active/wrongCount=1/streak=0');
assert(wb.review({ profileId: 'p1' }).length === 2, 'review 默认列出 2 条 active');

// ---- 3. updateStreak：active→active（再错） ----
fakeNow += 60000;
const againWrong = wb.updateStreak(q3.id, false, 'p1');
assert(againWrong.wrongCount === 2 && againWrong.correctStreak === 0 && againWrong.status === 'active', '再错：wrongCount+1、streak 清零、保持 active');

// ---- 4. active→mastered（连续答对 3 次） ----
wb.updateStreak(q3.id, true, 'p1');
wb.updateStreak(q3.id, true, 'p1');
const mastered = wb.updateStreak(q3.id, true, 'p1');
assert(mastered.status === 'mastered' && mastered.correctStreak === 3, '连续答对 3 次 → mastered');
assert(wb.review({ profileId: 'p1' }).length === 1, 'mastered 移出错题本（默认列表剩 1 条）');
assert(wb.review({ profileId: 'p1', status: 'all' }).length === 2, 'status=all 可见全部');

// ---- 5. mastered→active（后续再错重新收录） ----
wb.add({ wrongQuestions: [{ question: q3 }] }, 'p1');
const recollected = wb.repo.load('wrong_items', wb.itemId('p1', q3.id));
assert(recollected.status === 'active' && recollected.wrongCount === 3, 'mastered 再错 → 重新收录 active，wrongCount=3');

// ---- 6. R4 重练卷：active 错题按 wrongCount 倒序 ----
const reviewPaper = wb.buildReviewPaper(2, 'p1');
assert(reviewPaper.length === 2 && reviewPaper.every((q) => q.source === 'wrong'), '重练卷 2 题，source=wrong');
assert(reviewPaper[0].id === q3.id, '重练卷最易错（wrongCount 最大）在前');

// ---- 7. review 过滤：kpId / dateRange ----
assert(wb.review({ profileId: 'p1', kpId: 'g1a-add-carry-20' }).length === 2, 'kpId 过滤');
assert(
  wb.review({ profileId: 'p1', dateRange: { from: fakeNow + 1 } }).length === 0,
  'dateRange 过滤（之后无错题）'
);

// ---- 8. AchievementService.record：结算 + 落库 + 打卡 ----
const ach = new AchievementService(repo, { now: nowFn });
const reward = ach.record(result, 'p1');
assert(reward.starsEarned === 3 && reward.starsTotal === 3, '每答对 1 题 +1 星（共 3 星）');
assert(reward.rating === 3, '星级 = round(0.6×5) = 3');
assert(reward.checkin.date === '2026-11-01' && reward.checkin.streakDays === 1, 'record 自动打卡第 1 天');
assert(reward.newBadges.some((b) => b.id === 'first_practice'), '首次练习发「初次练习」勋章');
const records = repo.load('practice_records');
assert(records.length === 1, 'record 落库练习记录');
const pr = records[0];
assert(
  pr.score === 3 && pr.accuracy === 0.6 && pr.paper.length === 5 &&
    pr.answers.length === 5 && pr.wrongIds.length === 2 && pr.date === '2026-11-01',
  '练习记录字段对齐 3.2.1（score=答对题数、paper 快照、answers、wrongIds、date）'
);

// ---- 9. StatsService：报告与掌握度 ----
const stats = new StatsService(repo, { now: nowFn });
const day = stats.getReport('p1', 'day');
assert(day.summary.practiceCount === 1 && Math.abs(day.summary.avgAccuracy - 0.6) < 1e-9, '日报告：1 次练习、正确率 0.6');
assert(day.summary.wrongCount === 2 && day.summary.totalDurationSec === result.durationSeconds, '日报告：错题 2、用时一致');
assert(day.trend.length === 1, '日报告趋势 1 个点');
const week = stats.getReport('p1', 'week');
assert(week.trend.length === 7 && week.trend[6].practiceCount === 1, '周报告 7 天连续趋势，今天 1 次');
const month = stats.getReport('p1', 'month');
assert(month.trend.length === 30, '月报告 30 天趋势');
assert(stats.getReport('p1', 'year').ok === false, '非法 period 返回 {ok:false}');
const mastery = stats.getMastery('p1', 'g1a-add-carry-20');
assert(Math.abs(mastery - 3 / 5) < 1e-9, '掌握度 = 3/5（近 10 次答对/出现）');
assert(stats.getMastery('p1', 'g1b-sub-borrow-20') === null, '未练习知识点 → null');
assert(stats.getMastery('p2', 'g1a-add-carry-20') === null, '其他档案 → null');

// ---- 10. 打卡：连续 3 天 → streak_3 勋章；重复打卡去重 ----
fakeNow = new Date('2026-11-02T09:00:00').getTime();
const paper2 = generate({ kpId: 'g1a-add-carry-20', count: 2, difficultyMode: 'mixed', random: rng });
const session2 = new PracticeSession(paper2, { now: nowFn });
session2.submit(paper2[0].id, paper2[0].answer);
session2.submit(paper2[1].id, paper2[1].answer);
const r2 = ach.record(session2.finish(), 'p1');
assert(r2.checkin.streakDays === 2, '第二天打卡 streak=2');
fakeNow = new Date('2026-11-03T09:00:00').getTime();
const r3 = ach.checkin('p1');
assert(r3.streakDays === 3 && r3.newBadges.some((b) => b.id === 'streak_3'), '连续 3 天 → streak_3 勋章');
const r3again = ach.checkin('p1');
assert(r3again.streakDays === 3 && r3again.newBadges.length === 0, '同日重复打卡：去重且不重复发勋章');
const achEntity = repo.load('achievements', ach.achId('p1'));
assert(achEntity.checkinDates.length === 3, 'checkinDates 共 3 天');
assert(achEntity.stars === 5, '星星累计 3+2=5');

// ---- 11. BADGES 表完整 ----
assert(Object.keys(BADGES).length === 6, '勋章定义表 6 项');

console.log(errors.length === 0 ? '\n全部通过 ✓' : `\n失败 ${errors.length} 项 ✗`);
process.exit(errors.length === 0 ? 0 : 1);
