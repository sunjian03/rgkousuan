/**
 * achievement.test.js —— 激励服务 AchievementService 单元测试（3.3.6 延伸：M6 接口）
 * 覆盖 record 结算（星星/星级/勋章/练习记录落库/自动打卡）与 checkin（去重/
 * 连续天数/打卡勋章）。星星与勋章数值规则见 achievement.js 文件头（设计报告
 * 未定数值，按 FR-06/FR-10 自定）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AchievementService, BADGES } from '../src/core/achievement.js';
import { makeRepo, makeQuestion, makeSessionResult } from './helpers.js';

let NOW = new Date('2026-11-01T10:00:00').getTime();
const DAY = 86400000;
const mk = (repo) => new AchievementService(repo, { profileId: 'p1', now: () => NOW });
const advanceDay = (n) => { NOW += n * DAY; };

describe('AchievementService.record（2.4 M6 结算）', () => {
  test('星星：每答对 1 题 +1 星；星级 = round(正确率×5)', () => {
    const svc = mk(makeRepo());
    const r = svc.record(makeSessionResult({ correct: [makeQuestion('q1'), makeQuestion('q2')], wrong: [makeQuestion('q3')] }));
    assert.equal(r.starsEarned, 2);
    assert.equal(r.starsTotal, 2);
    assert.equal(r.rating, 3); // 2/3 ≈ 0.67 → 3 星
  });

  test('练习记录落库：字段对齐 3.2.1（score=答对题数、paper 快照、answers、wrongIds、date）', () => {
    const repo = makeRepo();
    const svc = mk(repo);
    const session = makeSessionResult({ correct: [makeQuestion('q1'), makeQuestion('q2')], wrong: [makeQuestion('q3')], durationSeconds: 45 });
    svc.record(session);
    const records = repo.load('practice_records');
    assert.equal(records.length, 1);
    const pr = records[0];
    assert.equal(pr.profileId, 'p1');
    assert.equal(pr.date, '2026-11-01');
    assert.equal(pr.paper.length, 3);
    assert.equal(pr.answers.length, 3);
    assert.equal(pr.score, 2, 'score 为答对题数（非百分制）');
    assert.ok(Math.abs(pr.accuracy - 2 / 3) < 1e-9);
    assert.equal(pr.durationSec, 45);
    assert.equal(pr.wrongIds.length, 1);
    assert.equal(pr.wrongIds[0], 'q3');
    assert.equal(pr.createdAt, NOW);
  });

  test('首次练习发「初次练习」勋章，且只发一次', () => {
    const repo = makeRepo();
    const svc = mk(repo);
    const r1 = svc.record(makeSessionResult({ correct: [makeQuestion('q1')] }));
    assert.ok(r1.newBadges.some((b) => b.id === 'first_practice'));
    const r2 = svc.record(makeSessionResult({ correct: [makeQuestion('q2')] }));
    assert.equal(r2.newBadges.filter((b) => b.id === 'first_practice').length, 0);
  });

  test('10 次满分发「满分达人」勋章（按 3.2.1 score=total 判定）', () => {
    const repo = makeRepo();
    const svc = mk(repo);
    for (let i = 0; i < 9; i++) {
      svc.record(makeSessionResult({ correct: [makeQuestion('q' + i)] }));
      NOW += 1000; // 每次练习时间戳递增（同毫秒会被随机后缀兜底，这里模拟真实间隔）
    }
    const r9 = svc.record(makeSessionResult({ correct: [makeQuestion('q9')] }));
    assert.ok(r9.newBadges.some((b) => b.id === 'perfect_10'));
  });

  test('巩固 10 道错题发「纠错小能手」勋章', () => {
    const repo = makeRepo();
    const svc = mk(repo);
    for (let i = 0; i < 10; i++) {
      repo.save('wrong_items', { _id: 'w' + i, profileId: 'p1', question: makeQuestion('wq' + i), kpId: 'g1a-add-carry-20', wrongCount: 1, correctStreak: 3, status: 'mastered', lastWrongAt: NOW, updatedAt: NOW });
    }
    const r = svc.record(makeSessionResult({ correct: [makeQuestion('q1')] }));
    assert.ok(r.newBadges.some((b) => b.id === 'master_10'));
  });

  test('空卷安全：不产生 NaN 星级', () => {
    const r = mk(makeRepo()).record(makeSessionResult({}));
    assert.equal(r.starsEarned, 0);
    assert.equal(r.rating, 0);
  });
});

describe('AchievementService.checkin（2.4 M6 打卡）', () => {
  test('首次打卡：记录日期、连续 1 天、无勋章', () => {
    const r = mk(makeRepo()).checkin('p1');
    assert.equal(r.date, '2026-11-01');
    assert.equal(r.streakDays, 1);
    assert.equal(r.newBadges.length, 0);
  });

  test('同日重复打卡去重，不重复发勋章', () => {
    const svc = mk(makeRepo());
    svc.checkin('p1');
    const again = svc.checkin('p1');
    assert.equal(again.streakDays, 1);
    assert.equal(again.newBadges.length, 0);
    const ach = svc.repo.load('achievements', svc.achId('p1'));
    assert.equal(ach.checkinDates.length, 1);
  });

  test('连续 3 天发「持之以恒」勋章，断签后重新计数', () => {
    const svc = mk(makeRepo());
    svc.checkin('p1');
    advanceDay(1);
    svc.checkin('p1');
    advanceDay(1);
    const r3 = svc.checkin('p1');
    assert.equal(r3.streakDays, 3);
    assert.ok(r3.newBadges.some((b) => b.id === 'streak_3'));
    advanceDay(2); // 跳过一天（断签）
    const broken = svc.checkin('p1');
    assert.equal(broken.streakDays, 1, '断签后连续天数重新从 1 计');
  });

  test('record 自动打卡当天（5.2 流程图：练习结束自动打卡更新）', () => {
    NOW = new Date('2026-11-01T10:00:00').getTime(); // 重置假时钟（模块级变量被前序用例推进过）
    const svc = mk(makeRepo());
    const r = svc.record(makeSessionResult({ correct: [makeQuestion('q1')] }));
    assert.equal(r.checkin.date, '2026-11-01');
    assert.equal(r.checkin.streakDays, 1);
    advanceDay(1);
    const r2 = svc.record(makeSessionResult({ correct: [makeQuestion('q2')] }));
    assert.equal(r2.checkin.streakDays, 2);
  });
});

describe('BADGES 勋章定义表', () => {
  test('6 项勋章定义完整（id/name/desc）', () => {
    assert.equal(Object.keys(BADGES).length, 6);
    for (const [id, b] of Object.entries(BADGES)) {
      assert.ok(id && b.name && b.desc, `勋章 ${id} 定义不完整`);
    }
  });
});

describe('AchievementService 构造约束', () => {
  test('缺 Repository 抛异常（编程错误，2.4 分层约定）', () => {
    assert.throws(() => new AchievementService(), /Repository/);
  });
});
