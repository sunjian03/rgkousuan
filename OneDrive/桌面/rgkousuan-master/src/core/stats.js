/**
 * stats.js —— 统计服务 StatsService（设计报告 3.3.5 统计规则，对应任务 C5）
 *
 * 设计依据（设计报告 3.3.5）：
 * - 学习报告：日 / 周 / 月三个周期维度，展示练习次数、正确率、用时与错题数；
 * - 知识点掌握度：以「近 10 次该知识点题目的答对次数 / 出现次数」计算，无练习
 *   记录返回 null（页面显示「未练习」）。
 *
 * 接口（设计报告 2.4 M4）：
 *   stats.getReport(profileId, period)   period ∈ {day, week, month} → Report
 *   stats.getMastery(profileId, kpId)    掌握度（0~1）| null（未练习）
 *
 * 数据源（设计报告 3.2.1 practice_records）：
 *   _id / profileId / date(YYYY-MM-DD) / paper(题目快照) /
 *   answers[{qid,userAnswer,correct}] / score(答对题数) / accuracy /
 *   durationSec / wrongIds / createdAt。
 * 练习记录由成绩页流程通过 achievement.record() 一并落库（见 achievement.js）。
 *
 * 依赖：构造时注入 Repository（设计报告 3.1 StatsService --> Repository）。
 */
export class StatsService {
  /**
   * @param {object} repository 数据仓库（C6 实现；测试可注入内存实现）
   * @param {object} options    { now }：时间函数（可注入，便于 C7 单元测试，2.4 约定第 3 条）
   */
  constructor(repository, options = {}) {
    if (!repository || typeof repository.load !== 'function') {
      throw new Error('StatsService 需要注入 Repository（load）');
    }
    this.repo = repository;
    this.now = options.now || (() => Date.now());
  }

  /** 读取某档案的练习记录，按 createdAt 升序 */
  recordsOf(profileId) {
    return this.repo
      .load('practice_records')
      .filter((r) => r.profileId === profileId)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  /** 本地时区 YYYY-MM-DD（报告 date 字段与打卡日期统一用本地日期） */
  static fmtDate(ts) {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /** 单条记录汇总：正确率取 accuracy，错题数取 wrongIds 长度（兜底） */
  static summarize(records) {
    const n = records.length;
    if (n === 0) {
      return { practiceCount: 0, avgAccuracy: 0, totalDurationSec: 0, wrongCount: 0 };
    }
    const acc = records.reduce((s, r) => s + (r.accuracy ?? 0), 0) / n;
    const dur = records.reduce((s, r) => s + (r.durationSec ?? 0), 0);
    const wrong = records.reduce(
      (s, r) => s + (Array.isArray(r.wrongIds) ? r.wrongIds.length : 0),
      0
    );
    return {
      practiceCount: n,
      avgAccuracy: acc,
      totalDurationSec: dur,
      wrongCount: wrong,
    };
  }

  /**
   * getReport(profileId, period) → Report（设计报告 2.4 M4）
   * period 口径（按日历日，本地时区）：
   * - day：当日；
   * - week：最近 7 天（含今天）；
   * - month：最近 30 天（含今天）。
   * 返回：
   *   {
   *     period, fromDate, toDate,
   *     summary: { practiceCount, avgAccuracy, totalDurationSec, wrongCount }, // 区间汇总
   *     trend: [{ date, practiceCount, avgAccuracy, totalDurationSec, wrongCount }] // 按日聚合
   *   }
   * trend 每项同时含正确率与用时，成绩页折线图按两条序列渲染（FR-06 学习报告）。
   */
  getReport(profileId, period) {
    if (!['day', 'week', 'month'].includes(period)) {
      return { ok: false, message: 'period 仅支持 day/week/month' };
    }
    const now = this.now();
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    const to = new Date(StatsService.fmtDate(now) + 'T23:59:59.999');
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    from.setHours(0, 0, 0, 0);

    const inRange = this.recordsOf(profileId).filter((r) => {
      const ts = r.createdAt || Date.parse(r.date + 'T00:00:00');
      return ts >= from.getTime() && ts <= to.getTime();
    });

    // 按 date（YYYY-MM-DD）聚合
    const byDate = new Map();
    for (const r of inRange) {
      const key = r.date || StatsService.fmtDate(r.createdAt);
      if (!byDate.has(key)) {
        byDate.set(key, []);
      }
      byDate.get(key).push(r);
    }
    // 区间内每一天都出点（无练习的日子为 0，图表连续）
    const trend = [];
    for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
      const key = StatsService.fmtDate(t);
      trend.push({ date: key, ...StatsService.summarize(byDate.get(key) || []) });
    }
    return {
      period,
      fromDate: StatsService.fmtDate(from.getTime()),
      toDate: StatsService.fmtDate(to.getTime()),
      summary: StatsService.summarize(inRange),
      trend,
    };
  }

  /**
   * getMastery(profileId, kpId) → number(0~1) | null（设计报告 2.4 M4）
   * 掌握度 = 近 10 次该知识点题目答对次数 / 近 10 次出现次数（3.3.5）。
   * 「近 10 次」按练习时间倒序取最近出现的 10 道该知识点题目；无样本返回 null。
   */
  getMastery(profileId, kpId) {
    let occurs = 0;
    let corrects = 0;
    const records = this.recordsOf(profileId).slice().reverse(); // 最近的记录在前
    for (const r of records) {
      const answerOf = new Map((r.answers || []).map((a) => [a.qid, a]));
      for (const q of r.paper || []) {
        if (q.kpId !== kpId) {
          continue;
        }
        occurs++;
        const a = answerOf.get(q.id);
        if (a && a.correct) {
          corrects++;
        }
        if (occurs >= 10) {
          return corrects / occurs;
        }
      }
    }
    return occurs === 0 ? null : corrects / occurs;
  }
}
