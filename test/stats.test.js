/**
 * stats.test.js —— 统计服务 StatsService 单元测试（设计报告 3.3.5，M4 接口）
 * 覆盖日/周/月报告聚合与「近 10 次答对/出现」知识点掌握度。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StatsService } from '../src/core/stats.js';
import { makeRepo, makeQuestion } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00').getTime();
const DAY = 86400000;
const mk = (repo) => new StatsService(repo, { now: () => NOW });

/** 造一条练习记录（3.2.1 practice_records） */
function makeRecord(repo, { id, profileId = 'p1', dateOffsetDays = 0, correct = 1, total = 2, durationSec = 100, kpId = 'g1a-add-carry-20' }) {
  const paper = Array.from({ length: total }, (_, i) => makeQuestion(id + 'q' + i, kpId));
  const answers = paper.map((q, i) => ({ qid: q.id, userAnswer: String(q.answer), correct: i < correct }));
  const createdAt = NOW - dateOffsetDays * DAY;
  repo.save('practice_records', {
    _id: id,
    profileId,
    date: StatsService.fmtDate(createdAt),
    paper,
    answers,
    score: correct,
    accuracy: correct / total,
    durationSec,
    wrongIds: paper.slice(correct).map((q) => q.id),
    createdAt,
  });
}

describe('StatsService.getReport（3.3.5 日/周/月报告）', () => {
  test('日报告：当日练习次数、平均正确率、总用时、错题数', () => {
    const repo = makeRepo();
    makeRecord(repo, { id: 'r1', correct: 3, total: 5, durationSec: 120 }); // 今天
    makeRecord(repo, { id: 'r2', dateOffsetDays: 1, correct: 5, total: 5, durationSec: 80 }); // 昨天
    const r = new StatsService(repo, { now: () => NOW }).getReport('p1', 'day');
    assert.equal(r.period, 'day');
    assert.equal(r.summary.practiceCount, 1);
    assert.equal(r.summary.avgAccuracy, 0.6);
    assert.equal(r.summary.totalDurationSec, 120);
    assert.equal(r.summary.wrongCount, 2);
    assert.equal(r.trend.length, 1);
    assert.equal(r.trend[0].date, '2026-11-15');
  });

  test('周报告：7 天连续趋势（无练习日补 0），正确率与用时双序列齐备', () => {
    const repo = makeRepo();
    makeRecord(repo, { id: 'r1' }); // 今天
    makeRecord(repo, { id: 'r2', dateOffsetDays: 3, correct: 2, total: 2 }); // 3 天前
    const r = mk(repo).getReport('p1', 'week');
    assert.equal(r.trend.length, 7);
    assert.equal(r.summary.practiceCount, 2);
    assert.equal(r.trend[6].practiceCount, 1, '今天 1 次');
    assert.equal(r.trend[3].practiceCount, 1, '3 天前 1 次');
    assert.equal(r.trend[2].practiceCount, 0, '无练习日补 0');
    assert.ok(r.trend.every((d) => 'avgAccuracy' in d && 'totalDurationSec' in d), '趋势点含正确率与用时（图表双序列）');
  });

  test('月报告：30 天趋势与区间汇总', () => {
    const repo = makeRepo();
    makeRecord(repo, { id: 'r1' });
    makeRecord(repo, { id: 'r2', dateOffsetDays: 20 });
    const r = mk(repo).getReport('p1', 'month');
    assert.equal(r.trend.length, 30);
    assert.equal(r.summary.practiceCount, 2);
  });

  test('区间外记录不计入（周报告只看最近 7 天）', () => {
    const repo = makeRepo();
    makeRecord(repo, { id: 'r1', dateOffsetDays: 8 }); // 8 天前，出周窗口
    const r = mk(repo).getReport('p1', 'week');
    assert.equal(r.summary.practiceCount, 0);
    assert.equal(r.summary.avgAccuracy, 0);
  });

  test('多档案隔离：只统计指定 profileId 的记录', () => {
    const repo = makeRepo();
    makeRecord(repo, { id: 'r1', profileId: 'p1' });
    makeRecord(repo, { id: 'r2', profileId: 'p2' });
    assert.equal(mk(repo).getReport('p1', 'day').summary.practiceCount, 1);
    assert.equal(mk(repo).getReport('p2', 'day').summary.practiceCount, 1);
    assert.equal(mk(repo).getReport('p3', 'day').summary.practiceCount, 0);
  });

  test('非法 period 返回 {ok:false, message}（2.4 约定第 4 条）', () => {
    const r = mk(makeRepo()).getReport('p1', 'year');
    assert.equal(r.ok, false);
  });
});

describe('StatsService.getMastery（3.3.5 知识点掌握度）', () => {
  test('掌握度 = 近 10 次答对 / 近 10 次出现', () => {
    const repo = makeRepo();
    // 2 道题全对（今天的记录，正确率 1）
    makeRecord(repo, { id: 'r1', correct: 2, total: 2 });
    // 3 天前 3 道题对 2
    makeRecord(repo, { id: 'r2', dateOffsetDays: 3, correct: 2, total: 3 });
    const m = mk(repo).getMastery('p1', 'g1a-add-carry-20');
    assert.equal(m, 4 / 5);
  });

  test('超过 10 次只取最近 10 次出现', () => {
    const repo = makeRepo();
    // 旧记录（20 天前）：1 题答错
    makeRecord(repo, { id: 'old', dateOffsetDays: 20, correct: 0, total: 1 });
    // 新记录：10 题全对
    makeRecord(repo, { id: 'new', correct: 10, total: 10 });
    const m = mk(repo).getMastery('p1', 'g1a-add-carry-20');
    assert.equal(m, 1, '旧答错被挤出窗口，掌握度为 1');
  });

  test('混合知识点记录：只统计目标 kpId 的出现', () => {
    const repo = makeRepo();
    makeRecord(repo, { id: 'r1', correct: 1, total: 2, kpId: 'g1a-add-carry-20' });
    makeRecord(repo, { id: 'r2', correct: 2, total: 2, kpId: 'g1b-sub-borrow-20' });
    assert.equal(mk(repo).getMastery('p1', 'g1a-add-carry-20'), 0.5);
    assert.equal(mk(repo).getMastery('p1', 'g1b-sub-borrow-20'), 1);
  });

  test('无样本返回 null（页面显示「未练习」）', () => {
    const repo = makeRepo();
    makeRecord(repo, { id: 'r1', kpId: 'g1b-sub-borrow-20' });
    assert.equal(mk(repo).getMastery('p1', 'g1a-add-carry-20'), null);
    assert.equal(mk(repo).getMastery('p2', 'g1a-add-carry-20'), null);
  });
});
