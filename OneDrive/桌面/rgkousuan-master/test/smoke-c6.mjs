/**
 * C6 冒烟测试：Repository 数据仓库（内存后端 + localStorage 契约）
 * 覆盖：save/load upsert、类型白名单、近 3 次快照滚动、草稿、
 * 导出/导入（往返一致/坏包/合并/跳过脏数据）、损坏容错、
 * 与 C5 三服务的真实集成（真 Repository 替换假 Repository）。
 */
import { generate } from '../src/core/generator.js';
import { PracticeSession } from '../src/core/judge.js';
import { WrongBook } from '../src/core/wrongbook.js';
import { StatsService } from '../src/core/stats.js';
import { AchievementService } from '../src/core/achievement.js';
import { Repository, MemoryStorage, ENTITY_TYPES } from '../src/core/repository.js';

const errors = [];
function assert(cond, msg) {
  if (!cond) {
    errors.push(msg);
    console.log('  ✗ ' + msg);
  } else {
    console.log('  ✓ ' + msg);
  }
}
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const repo = new Repository(new MemoryStorage(), { now: () => 1700000000000 });

// ---- 1. save / load 基本契约 ----
repo.save('profiles', { _id: 'p1', nickname: '豆豆', grade: 1, semester: '上', prefs: { questionCount: 30, difficultyMode: 'mixed', dailyLimitMin: 30 }, createdAt: 1 });
repo.save('profiles', { _id: 'p2', nickname: '苗苗', grade: 2, semester: '下', prefs: {}, createdAt: 2 });
assert(repo.load('profiles').length === 2, 'load 省略 id → 全部实体数组');
assert(repo.load('profiles', 'p1').nickname === '豆豆', 'load(id) → 单实体');
assert(repo.load('profiles', 'nope') === null, 'load 不存在 id → null');
repo.save('profiles', { _id: 'p1', nickname: '豆豆改', grade: 1, semester: '上', prefs: {}, createdAt: 1 });
assert(repo.load('profiles').length === 2 && repo.load('profiles', 'p1').nickname === '豆豆改', '同 _id 重复 save → upsert 覆盖');

// ---- 2. 白名单与主键校验（编程错误抛异常） ----
let threw = false;
try { repo.save('nonsense', { _id: 'x' }); } catch { threw = true; }
assert(threw, '非法 type → 抛异常');
threw = false;
try { repo.save('profiles', { nickname: '无主键' }); } catch { threw = true; }
assert(threw, '缺 _id 主键 → 抛异常');

// ---- 3. 与 C5 三服务集成（真 Repository 替换冒烟 C5 的假仓库） ----
const rng = seeded(42);
const nowFn = () => 1700000000000;
const paper = generate({ kpId: 'g1a-add-carry-20', count: 4, difficultyMode: 'mixed', random: rng });
const session = new PracticeSession(paper, { now: nowFn });
session.submit(paper[0].id, paper[0].answer);
session.submit(paper[1].id, paper[1].answer);
session.submit(paper[2].id, '0'); // 错
session.submit(paper[3].id, '');  // 错
const result = session.finish();
const wb = new WrongBook(repo, { now: nowFn });
assert(wb.add(result, 'p1').length === 2, 'WrongBook.add 用真 Repository 入库 2 条');
wb.updateStreak(paper[2].id, true, 'p1');
wb.updateStreak(paper[2].id, true, 'p1');
wb.updateStreak(paper[2].id, true, 'p1');
assert(wb.review({ profileId: 'p1' }).length === 1, 'updateStreak 3 连对 → mastered 移出');
const ach = new AchievementService(repo, { now: nowFn });
const reward = ach.record(result, 'p1');
assert(reward.starsEarned === 2 && reward.newBadges.some((b) => b.id === 'first_practice'), 'achievement.record 用真 Repository 结算');
const stats = new StatsService(repo, { now: nowFn });
assert(stats.getReport('p1', 'day').summary.practiceCount === 1, 'stats.getReport 用真 Repository 读到 1 条记录');
assert(Math.abs(stats.getMastery('p1', 'g1a-add-carry-20') - 2 / 4) < 1e-9, '掌握度 2/4（真 Repository 数据）');

// ---- 4. 近 3 次快照（R2 滚动队列） ----
repo.saveRecentPapers('p1', ['1+1', '2+2']);
repo.saveRecentPapers('p1', ['3+3']);
repo.saveRecentPapers('p1', ['4+4']);
repo.saveRecentPapers('p1', ['5+5']);
const recents = repo.getRecentPapers('p1');
assert(recents.length === 3 && recents[0][0] === '3+3' && recents[2][0] === '5+5', '超 3 次滚动丢弃最旧快照');
const dedupPaper = generate({
  kpId: 'g1a-add-carry-20', count: 5, difficultyMode: 'mixed',
  recentPapers: repo.getRecentPapers('p1'), random: rng,
});
assert(Array.isArray(dedupPaper), 'getRecentPapers 直接喂给 generate 去重可用');

// ---- 5. 练习草稿（NFR-06） ----
assert(repo.loadDraft('p1') === null, '无草稿 → null');
repo.saveDraft('p1', { paper: dedupPaper, answers: [{ qid: 'q1', userAnswer: '3' }], startedAt: 1 });
const draft = repo.loadDraft('p1');
assert(draft.paper.length === 5 && draft.answers.length === 1 && draft.savedAt === 1700000000000, '草稿保存/恢复');
repo.clearDraft('p1');
assert(repo.loadDraft('p1') === null, 'clearDraft 清除');

// ---- 6. 导出 / 导入 ----
const backup = repo.exportJson();
const parsed = JSON.parse(backup);
assert(parsed.app === 'rgkousuan' && parsed.schemaVersion === 1, '备份包标识与版本');
assert(parsed.data.profiles.length === 2 && parsed.data.practice_records.length === 1, '备份含 4 类实体（档案 2 / 记录 1）');
assert(parsed.data.wrong_items.length === 2 && parsed.data.achievements.length === 1, '备份含错题 2 / 成就 1');
assert(!('recent_papers' in parsed.data), '缓存不入备份（3.4 仅存本地）');

// 目标设备（空仓库）导入 → 完整恢复
const repo2 = new Repository(new MemoryStorage(), { now: () => 1700000000001 });
const r = repo2.importJson(backup);
assert(r.ok && r.imported.profiles === 2 && r.imported.practice_records === 1, '新设备导入完整恢复');
assert(JSON.stringify(repo2.load('wrong_items')) === JSON.stringify(repo.load('wrong_items')), '导入后错题与源一致');
assert(repo2.load('achievements', 'ach__p1').stars === 2, '成就实体恢复');

// 合并：目标已有 p1 与 p3 → 导入不覆盖、按 _id 合并
const r2 = repo2.importJson(backup);
assert(r2.ok && repo2.load('profiles').length === 2, '重复导入幂等（同 _id upsert）');
repo2.save('profiles', { _id: 'p9', nickname: '本地孩子', grade: 3, semester: '上', prefs: {}, createdAt: 3 });
repo2.importJson(backup);
assert(repo2.load('profiles').length === 3, '导入合并保留本地数据（3 档案）');

// 坏包与脏数据
assert(repo2.importJson('这不是JSON{{{').ok === false, '非 JSON → {ok:false}');
assert(repo2.importJson('{"app":"other"}').ok === false, 'app 不匹配 → {ok:false}');
assert(repo2.importJson('{"app":"rgkousuan","schemaVersion":99,"data":{}}').ok === false, '版本过高 → {ok:false}');
const dirty = JSON.parse(backup);
dirty.data.profiles.push({ nickname: '无主键脏数据' });
const r3 = repo2.importJson(JSON.stringify(dirty));
assert(r3.ok && r3.skipped === 1 && repo2.load('profiles').length === 3, '脏实体跳过计数，其余正常导入');

// ---- 7. 损坏容错（NFR-06 不中断练习） ----
const storage3 = new MemoryStorage();
storage3.setItem('ksl_profiles', '{{{broken');
const repo3 = new Repository(storage3);
assert(repo3.load('profiles').length === 0, '损坏数据按空集合处理，不抛异常');
repo3.save('profiles', { _id: 'p1', nickname: '恢复写入', grade: 1, semester: '上', prefs: {}, createdAt: 1 });
assert(repo3.load('profiles', 'p1').nickname === '恢复写入', '损坏后可正常写入恢复');

// ---- 8. clear：一键删除 / 记录级清除（FR-09） ----
repo.clear('profiles');
assert(repo.load('profiles').length === 0 && repo.load('practice_records').length === 1, 'clear(type) 记录级清除');
repo.clear();
assert(ENTITY_TYPES.every((t) => repo.load(t).length === 0), 'clear() 一键清空全部实体');

console.log(errors.length === 0 ? '\n全部通过 ✓' : `\n失败 ${errors.length} 项 ✗`);
process.exit(errors.length === 0 ? 0 : 1);
