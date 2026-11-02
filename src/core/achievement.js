/**
 * achievement.js —— 激励服务 AchievementService（3.3.6 延伸：星星/勋章/打卡，任务 C5）
 *
 * 设计依据：
 * - 接口（设计报告 2.4 M6）：achievement.record(sessionResult) → 星星/勋章/打卡变更；
 *   achievement.checkin(profileId, date) → 打卡结果；
 * - 实体（设计报告 3.2.1 achievements）：_id / profileId / stars / badges /
 *   checkinDates(YYYY-MM-DD 数组) / updatedAt；
 * - 流程（设计报告 5.2 流程图）：每次练习结束自动「错题入错题本、打卡更新、报告数据
 *   生成」，故 record() 同时承担三件事：落库练习记录（practice_records，stats 的
 *   数据源）、累计星星与勋章、自动打卡当天。
 *
 * 注意：设计报告未规定星星/勋章的具体数值规则，此处按需求报告 FR-06/FR-10
 * （奖励机制、打卡激励）定义，规则如下，可在报告中作为实现细节引用：
 * - 星星：每答对 1 题 +1 颗（累计制），星级 = round(正确率 × 5)，满分 5 星；
 * - 勋章（BADGES 表）：初次练习 / 10 次满分 / 累计 100 星 / 巩固 10 道错题 /
 *   连续打卡 3 天 / 连续打卡 7 天，达成即发放且只发一次；
 * - 打卡：每次练习自动打卡当天，checkin() 也可手动打卡（打卡日历页 P9 复用）。
 *
 * 依赖：构造时注入 Repository（设计报告 3.1 AchievementService --> Repository）。
 */

/** 勋章定义表（id 稳定，页面层据此展示名称/说明） */
export const BADGES = {
  first_practice: { name: '初次练习', desc: '完成第一次练习' },
  perfect_10: { name: '满分达人', desc: '获得 10 次满分' },
  star_100: { name: '百星小学霸', desc: '累计获得 100 颗星星' },
  master_10: { name: '纠错小能手', desc: '巩固 10 道错题' },
  streak_3: { name: '持之以恒', desc: '连续打卡 3 天' },
  streak_7: { name: '一周坚持', desc: '连续打卡 7 天' },
};

export class AchievementService {
  /**
   * @param {object} repository 数据仓库（C6 实现；测试可注入内存实现）
   * @param {object} options    { profileId, now }：默认档案与时间函数（可注入便于测试）
   */
  constructor(repository, options = {}) {
    if (!repository || typeof repository.save !== 'function' || typeof repository.load !== 'function') {
      throw new Error('AchievementService 需要注入 Repository（save/load）');
    }
    this.repo = repository;
    this.profileId = options.profileId || null;
    this.now = options.now || (() => Date.now());
  }

  /** 档案成就实体主键：一个档案一条成就记录（3.2.2 ER：PROFILES ||--|| ACHIEVEMENTS） */
  achId(profileId) {
    return 'ach__' + profileId;
  }

  /** 读取成就实体；不存在则创建空实体（不落库，首次结算时保存） */
  getOrCreate(profileId) {
    const _id = this.achId(profileId);
    return (
      this.repo.load('achievements', _id) || {
        _id,
        profileId,
        stars: 0,
        badges: [],
        checkinDates: [],
        updatedAt: this.now(),
      }
    );
  }

  /** 本地时区 YYYY-MM-DD */
  fmtDate(ts) {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /** 连续打卡天数：从 date 往前数连续的 checkinDates（含 date 本身） */
  streakOf(checkinDates, date) {
    const set = new Set(checkinDates);
    let streak = 0;
    const cur = new Date(date + 'T00:00:00');
    while (set.has(this.fmtDate(cur.getTime()))) {
      streak++;
      cur.setDate(cur.getDate() - 1);
    }
    return streak;
  }

  /** 新达成勋章检测：与已拥有勋章集合做差集，返回新勋章 id 列表 */
  newBadges(owned, candidateIds) {
    const ownedSet = new Set(owned);
    return candidateIds.filter((id) => BADGES[id] && !ownedSet.has(id));
  }

  /**
   * checkin(profileId, date?) → { date, streakDays, newBadges }（设计报告 2.4 M6）
   * 记录打卡（YYYY-MM-DD，去重），返回当天日期、连续打卡天数与新达成勋章；
   * date 缺省为今天。连续 3/7 天达成相应勋章。
   */
  checkin(profileId, date) {
    const pid = profileId || this.profileId;
    const key = date || this.fmtDate(this.now());
    const ach = this.getOrCreate(pid);
    if (!ach.checkinDates.includes(key)) {
      ach.checkinDates.push(key);
      ach.checkinDates.sort();
    }
    const streakDays = this.streakOf(ach.checkinDates, key);
    const earned = this.newBadges(ach.badges, [
      ...(streakDays >= 3 ? ['streak_3'] : []),
      ...(streakDays >= 7 ? ['streak_7'] : []),
    ]);
    ach.badges.push(...earned);
    ach.updatedAt = this.now();
    this.repo.save('achievements', ach);
    return {
      date: key,
      streakDays,
      newBadges: earned.map((id) => ({ id, ...BADGES[id] })),
    };
  }

  /**
   * record(sessionResult, profileId?) → Reward（设计报告 2.4 M6）
   * 练习结束自动结算（5.2 流程：报告数据生成 + 打卡更新 + 激励）：
   * 1) 由 SessionResult.detail 组装 practice_records 并落库（stats 数据源）；
   * 2) 星星累计（每答对 1 题 +1 星）、星级 = round(accuracy × 5)；
   * 3) 自动打卡当天（等同 checkin）；
   * 4) 勋章检测：初次练习 / 10 次满分 / 累计 100 星 / 巩固 10 道错题。
   * 返回 Reward：{ starsEarned, starsTotal, rating, checkin, newBadges }。
   */
  record(sessionResult, profileId) {
    const pid = profileId || this.profileId;
    const now = this.now();
    const detail = sessionResult.detail || [];

    // 1) 落库练习记录（设计报告 3.2.1 practice_records；paper 由题目快照组成）
    const record = {
      _id: 'pr__' + pid + '__' + now,
      profileId: pid,
      date: this.fmtDate(now),
      paper: detail.map((d) => d.question),
      answers: detail.map((d) => ({
        qid: d.question.id,
        userAnswer: d.userAnswer ?? null, // 漏答为 null
        correct: !!d.correct,
      })),
      score: sessionResult.correctCount, // 3.2.1：score 为答对题数（非百分制）
      accuracy: sessionResult.accuracy,
      durationSec: sessionResult.durationSeconds,
      wrongIds: (sessionResult.wrongQuestions || []).map((w) => w.question.id),
      createdAt: now,
    };
    this.repo.save('practice_records', record);

    // 2) 星星与星级
    const ach = this.getOrCreate(pid);
    const starsEarned = sessionResult.correctCount || 0; // 每答对 1 题 +1 星
    ach.stars += starsEarned;
    const rating =
      sessionResult.total === 0 ? 0 : Math.round((sessionResult.accuracy || 0) * 5);

    // 3) 自动打卡（复用 checkin 的连续天数与打卡勋章逻辑，但合并一次保存）
    const key = this.fmtDate(now);
    if (!ach.checkinDates.includes(key)) {
      ach.checkinDates.push(key);
      ach.checkinDates.sort();
    }
    const streakDays = this.streakOf(ach.checkinDates, key);

    // 4) 勋章检测（条件按上文注释的自定规则）
    const records = this.repo.load('practice_records').filter((r) => r.profileId === pid);
    const perfectCount = records.filter((r) => r.total > 0 && r.score === r.total).length;
    const masteredCount = this.repo
      .load('wrong_items')
      .filter((w) => w.profileId === pid && w.status === 'mastered').length;
    const earned = this.newBadges(ach.badges, [
      ...(records.length >= 1 ? ['first_practice'] : []),
      ...(perfectCount >= 10 ? ['perfect_10'] : []),
      ...(ach.stars >= 100 ? ['star_100'] : []),
      ...(masteredCount >= 10 ? ['master_10'] : []),
      ...(streakDays >= 3 ? ['streak_3'] : []),
      ...(streakDays >= 7 ? ['streak_7'] : []),
    ]);
    ach.badges.push(...earned);
    ach.updatedAt = now;
    this.repo.save('achievements', ach);

    return {
      starsEarned,
      starsTotal: ach.stars,
      rating, // 0~5 星，成绩页星级展示
      checkin: { date: key, streakDays },
      newBadges: earned.map((id) => ({ id, ...BADGES[id] })),
    };
  }
}
