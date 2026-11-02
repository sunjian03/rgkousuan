/**
 * repository.test.js —— 数据仓库 Repository 单元测试（设计报告 3.1/3.4 数据接口）
 * 覆盖 save/load 契约、近 3 次快照（R2）、练习草稿（NFR-06）、JSON 备份
 * （3.3.6）、一键删除（FR-09）与损坏容错。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Repository, MemoryStorage, ENTITY_TYPES } from '../src/core/repository.js';
import { makeQuestion } from './helpers.js';

const NOW = 1700000000000;
const mk = () => new Repository(new MemoryStorage(), { now: () => NOW });
const profile = (id) => ({ _id: id, nickname: '孩子' + id, grade: 1, semester: '上', prefs: { questionCount: 30, difficultyMode: 'mixed', dailyLimitMin: 30 }, createdAt: 1 });

describe('Repository.save/load（2.4 数据接口）', () => {
  test('upsert：同 _id 覆盖，不同 _id 追加', () => {
    const repo = mk();
    repo.save('profiles', profile('p1'));
    repo.save('profiles', profile('p2'));
    assert.equal(repo.load('profiles').length, 2);
    repo.save('profiles', { ...profile('p1'), nickname: '改名' });
    assert.equal(repo.load('profiles').length, 2);
    assert.equal(repo.load('profiles', 'p1').nickname, '改名');
  });

  test('load(id) 不存在返回 null', () => {
    assert.equal(mk().load('profiles', 'nope'), null);
  });

  test('类型白名单：非法 type 抛异常（编程错误）', () => {
    assert.throws(() => mk().save('nonsense', { _id: 'x' }), /未知数据类型/);
    assert.throws(() => mk().load('nonsense'), /未知数据类型/);
  });

  test('缺 _id 主键抛异常', () => {
    assert.throws(() => mk().save('profiles', { nickname: '无主键' }), /_id/);
  });

  test('数据为 JSON 存储格式（2.4 约定第 3 条：与 localStorage 存取格式一致）', () => {
    const storage = new MemoryStorage();
    new Repository(storage).save('profiles', profile('p1'));
    const raw = storage.getItem('ksl_profiles');
    assert.deepEqual(JSON.parse(raw), [profile('p1')]);
  });
});

describe('Repository 近 3 次练习快照（3.2.1(6) recent_papers，R2）', () => {
  test('滚动队列：只保留最近 3 次，最旧被丢弃', () => {
    const repo = mk();
    for (const exprs of [['1+1'], ['2+2'], ['3+3'], ['4+4']]) {
      repo.saveRecentPapers('p1', exprs);
    }
    const recents = repo.getRecentPapers('p1');
    assert.equal(recents.length, 3);
    assert.deepEqual(recents[0], ['2+2']);
    assert.deepEqual(recents[2], ['4+4']);
  });

  test('接受 Question[] 或表达式字符串数组', () => {
    const repo = mk();
    repo.saveRecentPapers('p1', [makeQuestion('q1'), makeQuestion('q2')]);
    assert.deepEqual(repo.getRecentPapers('p1')[0], ['q1+1=', 'q2+1=']);
  });

  test('按档案隔离', () => {
    const repo = mk();
    repo.saveRecentPapers('p1', ['1+1']);
    assert.deepEqual(repo.getRecentPapers('p2'), []);
  });
});

describe('Repository 练习草稿（3.2.1(6) session_draft，NFR-06）', () => {
  test('保存/恢复/清除', () => {
    const repo = mk();
    assert.equal(repo.loadDraft('p1'), null);
    const draft = { paper: [makeQuestion('q1')], answers: [{ qid: 'q1', userAnswer: '2' }], startedAt: 1 };
    repo.saveDraft('p1', draft);
    const got = repo.loadDraft('p1');
    assert.equal(got.paper.length, 1);
    assert.equal(got.answers[0].userAnswer, '2');
    assert.equal(got.savedAt, NOW);
    repo.clearDraft('p1');
    assert.equal(repo.loadDraft('p1'), null);
  });
});

describe('Repository.exportJson/importJson（3.3.6 数据备份与跨设备迁移）', () => {
  const seedData = (repo) => {
    repo.save('profiles', profile('p1'));
    repo.save('practice_records', { _id: 'r1', profileId: 'p1', date: '2026-11-01', paper: [], answers: [], score: 1, accuracy: 1, durationSec: 10, wrongIds: [], createdAt: 1 });
    repo.save('wrong_items', { _id: 'w1', profileId: 'p1', question: makeQuestion('q1'), kpId: 'g1a-add-carry-20', wrongCount: 1, correctStreak: 0, status: 'active', lastWrongAt: 1, updatedAt: 1 });
    repo.save('achievements', { _id: 'a1', profileId: 'p1', stars: 5, badges: ['first_practice'], checkinDates: ['2026-11-01'], updatedAt: 1 });
  };

  test('备份包：app 标识 + schemaVersion + 4 类实体，缓存不入包（3.4 仅存本地）', () => {
    const repo = mk();
    seedData(repo);
    repo.saveRecentPapers('p1', ['1+1']);
    repo.saveDraft('p1', { paper: [] });
    const pack = JSON.parse(repo.exportJson());
    assert.equal(pack.app, 'rgkousuan');
    assert.equal(pack.schemaVersion, 1);
    assert.equal(pack.exportedAt, NOW);
    assert.equal(pack.data.profiles.length, 1);
    assert.equal(pack.data.practice_records.length, 1);
    assert.equal(pack.data.wrong_items.length, 1);
    assert.equal(pack.data.achievements.length, 1);
    assert.ok(!('recent_papers' in pack.data) && !('session_draft' in pack.data));
  });

  test('新设备导入完整恢复（数据逐字段一致）', () => {
    const src = mk();
    seedData(src);
    const dst = mk();
    const r = dst.importJson(src.exportJson());
    assert.equal(r.ok, true);
    assert.equal(r.imported.profiles, 1);
    assert.deepEqual(dst.load('profiles'), src.load('profiles'));
    assert.deepEqual(dst.load('practice_records'), src.load('practice_records'));
    assert.deepEqual(dst.load('wrong_items'), src.load('wrong_items'));
    assert.deepEqual(dst.load('achievements'), src.load('achievements'));
  });

  test('合并导入：按 _id upsert，不覆盖本地数据，重复导入幂等', () => {
    const src = mk();
    seedData(src);
    const dst = mk();
    dst.save('profiles', profile('p9')); // 本地已有
    dst.importJson(src.exportJson());
    dst.importJson(src.exportJson());
    assert.equal(dst.load('profiles').length, 2, 'p1 导入 + p9 保留');
    assert.equal(dst.load('practice_records').length, 1, '重复导入不产生副本');
  });

  test('校验失败返回 {ok:false, message}（2.4 约定第 4 条）', () => {
    const repo = mk();
    assert.equal(repo.importJson('不是 JSON{{').ok, false);
    assert.equal(repo.importJson('{"app":"other"}').ok, false);
    assert.equal(repo.importJson('{"app":"rgkousuan","schemaVersion":99,"data":{}}').ok, false);
    assert.equal(repo.importJson('{"app":"rgkousuan","schemaVersion":1,"data":{"profiles":{}}}').ok, false);
  });

  test('实体级容错：无 _id 脏实体跳过并计数，其余正常导入', () => {
    const repo = mk();
    const src = mk();
    seedData(src);
    const pack = JSON.parse(src.exportJson());
    pack.data.profiles.push({ nickname: '脏数据' });
    const r = repo.importJson(JSON.stringify(pack));
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 1);
    assert.equal(repo.load('profiles').length, 1);
  });
});

describe('Repository 健壮性（NFR-06 离线可用）', () => {
  test('数据损坏按空集合处理并告警，练习不中断', () => {
    const storage = new MemoryStorage();
    storage.setItem('ksl_profiles', '{{{broken');
    const repo = new Repository(storage);
    assert.deepEqual(repo.load('profiles'), []);
    repo.save('profiles', profile('p1')); // 可恢复写入
    assert.equal(repo.load('profiles', 'p1').nickname, '孩子p1');
  });

  test('存储配额异常自动降级内存，数据仍可读写（不抛异常）', () => {
    const failing = {
      map: new Map(),
      getItem(k) { return this.map.get(k) ?? null; },
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem(k) { this.map.delete(k); },
    };
    const repo = new Repository(failing);
    repo.save('profiles', profile('p1'));
    assert.equal(repo.load('profiles', 'p1').nickname, '孩子p1', '降级内存后仍可读');
  });
});

describe('Repository.clear（FR-09 一键删除，3.4 记录级清除）', () => {
  test('clear(type) 清除单个集合，clear() 清空全部', () => {
    const repo = mk();
    repo.save('profiles', profile('p1'));
    repo.save('practice_records', { _id: 'r1', profileId: 'p1', date: 'd', paper: [], answers: [], score: 0, accuracy: 0, durationSec: 0, wrongIds: [], createdAt: 1 });
    repo.clear('profiles');
    assert.equal(repo.load('profiles').length, 0);
    assert.equal(repo.load('practice_records').length, 1);
    repo.clear();
    assert.ok(ENTITY_TYPES.every((t) => repo.load(t).length === 0));
  });
});
