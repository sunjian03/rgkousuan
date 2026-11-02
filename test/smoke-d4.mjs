// 冒烟：模拟 D4 答题页 + D5 成绩页结算链路
// （分词渲染 + 双框输入拼接 + 判题 + 草稿续练 + 错题收录/巩固回写 + 记录落库）
import { generate, listKnowledgePoints } from '../src/core/generator.js';
import { PracticeSession, judge } from '../src/core/judge.js';
import { Repository, MemoryStorage } from '../src/core/repository.js';
import { WrongBook } from '../src/core/wrongbook.js';
import { AchievementService } from '../src/core/achievement.js';
import { StatsService } from '../src/core/stats.js';

const TOKEN_RE = /(\d+|dm|km|mm|cm|m|时|[+\-×÷()=]|\/|□)/g;

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const repo = new Repository(new MemoryStorage());
const kps = listKnowledgePoints();
let checked = 0;

for (const kp of kps) {
  const paper = generate({ kpId: kp.id, count: 30, difficultyMode: 'mixed', random: seeded(7) });
  if (!Array.isArray(paper) || paper.length < 20) {
    console.error('FAIL 出题不足', kp.id, paper.length);
    process.exit(1);
  }
  for (const q of paper) {
    // 1) 表达式分词必须无损还原
    const tokens = q.expression.match(TOKEN_RE) ?? [];
    if (tokens.join('') !== q.expression) {
      console.error('FAIL 分词丢失', kp.id, JSON.stringify(q.expression), tokens);
      process.exit(1);
    }
    // 2) 模拟双框输入拼接：按答案包含 余// 拆两部分，判题应正确
    const ans = String(q.presentMode === 'blank' ? q.blankAnswer : q.answer);
    const twoPart = ans.includes('余') || ans.includes('/');
    const userAnswer = twoPart ? ans.split(ans.includes('余') ? '余' : '/').join(ans.includes('余') ? '余' : '/') : ans;
    if (!judge(q, userAnswer)) {
      console.error('FAIL 判题不应错', kp.id, JSON.stringify(q.expression), ans);
      process.exit(1);
    }
    checked++;
  }
}
console.log(`分词+判题 OK：${kps.length} 个知识点 ${checked} 道题全部还原且可判对`);

// 3) 会话 + 草稿续练链路
const paper = generate({ kpId: 'g1a-add-sub-10', count: 10, difficultyMode: 'mixed', random: seeded(42) });
const pid = 'p_test';
repo.saveDraft(pid, { paper, answers: [], startedAt: 1000 });
const draft = repo.loadDraft(pid);

const session = new PracticeSession(draft.paper);
session.startedAt = draft.startedAt;
// 前 3 题重放
for (const a of draft.answers) session.submit(a.questionId, a.userAnswer);
let stars = 4;
const wrongOne = 2;
for (let i = 0; i < paper.length; i++) {
  const q = paper[i];
  if (i === wrongOne) {
    if (session.submit(q.id, '0').correct) { console.error('FAIL 错误答案被判对'); process.exit(1); }
  } else {
    const ans = String(q.presentMode === 'blank' ? q.blankAnswer : q.answer);
    if (!session.submit(q.id, ans).correct) { console.error('FAIL 正确答案被判错'); process.exit(1); }
    stars++;
  }
}
const result = session.finish();
if (result.total !== 10 || result.correctCount !== 9 || result.wrongQuestions.length !== 1) {
  console.error('FAIL 汇总错误', result);
  process.exit(1);
}
repo.clearDraft(pid);
console.log(`会话/草稿链路 OK：10 题 1 错 → 正确率 ${(result.accuracy * 100).toFixed(0)}%，错题 ${result.wrongQuestions.length} 道，得分 ${result.score}`);

// ============ D5 成绩页结算链路 ============
const wb = new WrongBook(repo, { profileId: pid });
const ach = new AchievementService(repo, { profileId: pid });
const stats2 = new StatsService(repo);
const stripW = (id) => (typeof id === 'string' && id.startsWith('w') ? id.slice(1) : id);

// 错题收录（'w' 前缀归一化 → 主键 pid__questionId）
const wrongQ = result.wrongQuestions[0];
wb.add({ wrongQuestions: [{ ...wrongQ, question: { ...wrongQ.question, id: stripW(wrongQ.question.id) } }] }, pid);
// 答对的题回写巩固
for (const d of result.detail) {
  if (d.answered && d.correct) wb.updateStreak(stripW(d.question.id), true, pid);
}
// 再次答错同一道 'w' 错题 → 应更新原条目而非重复收录
wb.add({ wrongQuestions: [{ ...wrongQ, question: { ...wrongQ.question, id: stripW(wrongQ.question.id) } }] }, pid);
const items = wb.review({ profileId: pid });
if (items.length !== 1 || items[0].wrongCount !== 2) {
  console.error('FAIL 错题重复收录或计数错误', items);
  process.exit(1);
}
console.log('错题收录/归一化 OK：重复答错累加 wrongCount=2，错题本仅 1 条');

// 练习记录落库 + 打卡 + 星星
const reward = ach.record(result, pid);
const records = stats2.recordsOf(pid);
if (records.length !== 1 || records[0].score !== 9 || records[0].accuracy !== 0.9) {
  console.error('FAIL 练习记录错误', records);
  process.exit(1);
}
const achEntity = repo.load('achievements', 'ach__' + pid);
if (reward.starsEarned !== 9 || achEntity.checkinDates.length !== 1) {
  console.error('FAIL 星星/打卡错误', reward, achEntity);
  process.exit(1);
}
// 近 3 次快照
repo.saveRecentPapers(pid, paper);
if (repo.getRecentPapers(pid).length !== 1) {
  console.error('FAIL 快照未保存');
  process.exit(1);
}
// 日报告可见今日记录
const day = stats2.getReport(pid, 'day');
if (day.summary.practiceCount !== 1) {
  console.error('FAIL 日报告错误', day.summary);
  process.exit(1);
}
console.log(`结算链路 OK：记录落库(score=${records[0].score})、星星+${reward.starsEarned}、打卡 ${achEntity.checkinDates[0]}、快照/日报告正常`);

// ============ D6 错题本链路 ============
// 重练卷（buildReviewPaper 输出题目快照，id 为原题号，updateStreak 可直接回写）
const reviewPaper = wb.buildReviewPaper(10, pid);
if (reviewPaper.length !== 1 || reviewPaper[0].source !== 'wrong') {
  console.error('FAIL 重练卷错误', reviewPaper);
  process.exit(1);
}
// 连续答对 3 次 → 巩固（3.3.4 active --> mastered）
const qid = reviewPaper[0].id;
if (wb.updateStreak(qid, true, pid).status !== 'active') {
  console.error('FAIL 第 1 次答对不应巩固');
  process.exit(1);
}
wb.updateStreak(qid, true, pid);
if (wb.updateStreak(qid, true, pid).status !== 'mastered') {
  console.error('FAIL 连续答对 3 次未巩固');
  process.exit(1);
}
if (wb.review({ profileId: pid }).length !== 0) {
  console.error('FAIL 已巩固错题仍在待重练列表');
  process.exit(1);
}
// 再次答错 → 重新收录（mastered --> active）
wb.add({ wrongQuestions: [{ ...wrongQ, question: { ...wrongQ.question, id: stripW(wrongQ.question.id) } }] }, pid);
if (wb.review({ profileId: pid }).length !== 1) {
  console.error('FAIL 巩固后再错未重新收录');
  process.exit(1);
}
// 时间筛选：今天（lastWrongAt=现在）应命中，昨天区间应为空
const todayHit = wb.review({ profileId: pid, dateRange: { from: Date.now() - 3600_000, to: Date.now() } });
const oldHit = wb.review({ profileId: pid, dateRange: { from: 0, to: Date.now() - 86400_000 } });
if (todayHit.length !== 1 || oldHit.length !== 0) {
  console.error('FAIL 时间筛选错误', todayHit, oldHit);
  process.exit(1);
}
console.log('错题本链路 OK：重练卷巩固（3 连对 → mastered）→ 再错重收录 → dateRange 筛选正常');
console.log('D4+D5+D6 冒烟全部通过');
