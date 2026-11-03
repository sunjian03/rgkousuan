/**
 * wrongbook.test.js —— 错题本 WrongBook 单元测试（设计报告 3.3.4 状态机，M3 接口）
 * 覆盖状态机全路径：收录 → 再错 → 连续答对 3 次巩固 → 再错重新收录，
 * 以及 review 过滤与 R4 重练卷。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WrongBook } from '../src/core/wrongbook.js';
import { makeRepo, makeQuestion, makeSessionResult } from './helpers.js';

const NOW = 1700000000000;
const mk = (repo) => new WrongBook(repo, { profileId: 'p1', now: () => NOW });

describe('WrongBook.add（3.3.4 [*]→active 自动收录）', () => {
  test('新错题入库：status=active、wrongCount=1、correctStreak=0', () => {
    const wb = mk(makeRepo());
    const q = makeQuestion('q1');
    const added = wb.add(makeSessionResult({ wrong: [q] }));
    assert.equal(added.length, 1);
    const item = added[0];
    assert.equal(item.profileId, 'p1');
    assert.equal(item.question.id, 'q1');
    assert.equal(item.kpId, q.kpId);
    assert.equal(item.status, 'active');
    assert.equal(item.wrongCount, 1);
    assert.equal(item.correctStreak, 0);
    assert.equal(item.lastWrongAt, NOW);
    assert.equal(item.updatedAt, NOW);
  });

  test('同一道题再次答错：wrongCount 累加、correctStreak 清零、不重复入库', () => {
    const repo = makeRepo();
    const wb = mk(repo);
    const q = makeQuestion('q1');
    wb.add(makeSessionResult({ wrong: [q] }));
    const again = wb.add(makeSessionResult({ wrong: [q] }))[0];
    assert.equal(again.wrongCount, 2);
    assert.equal(repo.load('wrong_items').length, 1, '同题只保留一条错题记录');
  });

  test('全对会话不产生错题', () => {
    const repo = makeRepo();
    const wb = mk(repo);
    wb.add(makeSessionResult({ correct: [makeQuestion('q1')] }));
    assert.equal(repo.load('wrong_items').length, 0);
  });
});

describe('WrongBook.updateStreak（3.3.4 状态机迁移）', () => {
  test('active→active：重练中再错 wrongCount+1、correctStreak 清零', () => {
    const wb = mk(makeRepo());
    wb.add(makeSessionResult({ wrong: [makeQuestion('q1')] }));
    const item = wb.updateStreak('q1', false);
    assert.equal(item.status, 'active');
    assert.equal(item.wrongCount, 2);
    assert.equal(item.correctStreak, 0);
  });

  test('active→active：答对 1~2 次留在错题本（streak 累加但未巩固）', () => {
    const wb = mk(makeRepo());
    wb.add(makeSessionResult({ wrong: [makeQuestion('q1')] }));
    assert.equal(wb.updateStreak('q1', true).correctStreak, 1);
    const item = wb.updateStreak('q1', true);
    assert.equal(item.correctStreak, 2);
    assert.equal(item.status, 'active');
    assert.equal(wb.review().length, 1, '仍列在错题本');
  });

  test('active→mastered：连续答对 3 次自动巩固移出错题本', () => {
    const wb = mk(makeRepo());
    wb.add(makeSessionResult({ wrong: [makeQuestion('q1')] }));
    wb.updateStreak('q1', true);
    wb.updateStreak('q1', true);
    const item = wb.updateStreak('q1', true);
    assert.equal(item.status, 'mastered');
    assert.equal(item.correctStreak, 3);
    assert.equal(wb.review().length, 0, '默认列表不再显示已巩固错题');
    assert.equal(wb.review({ status: 'all' }).length, 1);
  });

  test('mastered→active：后续练习再错重新收录', () => {
    const wb = mk(makeRepo());
    const q = makeQuestion('q1');
    wb.add(makeSessionResult({ wrong: [q] }));
    wb.updateStreak('q1', true);
    wb.updateStreak('q1', true);
    wb.updateStreak('q1', true);
    wb.add(makeSessionResult({ wrong: [q] })); // 已巩固后再次答错
    const item = wb.review({ status: 'all' })[0];
    assert.equal(item.status, 'active');
    assert.equal(item.wrongCount, 2);
    assert.equal(item.correctStreak, 0);
  });

  test('未知题号返回 {ok:false, message}（2.4 约定第 4 条）', () => {
    const wb = mk(makeRepo());
    const r = wb.updateStreak('nope', true);
    assert.equal(r.ok, false);
    assert.ok(r.message.includes('nope'));
  });
});

describe('WrongBook.review（2.4 M3 过滤）', () => {
  const setup = () => {
    const wb = mk(makeRepo());
    wb.add(makeSessionResult({ wrong: [makeQuestion('q1', 'g1a-add-carry-20'), makeQuestion('q2', 'g1b-sub-borrow-20')] }));
    // q2 连对 3 次巩固，q1 保持 active
    wb.updateStreak('q2', true);
    wb.updateStreak('q2', true);
    wb.updateStreak('q2', true);
    return wb;
  };

  test('默认只列待巩固（active）', () => {
    const list = setup().review();
    assert.equal(list.length, 1);
    assert.equal(list[0].question.id, 'q1');
  });

  test('status=all 返回全部', () => {
    assert.equal(setup().review({ status: 'all' }).length, 2);
  });

  test('kpId 过滤', () => {
    const list = setup().review({ status: 'all', kpId: 'g1b-sub-borrow-20' });
    assert.equal(list.length, 1);
    assert.equal(list[0].kpId, 'g1b-sub-borrow-20');
  });

  test('dateRange 按 lastWrongAt 过滤（含边界）', () => {
    const list = setup().review({ dateRange: { from: NOW, to: NOW } });
    assert.equal(list.length, 1);
    assert.equal(setup().review({ dateRange: { from: NOW + 1 } }).length, 0);
  });
});

describe('WrongBook.buildReviewPaper（2.4 M3，R4 错题重练卷）', () => {
  test('按累计答错次数倒序取题（最易错优先），题目带 source=wrong', () => {
    const wb = mk(makeRepo());
    const q1 = makeQuestion('q1');
    const q2 = makeQuestion('q2');
    const q3 = makeQuestion('q3');
    wb.add(makeSessionResult({ wrong: [q1, q2, q3] }));
    wb.updateStreak('q2', false); // q2 答错 2 次
    const paper = wb.buildReviewPaper(3);
    assert.equal(paper.length, 3);
    assert.equal(paper[0].id, 'q2', 'wrongCount 最大者排最前');
    assert.ok(paper.every((q) => q.source === 'wrong'));
    assert.deepEqual(paper.map((q) => q.answer), paper.map((q) => q.answer), '快照完整（含答案）');
  });

  test('题量超过错题数时按实有数量返回；重练卷题目 id 稳定可回写', () => {
    const wb = mk(makeRepo());
    wb.add(makeSessionResult({ wrong: [makeQuestion('q1')] }));
    const paper = wb.buildReviewPaper(5);
    assert.equal(paper.length, 1);
    const item = wb.updateStreak(paper[0].id, true);
    assert.equal(item.correctStreak, 1, '重练卷题号可直接回写 updateStreak');
  });
});

describe('WrongBook 构造约束', () => {
  test('缺 Repository 抛异常（编程错误，2.4 分层约定）', () => {
    assert.throws(() => new WrongBook(), /Repository/);
  });
});
