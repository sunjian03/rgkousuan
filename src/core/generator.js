/**
 * generator.js —— 出题引擎 QuestionGenerator（设计报告 3.3.1，对应任务 C2）
 *
 * 实现设计报告 3.3.1 流程图：
 *   输入(学期/知识点/题量N/难度模式/错题比例)
 *     → 读知识点配置 basicRules + advanceRules（R1 不超纲：范围内取值的天然成立）
 *     → 错题优先：从错题本取 M = min(10, N×30%) 道（R4）
 *     → 基础题数 B = ⌈(N−M)×60%⌉、进阶题数 A = N−M−B（R3 难度梯度）
 *     → 按规则随机生成基础/进阶题
 *     → 去重（R2）：规范化字符串 Set + 近 3 次快照，重复率 ≤20%，
 *       候选空间不足自动放宽并记录日志；生成循环上限 N×20 次，超限接受当前结果
 *     → 校验（R5）：Validator 复算 evaluate(expression) == answer
 *     → 排序：基础在前 60%、进阶在后 40%
 *     → 输出练习卷 Question[]
 *
 * 接口（设计报告 2.4）：
 *   generate(options) → Question[]            一键出题主接口
 *   listKnowledgePoints(semester) → KnowledgePoint[]
 *
 * 接口约定（设计报告 2.4）：纯函数（random 可注入便于 C7 单元测试）；错误统一
 * 返回 { ok:false, message }；全整数运算（R5 除法按「被除数=除数×商」反向构造）。
 *
 * 注意：算术类（+ - × ÷ / mixed）题目经 parser 校验器复算；特殊类（unit 单位换算、
 * frac 分数、clock 钟表）为整数换算构造题，不经四则解析器，在 validateQuestion
 * 中按构造公式独立复算，同样满足 R5「生成即校验」。
 */
import { evaluate, validate, normalizeExpr } from './parser.js';
import data from './knowledge_points.json' with { type: 'json' };

const kpById = new Map(data.knowledgePoints.map((kp) => [kp.id, kp]));

/** 生成循环上限系数：N×20 次（设计报告 3.3.1 防死循环） */
const TRY_FACTOR = 20;
/** 单题候选重试上限（候选空间过小兜底） */
const PER_QUESTION_TRIES = 50;
/** 错题插入上限（设计报告 3.3.1：M = min(10, N×30%)） */
const WRONG_CAP = 10;

/** randInt(min, max)：闭区间均匀随机整数（random 可注入，供 C7 单元测试复现） */
function randInt(min, max, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}

/** 在 [min,max] 内随机取一个 10 的倍数（整十数加减法专用） */
function randMultipleOf10(min, max, random) {
  const lo = Math.ceil(min / 10);
  const hi = Math.floor(max / 10);
  return 10 * randInt(lo, hi, random);
}

/** listKnowledgePoints(semester)：知识点选择界面数据源（设计报告 2.4） */
export function listKnowledgePoints(semester) {
  if (!semester) {
    return data.knowledgePoints;
  }
  return data.knowledgePoints.filter((kp) => kp.semester === semester);
}

/**
 * generate(options) —— 一键出题主接口（设计报告 2.4 M1）
 *
 * @param {object} options
 *   kpId            知识点 id（必填；semester 仅作一致性校验）
 *   count           题量 N，默认 30，范围 1~100
 *   difficultyMode  'mixed'(默认，基础60%+进阶40%) | 'basic' | 'advance'
 *   wrongRatio      错题插入比例，默认 0.3（M = min(10, N×wrongRatio)）
 *   recentPapers    近 3 次练习快照（每份快照为表达式字符串数组），R2 去重用
 *   wrongQuestions  错题列表（由 WrongBook 提供，C5 完成后接入；元素含
 *                   { id, kpId, expression, answer }，仅取本知识点的错题）
 *   presentMode     'normal'(默认) | 'blank'（R6 填空呈现）
 *   random          随机数函数，可注入用于测试（默认 Math.random）
 * @returns {Array}  Question[]；参数错误时返回 { ok:false, message }
 */
export function generate(options = {}) {
  const {
    kpId,
    semester,
    count = 30,
    difficultyMode = 'mixed',
    wrongRatio = 0.3,
    recentPapers = [],
    wrongQuestions = [],
    presentMode = 'normal',
    random = Math.random,
  } = options;

  // ---- 1. 参数校验（接口约定第 4 条：错误统一返回 {ok, message}） ----
  const kp = kpById.get(kpId);
  if (!kp) {
    return { ok: false, message: '知识点不存在: ' + kpId };
  }
  if (semester && kp.semester !== semester) {
    return { ok: false, message: `知识点 ${kp.id} 不属于学期 ${semester}（实际为 ${kp.semester}）` };
  }
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return { ok: false, message: '题量须为 1~100 的整数' };
  }
  if (!['mixed', 'basic', 'advance'].includes(difficultyMode)) {
    return { ok: false, message: '难度模式须为 mixed / basic / advance' };
  }

  // ---- 2. 错题优先：M = min(10, N×30%)，只取本知识点错题（R4） ----
  const wrongPool = wrongQuestions.filter((w) => w.kpId === kpId);
  const M = Math.min(wrongPool.length, WRONG_CAP, Math.floor(count * wrongRatio));
  const baseTotal = count - M;

  // ---- 3. 基础/进阶题数（R3 难度梯度：基础 60%、进阶 40%） ----
  let B;
  let A;
  if (difficultyMode === 'basic') {
    B = baseTotal;
    A = 0;
  } else if (difficultyMode === 'advance') {
    B = 0;
    A = baseTotal;
  } else {
    B = Math.ceil(baseTotal * 0.6);
    A = baseTotal - B;
  }

  // ---- 4. 近 3 次快照集合（R2 去重比对源） ----
  const recentSet = new Set();
  for (const paper of recentPapers) {
    const list = Array.isArray(paper) ? paper : [paper];
    for (const expr of list) {
      recentSet.add(normalizeExpr(expr));
    }
  }

  // ---- 5. 生成循环（上限 N×20 次，防死循环） ----
  const maxTries = count * TRY_FACTOR;
  let tries = 0;
  const paper = [];
  const paperSet = new Set();

  // 错题插入排在最前（错题优先）
  for (let i = 0; i < M; i++) {
    paper.push(buildWrongQuestion(wrongPool[i]));
  }

  // 先基础后进阶（对应 3.3.1「基础在前 60%、进阶在后 40%」的排序）
  const diffs = [...Array(B).fill('basic'), ...Array(A).fill('advance')];
  for (const difficulty of diffs) {
    if (tries > maxTries) {
      break; // 超限：接受当前结果（校验器保证正确性不受影响）
    }
    let q = null;
    let last = null;
    for (let t = 0; t < PER_QUESTION_TRIES; t++) {
      tries++;
      const cand = genOne(kp, difficulty, random);
      if (!cand) {
        continue;
      }
      last = cand;
      const key = normalizeExpr(cand.expression);
      // R2：先查本卷 Set，再查近 3 次快照
      if (paperSet.has(key) || recentSet.has(key)) {
        continue;
      }
      q = cand;
      break;
    }
    if (!q && last) {
      // 候选空间过小：放宽去重，接受最后一道候选（记录日志）
      console.warn(`[generator] 知识点 ${kp.id} 候选空间不足，接受重复题 ${normalizeExpr(last.expression)}`);
      q = last;
    }
    if (q) {
      paper.push(q);
      paperSet.add(normalizeExpr(q.expression));
    }
  }

  // ---- 6. R2 重复率检查：与近 3 次快照重复率 ≤20%，超限放宽并记录日志 ----
  const conflictCount = paper.filter((q) => recentSet.has(normalizeExpr(q.expression))).length;
  if (conflictCount > paper.length * 0.2) {
    console.warn(`[generator] R2 防重复比例放宽：与近 3 次快照重复 ${conflictCount}/${paper.length} 题（候选空间不足）`);
  }

  // ---- 7. R5 校验：复算不一致的题丢弃 ----
  const checked = paper.filter((q) => validateQuestion(q, kp));

  // ---- 8. R6 填空呈现 ----
  const result = presentMode === 'blank' ? checked.map((q) => toBlankForm(q, kp)) : checked;
  return result;
}

/**
 * validateQuestion —— R5 生成即校验（设计报告 3.3.1 校验框）
 * 算术类走 parser.evaluate 复算；特殊类按构造公式独立复算。
 */
function validateQuestion(q, kp) {
  if (['+', '-', '×', '÷', '+-', 'mixed'].includes(kp.op) && typeof q.answer === 'number') {
    return validate(q.expression, q.answer);
  }
  const expr = normalizeExpr(q.expression);
  if (kp.op === '÷' && typeof q.answer === 'string') {
    // 有余数除法："17÷3" → 商 5 余 2，复算商与余数
    const m = expr.match(/^(\d+)÷(\d+)$/);
    if (!m) {
      return false;
    }
    const a = Number(m[1]);
    const b = Number(m[2]);
    const quot = Math.trunc(a / b);
    const rem = a % b;
    return rem >= 1 && rem < b && q.answer === `${quot}余${rem}`;
  }
  if (kp.op === 'frac') {
    // 同分母分数加减："1/4+2/4" → 复算分子
    const m = expr.match(/^(\d+)\/(\d+)([+\-])(\d+)\/(\d+)$/);
    if (!m) {
      return false;
    }
    const na = Number(m[1]);
    const d1 = Number(m[2]);
    const op = m[3];
    const nb = Number(m[4]);
    const d2 = Number(m[5]);
    if (d1 !== d2) {
      return false; // same-denominator
    }
    const num = op === '+' ? na + nb : na - nb;
    if (num <= 0 || num >= d1) {
      return false; // proper-result
    }
    return q.answer === `${num}/${d1}`;
  }
  if (kp.op === 'unit') {
    // 单位换算："3m=□cm" → 查配置 pairs 复算
    const m = expr.match(/^(\d+)(\w+)=□(\w+)$/);
    if (!m) {
      return false;
    }
    const value = Number(m[1]);
    const from = m[2];
    const to = m[3];
    const pairs = [...(kp.basicRules.pairs || []), ...(kp.advanceRules.pairs || [])];
    const pair = pairs.find((p) => p[0] === from && p[1] === to);
    return Boolean(pair) && q.answer === value * pair[2];
  }
  if (kp.op === 'clock') {
    // 钟表顺序："3时+2时=□时" → 12 时制复算
    const m = expr.match(/^(\d+)时\+(\d+)时=□时$/);
    if (!m) {
      return false;
    }
    const h = Number(m[1]);
    const s = Number(m[2]);
    return q.answer === ((h + s - 1) % 12) + 1;
  }
  return false;
}

/** buildWrongQuestion：错题条目转 Question 快照（source 标记 'wrong'） */
function buildWrongQuestion(item) {
  return {
    id: 'w' + item.id,
    kpId: item.kpId,
    difficulty: 'basic',
    source: 'wrong',
    presentMode: 'normal',
    expression: item.expression,
    answer: item.answer,
  };
}

/** genOne：按知识点 op 类型分发生成单道题 */
function genOne(kp, difficulty, random) {
  switch (kp.op) {
    case '+':
    case '-':
    case '×':
    case '÷':
    case '+-':
      return genArith(kp, difficulty, random);
    case 'mixed':
      return genMixed(kp, difficulty, random);
    case 'unit':
      return genUnit(kp, difficulty, random);
    case 'frac':
      return genFrac(kp, difficulty, random);
    case 'clock':
      return genClock(kp, difficulty, random);
    default:
      return null;
  }
}

/** 生成器内部计数：Question.id 唯一性 */
let qSeq = 0;

/** genArith：四则运算题（含除法反向构造、减法非负等 R5 约束） */
function genArith(kp, difficulty, random) {
  const rules = difficulty === 'basic' ? kp.basicRules : kp.advanceRules;
  const ops = kp.op === '+-' ? ['+', '-'] : [kp.op];
  const constraints = rules.constraints || [];
  const multipleOf10 = constraints.includes('multiple-of-10');

  for (let t = 0; t < PER_QUESTION_TRIES; t++) {
    const op = ops[randInt(0, ops.length - 1, random)];
    const pick = (key) =>
      multipleOf10 ? randMultipleOf10(rules[key][0], rules[key][1], random) : randInt(rules[key][0], rules[key][1], random);

    if (op === '÷') {
      // R5：除法按「被除数 = 除数 × 商（+ 余数）」反向构造，保证整除/余数合法
      const divisor = randInt(rules.divisor[0], rules.divisor[1], random);
      const quotient = randInt(rules.quotient[0], rules.quotient[1], random);
      let remainder = 0;
      let answer;
      if (constraints.includes('div-exact')) {
        answer = quotient;
      } else if (constraints.includes('div-remainder')) {
        // 余数 ∈ [1, 除数-1]（与配置范围取交集）
        const lo = Math.max(1, rules.remainder[0]);
        const hi = Math.min(divisor - 1, rules.remainder[1]);
        if (lo > hi) {
          continue;
        }
        remainder = randInt(lo, hi, random);
        answer = `${quotient}余${remainder}`;
      } else {
        continue;
      }
      const a = divisor * quotient + remainder;
      const q = makeQuestion(kp, difficulty, `${a}÷${divisor}=`, answer);
      if (inRange(q.answer, rules.result)) {
        return q;
      }
      continue;
    }

    let a = pick('a');
    let b = pick('b');

    if (op === '-') {
      // R5：减法按「被减数 ≥ 减数」构造，保证非负
      if (a < b) {
        [a, b] = [b, a];
      }
      // 逐位约束检查（退位 / 不退位）
      if (constraints.includes('sub-borrow') && a % 10 >= b % 10) {
        continue;
      }
      if (constraints.includes('carry-or-borrow') && a % 10 >= b % 10) {
        continue;
      }
      if (constraints.includes('no-carry') && (a % 10 < b % 10 || Math.floor(a / 10) < Math.floor(b / 10))) {
        continue;
      }
    }

    if (op === '+') {
      if (constraints.includes('carry-or-borrow') && a % 10 + b % 10 < 10) {
        continue;
      }
      if (constraints.includes('no-carry') && (a % 10 + b % 10 > 9 || Math.floor(a / 10) + Math.floor(b / 10) > 9)) {
        continue;
      }
    }

    const answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
    if (inRange(answer, rules.result)) {
      return makeQuestion(kp, difficulty, `${a}${op}${b}=`, answer);
    }
  }
  return null;
}

/** genMixed：混合运算题（模板实例化 + 中间约束 + 解析器复算） */
function genMixed(kp, difficulty, random) {
  const rules = difficulty === 'basic' ? kp.basicRules : kp.advanceRules;
  const templates = rules.template;
  const hasC = templates.some((t) => t.includes('c'));

  for (let t = 0; t < PER_QUESTION_TRIES; t++) {
    const tpl = templates[randInt(0, templates.length - 1, random)];
    const a = randInt(rules.a[0], rules.a[1], random);
    const b = randInt(rules.b[0], rules.b[1], random);
    const c = hasC ? randInt(rules.c[0], rules.c[1], random) : 0;

    // 中间步骤约束（div-exact-step / sub-nonneg-step）
    if (!checkStepConstraints(tpl, a, b, c)) {
      continue;
    }

    const expr = tpl.replace(/a/g, a).replace(/b/g, b).replace(/c/g, c) + '=';
    let answer;
    try {
      answer = evaluate(expr); // 用解析器复算答案（R5）
    } catch {
      continue;
    }
    if (inRange(answer, rules.result)) {
      return makeQuestion(kp, difficulty, expr, answer);
    }
  }
  return null;
}

/**
 * checkStepConstraints：混合运算模板的中间步骤约束
 * div-exact-step：÷ 步骤整除；sub-nonneg-step：中间结果非负
 */
function checkStepConstraints(tpl, a, b, c) {
  switch (tpl) {
    case 'a+b-c':
      return a + b - c >= 0;
    case 'a-b+c':
      return a - b >= 0;
    case 'a×b-c':
      return a * b - c >= 0;
    case 'a÷b+c':
      return a % b === 0;
    case 'a÷b-c':
      return a % b === 0 && Math.trunc(a / b) - c >= 0;
    case '(a-b)×c':
      return a - b >= 0;
    default:
      return true; // 全加、全乘、含括号加法形式无中间约束
  }
}

/** genUnit：长度单位换算题（pairs 随机取一对，结果位填空呈现） */
function genUnit(kp, difficulty, random) {
  const rules = difficulty === 'basic' ? kp.basicRules : kp.advanceRules;
  for (let t = 0; t < PER_QUESTION_TRIES; t++) {
    const [from, to, rate] = rules.pairs[randInt(0, rules.pairs.length - 1, random)];
    const value = randInt(rules.value[0], rules.value[1], random);
    const answer = value * rate;
    const q = makeQuestion(kp, difficulty, `${value}${from}=□${to}`, answer);
    q.presentMode = 'blank';
    q.blankPos = 'result';
    q.blankAnswer = String(answer);
    return q;
  }
  return null;
}

/** genFrac：同分母分数加减题（整数分子运算，结果保持真分数） */
function genFrac(kp, difficulty, random) {
  const rules = difficulty === 'basic' ? kp.basicRules : kp.advanceRules;
  for (let t = 0; t < PER_QUESTION_TRIES; t++) {
    const d = randInt(rules.denominator[0], rules.denominator[1], random);
    const na = randInt(rules.numeratorA[0], rules.numeratorA[1], random);
    const nb = randInt(rules.numeratorB[0], rules.numeratorB[1], random);
    const op = random() < 0.5 ? '+' : '-';
    // same-denominator + proper-result：同分母；结果分子 < 分母（减法还需 na > nb）
    if (op === '+' && na + nb >= d) {
      continue;
    }
    if (op === '-' && na <= nb) {
      continue;
    }
    const answer = op === '+' ? `${na + nb}/${d}` : `${na - nb}/${d}`;
    return makeQuestion(kp, difficulty, `${na}/${d}${op}${nb}/${d}=`, answer);
  }
  return null;
}

/** genClock：钟表顺序题（「几时再过几时是几时」，12 时制循环） */
function genClock(kp, difficulty, random) {
  const rules = difficulty === 'basic' ? kp.basicRules : kp.advanceRules;
  for (let t = 0; t < PER_QUESTION_TRIES; t++) {
    const hour = randInt(rules.hour[0], rules.hour[1], random);
    const step = randInt(rules.step[0], rules.step[1], random);
    const answer = ((hour + step - 1) % 12) + 1;
    const q = makeQuestion(kp, difficulty, `${hour}时+${step}时=□时`, answer);
    q.presentMode = 'blank';
    q.blankPos = 'result';
    q.blankAnswer = String(answer);
    return q;
  }
  return null;
}

/** makeQuestion：组装 Question 快照（字段见设计报告 3.1 类图） */
function makeQuestion(kp, difficulty, expression, answer) {
  qSeq++;
  return {
    id: 'q' + qSeq + '-' + Math.random().toString(36).slice(2, 6),
    kpId: kp.id,
    difficulty,
    source: 'new',
    presentMode: 'normal',
    expression,
    answer,
  };
}

/** inRange：result 范围检查（配置未声明 result 或答案为字符串时视为不限） */
function inRange(answer, result) {
  if (!result || typeof answer !== 'number') {
    return true;
  }
  return answer >= result[0] && answer <= result[1];
}

/**
 * toBlankForm(question, kp) —— R6 填空呈现（设计报告 3.3.1 要点 4）
 * 从算式三个位置（操作数1/操作数2/结果）随机选一处挖空，优先结果位；
 * 分数题只挖结果位（操作数为分数，无法在数字键盘输入）。
 * 挖空后记录 blankPos / blankAnswer，判题时按空位比较（设计报告 3.3.3）。
 * 注意：挖结果位时表达式保持「7+8=」原样（= 后即为空位），由页面层在 = 后渲染输入框。
 */
export function toBlankForm(question, kp) {
  if (question.presentMode === 'blank') {
    return question; // 单位换算、钟表题天然是结果位填空
  }
  let pos;
  if (kp && kp.op === 'frac') {
    pos = 'result';
  } else {
    // 优先结果位：结果 50%，两个操作数各 25%
    const r = Math.random();
    pos = r < 0.5 ? 'result' : r < 0.75 ? 'a' : 'b';
  }
  const expr = normalizeExpr(question.expression);
  if (pos === 'result') {
    return {
      ...question,
      presentMode: 'blank',
      blankPos: 'result',
      blankAnswer: String(question.answer),
      expression: expr + '=',
    };
  }
  // 挖操作数：按第一个运算符拆分（混合/连式挖空只支持简单两操作数算式，否则退回结果位）
  const opMatch = expr.match(/[+\-×÷]/);
  const opIdx = opMatch ? opMatch.index : -1;
  if (opIdx < 0) {
    return blankResult(question, expr);
  }
  const left = expr.slice(0, opIdx);
  const right = expr.slice(opIdx);
  if (pos === 'a') {
    return {
      ...question,
      presentMode: 'blank',
      blankPos: 'a',
      blankAnswer: left,
      expression: '□' + right + '=',
    };
  }
  const restMatch = right.match(/^([+\-×÷])(\d+)(.*)$/);
  if (!restMatch) {
    return blankResult(question, expr);
  }
  return {
    ...question,
    presentMode: 'blank',
    blankPos: 'b',
    blankAnswer: restMatch[2],
    expression: left + restMatch[1] + '□' + restMatch[3] + '=',
  };
}

/** blankResult：退回结果位挖空 */
function blankResult(question, expr) {
  return {
    ...question,
    presentMode: 'blank',
    blankPos: 'result',
    blankAnswer: String(question.answer),
    expression: expr + '=',
  };
}
