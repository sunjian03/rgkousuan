/**
 * wrongbook.js —— 错题本 WrongBook（设计报告 3.3.4 错题巩固状态机，对应任务 C5）
 *
 * 状态机（设计报告 3.3.4，对应 FR-05）：
 *   [*] --> active    答题错误，自动收录错题本
 *   active --> active 重练中再次答错：wrongCount+1，correctStreak 清零
 *   active --> mastered 连续答对 3 次，自动移出错题本
 *   mastered --> [*]  已巩固，报告标记知识点掌握
 *   mastered --> active 后续练习再次答错，重新收录
 *
 * 接口（设计报告 2.4 M3）：
 *   add(session)                       练习会话 → 入库错题列表（成绩页后自动调用）
 *   review(filter)                     {kpId, dateRange, status} → WrongItem[]
 *   buildReviewPaper(count)            题量 → Question[]（错题重练卷，R4）
 *   updateStreak(questionId, correct)  判分结果 → 错题状态（连续答对 3 次自动巩固）
 *
 * 数据结构（设计报告 3.2.1 wrong_items）：_id / profileId / question（题目快照）/
 * kpId / wrongCount / correctStreak / status(active|mastered) / lastWrongAt / updatedAt。
 * 错题存题目快照而非引用（3.2.2 关联说明 3），历史错题不随知识点配置更新而失效。
 *
 * 依赖：构造时注入 Repository（设计报告 3.1 WrongBook --> Repository），本模块不
 * 直接读写 localStorage；多档案场景由调用方传 profileId（构造参数可作默认值）。
 */
export class WrongBook {
  /**
   * @param {object} repository 数据仓库（C6 实现；测试可注入内存实现）
   * @param {object} options    { profileId, now }：默认档案与时间函数（可注入便于测试）
   */
  constructor(repository, options = {}) {
    if (!repository || typeof repository.save !== 'function' || typeof repository.load !== 'function') {
      throw new Error('WrongBook 需要注入 Repository（save/load）');
    }
    this.repo = repository;
    this.profileId = options.profileId || null;
    this.now = options.now || (() => Date.now());
  }

  /** 错题主键：按 档案 + 题目快照 id 确定，同一道题多次答错只累积不重复入库 */
  itemId(profileId, questionId) {
    return `${profileId}__${questionId}`;
  }

  /**
   * add(session, profileId?) → WrongItem[]（设计报告 2.4 M3）
   * 成绩页后自动调用：遍历会话错题列表，逐题按状态机收录/更新。
   */
  add(session, profileId) {
    const pid = profileId || this.profileId;
    const now = this.now();
    const saved = [];
    for (const w of session.wrongQuestions || []) {
      const q = w.question;
      const _id = this.itemId(pid, q.id);
      const exist = this.repo.load('wrong_items', _id);
      let item;
      if (exist) {
        if (exist.status === 'mastered') {
          // mastered --> active：后续练习再次答错，重新收录
          exist.status = 'active';
          exist.correctStreak = 0;
        }
        // active --> active：再次答错 wrongCount+1，correctStreak 清零
        exist.wrongCount += 1;
        exist.lastWrongAt = now;
        exist.updatedAt = now;
        item = exist;
      } else {
        // [*] --> active：答题错误，自动收录
        item = {
          _id,
          profileId: pid,
          question: q,
          kpId: q.kpId,
          wrongCount: 1,
          correctStreak: 0,
          status: 'active',
          lastWrongAt: now,
          updatedAt: now,
        };
      }
      this.repo.save('wrong_items', item);
      saved.push(item);
    }
    return saved;
  }

  /**
   * review(filter) → WrongItem[]（设计报告 2.4 M3）
   * filter：{ profileId, kpId, dateRange:{from,to}, status }
   * - status 默认 'active'（已巩固的错题移出错题本），传 'all' 返回全部；
   * - dateRange 按 lastWrongAt（最近答错时间）过滤；
   * - 排序：待巩固在前，再按最近答错时间倒序。
   */
  review(filter = {}) {
    const pid = filter.profileId || this.profileId;
    const items = this.repo.load('wrong_items');
    const list = items.filter((it) => {
      if (pid && it.profileId !== pid) {
        return false;
      }
      if (filter.kpId && it.kpId !== filter.kpId) {
        return false;
      }
      if (filter.status && filter.status !== 'all' && it.status !== filter.status) {
        return false;
      }
      if (!filter.status && it.status !== 'active') {
        return false; // 默认只列待巩固
      }
      if (filter.dateRange) {
        const { from, to } = filter.dateRange;
        if (from != null && it.lastWrongAt < from) {
          return false;
        }
        if (to != null && it.lastWrongAt > to) {
          return false;
        }
      }
      return true;
    });
    list.sort((x, y) => {
      if (x.status !== y.status) {
        return x.status === 'active' ? -1 : 1;
      }
      return y.lastWrongAt - x.lastWrongAt;
    });
    return list;
  }

  /**
   * buildReviewPaper(count, profileId?) → Question[]（设计报告 2.4 M3，错题重练卷 R4）
   * 取待巩固错题，按「累计答错次数倒序（最易错优先）、最近答错倒序」取前 count 道，
   * 输出题目快照（source 标记 'wrong'，question.id 保持稳定以便 updateStreak 回写）。
   */
  buildReviewPaper(count, profileId) {
    const items = this.review({ profileId: profileId || this.profileId, status: 'active' });
    const picked = items
      .sort((x, y) => y.wrongCount - x.wrongCount || y.lastWrongAt - x.lastWrongAt)
      .slice(0, count);
    return picked.map((it) => ({ ...it.question, source: 'wrong' }));
  }

  /**
   * updateStreak(questionId, correct, profileId?) → WrongItem | {ok:false}
   * 重练判分回写（设计报告 2.4 M3）：
   * - 答对：correctStreak+1，达到 3 次 → status='mastered'（自动移出错题本）；
   * - 答错：wrongCount+1、correctStreak 清零，status 保持/回到 'active'。
   */
  updateStreak(questionId, correct, profileId) {
    const pid = profileId || this.profileId;
    const item = this.repo.load('wrong_items', this.itemId(pid, questionId));
    if (!item) {
      return { ok: false, message: '错题不存在: ' + questionId };
    }
    if (correct) {
      item.correctStreak += 1;
      if (item.correctStreak >= 3) {
        item.status = 'mastered';
      }
    } else {
      item.wrongCount += 1;
      item.correctStreak = 0;
      item.status = 'active';
      item.lastWrongAt = this.now();
    }
    item.updatedAt = this.now();
    this.repo.save('wrong_items', item);
    return item;
  }
}
