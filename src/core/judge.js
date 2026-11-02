/**
 * judge.js —— 判题 Judger + 练习会话 PracticeSession（设计报告 3.3.3，对应任务 C4）
 *
 * 实现设计报告 3.3.3 判题流程：
 *   用户提交答案 → 取出题目快照 answer → 按呈现形式判断：
 *     算式式 → userAnswer == answer 整数比较
 *     填空式 → userAnswer == 空位对应值（blankAnswer）
 *   → 返回 correct + 正确答案 → 会话记录进度（页面层据此播放反馈动画/语音）
 *
 * 接口（设计报告 2.4 M2）：
 *   session.submit(questionId, userAnswer) → { correct, correctAnswer }  逐题判分（≤0.5 秒）
 *   session.finish() → SessionResult（得分、正确率、用时、错题列表）       练习结束汇总
 *
 * 接口约定（设计报告 2.4）：纯函数/显式依赖（时间函数 now 可注入，便于 C7
 * 单元测试）；错误统一返回 { ok:false, message }；比较全部基于整数或规范化
 * 字符串，无浮点参与（NFR-01）。
 */
/**
 * judge(question, userAnswer) → boolean
 * 判题核心（设计报告 3.1 Judger.judge）：
 * - 算式式：整数比较（输入串先转整数，如 "007" 与 7 视为相同）；
 * - 填空式：与空位对应值比较（数值型空位按整数比较，字符串型按规范化字符串）；
 * - 字符串答案（有余数除法 "5余2"、分数 "3/4"）：规范化（去空白）后比较；
 * - 空输入一律判错（防止空串被 Number 转成 0 误判）。
 */
export function judge(question, userAnswer) {
  const input = String(userAnswer ?? '').trim();
  if (input === '') {
    return false;
  }
  if (question.presentMode === 'blank') {
    const blank = question.blankAnswer;
    if (/^\d+$/.test(String(blank))) {
      return /^\d+$/.test(input) && Number(input) === Number(blank);
    }
    return input === String(blank);
  }
  const answer = question.answer;
  if (typeof answer === 'number') {
    return /^\d+$/.test(input) && Number(input) === answer;
  }
  return normalizeAnswer(input) === normalizeAnswer(String(answer));
}

/** getCorrectAnswer(question)：正确答案（填空式返回空位对应值），错题本/成绩页复用 */
export function getCorrectAnswer(question) {
  return question.presentMode === 'blank' ? question.blankAnswer : question.answer;
}

/** normalizeAnswer：答案规范化（去除全部空白），字符串答案比较用 */
function normalizeAnswer(s) {
  return s.replace(/\s+/g, '');
}

/**
 * PracticeSession —— 一次练习的会话状态机（设计报告 3.1）
 *
 * @param {Array}  questions  练习卷 Question[]（由 generator.generate 产出）
 * @param {object} options    { now }：时间函数，默认 Date.now，测试可注入
 */
export class PracticeSession {
  constructor(questions, options = {}) {
    this.questions = Array.isArray(questions) ? questions : [];
    this.now = options.now || (() => Date.now());
    this.startedAt = this.now();
    this.records = new Map(); // questionId → { correct, userAnswer, correctAnswer, answeredAt }
  }

  /**
   * submit(questionId, userAnswer) → { correct, correctAnswer }（设计报告 2.4 M2）
   * 逐题判分并记录；重复提交同一题返回首次判分结果（幂等，防页面双击）。
   * 未知题号返回 { ok:false, message }。
   */
  submit(questionId, userAnswer) {
    const q = this.questions.find((x) => x.id === questionId);
    if (!q) {
      return { ok: false, message: '题目不存在: ' + questionId };
    }
    if (this.records.has(questionId)) {
      const rec = this.records.get(questionId);
      return { correct: rec.correct, correctAnswer: rec.correctAnswer };
    }
    const correct = judge(q, userAnswer);
    const rec = {
      correct,
      userAnswer: String(userAnswer ?? '').trim(),
      correctAnswer: getCorrectAnswer(q),
      answeredAt: this.now(),
    };
    this.records.set(questionId, rec);
    return { correct, correctAnswer: rec.correctAnswer };
  }

  /**
   * finish() → SessionResult（设计报告 2.4 M2）
   * 得分（百分制）、正确率、用时（秒）、错题列表；未作答的题按答错计入
   * （错题列表中标记 userAnswer=null，供成绩页区分「漏答」与「答错」）。
   */
  finish() {
    const total = this.questions.length;
    let correctCount = 0;
    const wrongQuestions = [];
    const detail = [];

    for (const q of this.questions) {
      const rec = this.records.get(q.id);
      if (!rec) {
        wrongQuestions.push({ question: q, userAnswer: null, correctAnswer: getCorrectAnswer(q) });
        detail.push({ question: q, correct: false, answered: false });
        continue;
      }
      if (rec.correct) {
        correctCount++;
      } else {
        wrongQuestions.push({ question: q, userAnswer: rec.userAnswer, correctAnswer: rec.correctAnswer });
      }
      detail.push({ question: q, correct: rec.correct, userAnswer: rec.userAnswer, answered: true });
    }

    const durationSeconds = Math.round((this.now() - this.startedAt) / 1000);
    return {
      total,
      answered: this.records.size,
      correctCount,
      score: total === 0 ? 0 : Math.round((correctCount / total) * 100),
      accuracy: total === 0 ? 0 : correctCount / total,
      durationSeconds,
      wrongQuestions,
      detail,
    };
  }
}
