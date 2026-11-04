/**
 * core.test.js —— C7 核心模块单元测试（node --test 零依赖）
 *
 * 覆盖设计报告出题规则 R1~R6（3.3.1）、表达式求值器（3.3.2）、判题正确性
 * （3.3.3），即 2.4 接口 M1/M2 的全部质量断言；M3~M6/数据层见同目录
 * wrongbook/stats/achievement/repository 测试文件。
 *
 * 运行：npm test（= node --test，自动发现 test/*.test.js）
 * 随机性处理：注入种子伪随机（LCG），测试可复现（2.4 约定第 3 条）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import kpData from '../src/core/knowledge_points.json' with { type: 'json' };
import { generate, listKnowledgePoints } from '../src/core/generator.js';
import { evaluate, validate, normalizeExpr, tokenize, parseExpression } from '../src/core/parser.js';
import { judge, getCorrectAnswer, PracticeSession } from '../src/core/judge.js';

const KPS = kpData.knowledgePoints;
const kpById = new Map(KPS.map((k) => [k.id, k]));

/** 种子伪随机（LCG），保证测试可复现 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 提取表达式中全部数字（按出现顺序） */
function numsOf(expr) {
  return [...String(expr).matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** 两数算术式 "a+b=" / "a-b=" 提取 {n1, op, n2} */
function twoNum(expr) {
  const m = String(expr).match(/^(\d+)([+\-])(\d+)=$/);
  assert.ok(m, `表达式应为两数算式: ${expr}`);
  return { n1: Number(m[1]), op: m[2], n2: Number(m[3]) };
}

function inRange(v, [min, max]) {
  return v >= min && v <= max;
}

/**
 * 单题断言（R1 不超纲 + R5 生成即校验）：
 * 按知识点 op 与难度档取 basicRules/advanceRules，独立复算并核对范围。
 * 失败信息带上下文便于定位。
 */
function assertQuestion(kp, q) {
  const ctx = `[${kp.id}/${q.difficulty}] ${q.expression} = ${q.answer}`;
  const rules = q.difficulty === 'basic' ? kp.basicRules : kp.advanceRules;
  // blank 呈现先还原为 normal 算式（空位填回 blankAnswer；结果位去掉 =□ 尾巴），
  // 范围与复算断言即可原样复用；unit/clock 的 □ 是表达式固有格式（blankPos 恒为
  // result），不参与还原，由其分支单独断言。
  let expr = q.expression;
  if (q.presentMode === 'blank' && !['unit', 'clock'].includes(kp.op)) {
    expr = q.blankPos === 'result'
      ? String(q.expression).replace(/=□$/, '=')
      : String(q.expression).replace('□', q.blankAnswer);
  }

  if (['+', '-', '+-'].includes(kp.op)) {
    const { n1, op, n2 } = twoNum(expr);
    // R5 复算（生成即校验：独立于生成逻辑重新求值）
    assert.equal(evaluate(expr), q.answer, `复算不符 ${ctx}`);
    assert.ok(inRange(q.answer, rules.result), `结果超纲 ${ctx}`);
    if (op === '+') {
      assert.ok(inRange(n1, rules.a) && inRange(n2, rules.b), `加数超纲 ${ctx}`);
    } else {
      // 减法：生成侧保证非负（先取值后交换，故两数落 a/b 并集）
      assert.ok(n1 >= n2, `减法为负 ${ctx}`);
      assert.ok(inRange(n1, rules.a) || inRange(n1, rules.b), `被减数超纲 ${ctx}`);
      assert.ok(inRange(n2, rules.a) || inRange(n2, rules.b), `减数超纲 ${ctx}`);
      assert.equal(n1 - n2, q.answer, `减法复算不符 ${ctx}`);
    }
    // 约束词汇表逐项核对（meta.constraints）
    const cons = rules.constraints || [];
    if (op === '+' && cons.includes('no-carry')) {
      assert.ok(n1 % 10 + (n2 % 10) <= 9 && Math.floor(n1 / 10) + Math.floor(n2 / 10) <= 9, `应不进位 ${ctx}`);
    }
    if (op === '-' && cons.includes('no-carry')) {
      assert.ok(n1 % 10 >= n2 % 10 && Math.floor(n1 / 10) >= Math.floor(n2 / 10), `应不退位 ${ctx}`);
    }
    if (cons.includes('carry-or-borrow')) {
      const carry = op === '+'
        ? n1 % 10 + (n2 % 10) >= 10 || Math.floor(n1 / 10) + Math.floor(n2 / 10) >= 10
        : n1 % 10 < n2 % 10 || Math.floor(n1 / 10) < Math.floor(n2 / 10);
      assert.ok(carry, `应进位/退位 ${ctx}`);
    }
    if (cons.includes('sub-borrow')) {
      assert.ok(n1 % 10 < n2 % 10, `应退位 ${ctx}`);
    }
    if (cons.includes('multiple-of-10')) {
      assert.ok(n1 % 10 === 0 && n2 % 10 === 0, `应为整十数 ${ctx}`);
    }
    return;
  }

  if (kp.op === '×') {
    const [a, b] = numsOf(expr);
    assert.ok(inRange(a, rules.a) && inRange(b, rules.b), `因数超纲 ${ctx}`);
    assert.equal(a * b, q.answer, `乘法复算不符 ${ctx}`);
    assert.ok(inRange(q.answer, rules.result), `结果超纲 ${ctx}`);
    return;
  }

  if (kp.op === '÷') {
    const [n1, n2] = numsOf(expr);
    assert.ok(inRange(n2, rules.divisor), `除数超纲 ${ctx}`);
    const quot = Math.trunc(n1 / n2);
    const rem = n1 % n2;
    assert.ok(inRange(quot, rules.quotient), `商超纲 ${ctx}`);
    assert.ok(inRange(rem, rules.remainder), `余数超纲 ${ctx}`);
    if (rules.constraints.includes('div-exact')) {
      assert.equal(rem, 0, `应整除 ${ctx}`);
      assert.equal(q.answer, quot, `整除答案不符 ${ctx}`);
    } else {
      assert.ok(rem >= 1 && rem < n2, `余数应在 [1, 除数-1] ${ctx}`);
      assert.equal(q.answer, `${quot}余${rem}`, `余数答案不符 ${ctx}`);
    }
    return;
  }

  if (kp.op === 'mixed') {
    assert.equal(evaluate(expr), q.answer, `混合运算复算不符 ${ctx}`);
    assert.ok(inRange(q.answer, rules.result), `混合运算结果超纲 ${ctx}`);
    const divStep = String(expr).match(/(\d+)÷(\d+)/);
    if (divStep && rules.constraints.includes('div-exact-step')) {
      assert.equal(Number(divStep[1]) % Number(divStep[2]), 0, `÷ 步骤应整除 ${ctx}`);
    }
    return;
  }

  if (kp.op === 'unit') {
    const m = String(expr).match(/^(\d+)(\w+)=□(\w+)$/);
    assert.ok(m, `单位换算格式不符 ${ctx}`);
    const value = Number(m[1]);
    assert.ok(inRange(value, rules.value), `换算数值超纲 ${ctx}`);
    const hit = rules.pairs.some(([f, t, rate]) => f === m[2] && t === m[3] && value * rate === Number(q.answer));
    assert.ok(hit, `单位对不在配置或换算错误 ${ctx}`);
    if (q.presentMode === 'blank') {
      assert.equal(q.blankPos, 'result', '单位换算空位应在结果位');
      assert.equal(String(q.blankAnswer), String(q.answer), '单位换算 blankAnswer 应为换算结果');
    }
    return;
  }

  if (kp.op === 'frac') {
    const m = String(expr).match(/^(\d+)\/(\d+)([+\-])(\d+)\/(\d+)=$/);
    assert.ok(m, `分数格式不符 ${ctx}`);
    const [na, d, op, nb] = [Number(m[1]), Number(m[2]), m[3], Number(m[4])];
    assert.equal(Number(m[5]), d, `应同分母 ${ctx}`);
    assert.ok(inRange(d, rules.denominator), `分母超纲 ${ctx}`);
    assert.ok(inRange(na, rules.numeratorA) && inRange(nb, rules.numeratorB), `分子超纲 ${ctx}`);
    assert.ok(na < d && nb < d, `操作数应为真分数 ${ctx}`);
    if (op === '+') {
      assert.ok(na + nb < d, `和应为真分数 ${ctx}`);
      assert.equal(q.answer, `${na + nb}/${d}`, `分数加法答案不符 ${ctx}`);
    } else {
      assert.ok(na > nb, `差应为正 ${ctx}`);
      assert.equal(q.answer, `${na - nb}/${d}`, `分数减法答案不符 ${ctx}`);
    }
    return;
  }

  if (kp.op === 'clock') {
    const m = String(expr).match(/^(\d+)时\+(\d+)时=□时$/);
    assert.ok(m, `钟表格式不符 ${ctx}`);
    const [h, s] = [Number(m[1]), Number(m[2])];
    assert.ok(inRange(h, rules.hour) && inRange(s, rules.step), `钟表数值超纲 ${ctx}`);
    assert.equal(q.answer, ((h + s - 1) % 12) + 1, `12 时制答案不符 ${ctx}`);
    if (q.presentMode === 'blank') {
      assert.equal(q.blankPos, 'result', '钟表空位应在结果位');
      assert.equal(String(q.blankAnswer), String(q.answer), '钟表 blankAnswer 应为结果');
    }
    return;
  }

  assert.fail(`未覆盖的 op 类型: ${kp.op}`);
}

/** 全知识点 × 难度模式出卷并逐题断言（R1 不超纲、R5 生成即校验） */
function eachPaper(count, presentMode = 'normal', difficultyMode) {
  let checked = 0;
  for (let i = 0; i < KPS.length; i++) {
    const kp = KPS[i];
    const modes = difficultyMode ? [difficultyMode] : ['basic', 'advance', 'mixed'];
    for (const mode of modes) {
      const paper = generate({
        kpId: kp.id,
        count,
        difficultyMode: mode,
        presentMode,
        random: seeded(1000 + i * 7 + (mode === 'basic' ? 0 : mode === 'advance' ? 1 : 2)),
      });
      assert.ok(Array.isArray(paper) && paper.length === count, `出卷数量不符 [${kp.id}/${mode}] 期望 ${count} 实际 ${paper.length}`);
      for (const q of paper) {
        assertQuestion(kp, q);
        checked++;
      }
    }
  }
  return checked;
}

// ================= 3.3.2 表达式求值器 =================
describe('parser（3.3.2 递归下降求值器）', () => {
  test('四则运算与优先级', () => {
    assert.equal(evaluate('7+8='), 15);
    assert.equal(evaluate('2+3×4='), 14);   // 乘先于加
    assert.equal(evaluate('10-2-3='), 5);   // 同级左结合
    assert.equal(evaluate('9÷2='), 4);      // 整数除法截断
    assert.equal(evaluate('3-5+10='), 8);   // 中间负数仍为整数（NFR-01）
    assert.equal(evaluate('2×3×4='), 24);
  });
  test('括号与混合运算（paren 知识点扩展）', () => {
    assert.equal(evaluate('2×(3+4)='), 14);
    assert.equal(evaluate('(2+3)×4='), 20);
    assert.equal(evaluate('(8-3)×(2+1)='), 15);
  });
  test('减号两种写法等价', () => {
    assert.equal(evaluate('8−3='), 5);
    assert.equal(evaluate('8-3='), 5);
  });
  test('非法输入抛异常（不返回错误结果）', () => {
    // 注：空格按语法定义忽略，"2 3" 归一为 23，不属非法输入
    for (const bad of ['', '2+3x', '2+(3', '=', '×3+1', '2.5+1', '2+', '2+3)4']) {
      assert.throws(() => evaluate(bad), undefined, `应抛异常: ${bad}`);
    }
  });
  test('validate：R5 独立复算', () => {
    assert.equal(validate('7+8=', 15), true);
    assert.equal(validate('7+8=', 16), false);
    assert.equal(validate('2×(3+4)=', 14), true);
    assert.equal(validate('2×(3+4=', 14), false); // 括号不匹配 → false 而非崩溃
  });
  test('normalizeExpr：防重复键规范化', () => {
    assert.equal(normalizeExpr(' 7+8= '), '7+8');
    assert.equal(normalizeExpr('8−3='), '8-3');
  });
  test('tokenize/parseExpression 直接调用', () => {
    const tokens = tokenize('2+3×4');
    assert.deepEqual(tokens.map((t) => t.value ?? t.type), [2, '+', 3, '×', 4]);
    assert.equal(parseExpression(tokens)[0], 14);
  });
});

// ================= R1~R6 出题引擎 =================
describe('generator（3.3.1 出题引擎 R1~R6）', () => {
  test('R1 不超纲 + R5 生成即校验：26 知识点 × 3 难度档 × 10 题 = 780 题逐题核对', () => {
    const n = eachPaper(10);
    assert.equal(n, 780);
  });

  test('R2 防重复：本卷内无重复表达式', () => {
    const paper = generate({ kpId: 'g3a-add-sub-3digit', count: 30, difficultyMode: 'mixed', random: seeded(202) });
    const keys = paper.map((q) => normalizeExpr(q.expression));
    assert.equal(new Set(keys).size, 30);
  });

  test('R2 防重复：与近 3 次快照重复率 ≤ 20%', () => {
    // 3 张历史快照（各 20 题，不同 seed），新卷 30 题：大候选空间下应满足 20% 上限
    const snaps = [1, 2, 3].map((s) =>
      generate({ kpId: 'g3a-add-sub-3digit', count: 20, difficultyMode: 'mixed', random: seeded(s) })
        .map((q) => normalizeExpr(q.expression))
    );
    const paper = generate({
      kpId: 'g3a-add-sub-3digit', count: 30, difficultyMode: 'mixed',
      recentPapers: snaps, random: seeded(9),
    });
    assert.equal(paper.length, 30);
    const recent = new Set(snaps.flat());
    const conflicts = paper.filter((q) => recent.has(normalizeExpr(q.expression))).length;
    assert.ok(conflicts <= 6, `与快照重复 ${conflicts}/30 超过 20%`);
  });

  test('R2 防重复：小候选空间自动放宽且不死循环（出满题量）', () => {
    // 20 以内进位加法候选仅 36 道，3 张满快照后必触发放宽路径
    const snaps = [11, 12, 13].map((s) =>
      generate({ kpId: 'g1a-add-carry-20', count: 20, difficultyMode: 'mixed', random: seeded(s) })
        .map((q) => normalizeExpr(q.expression))
    );
    const paper = generate({
      kpId: 'g1a-add-carry-20', count: 30, difficultyMode: 'mixed',
      recentPapers: snaps, random: seeded(14),
    });
    assert.equal(paper.length, 30);
  });

  test('R3 难度梯度：mixed = 基础 60% + 进阶 40%，basic/advance 模式全档一致', () => {
    const mixed = generate({ kpId: 'g3a-add-sub-3digit', count: 30, difficultyMode: 'mixed', random: seeded(301) });
    assert.equal(mixed.filter((q) => q.difficulty === 'basic').length, 18);
    assert.equal(mixed.filter((q) => q.difficulty === 'advance').length, 12);
    const basic = generate({ kpId: 'g3a-add-sub-3digit', count: 20, difficultyMode: 'basic', random: seeded(302) });
    assert.ok(basic.every((q) => q.difficulty === 'basic'));
    const advance = generate({ kpId: 'g3a-add-sub-3digit', count: 20, difficultyMode: 'advance', random: seeded(303) });
    assert.ok(advance.every((q) => q.difficulty === 'advance'));
  });

  test('R4 错题插入：M = min(错题数, 10, ⌊N×30%⌋)，错题排最前', () => {
    const wrong = generate({ kpId: 'g3a-add-sub-3digit', count: 12, difficultyMode: 'mixed', random: seeded(401) });
    const paper = generate({
      kpId: 'g3a-add-sub-3digit', count: 30, difficultyMode: 'mixed',
      wrongQuestions: wrong, random: seeded(402),
    });
    const M = Math.min(wrong.length, 10, Math.floor(30 * 0.3)); // 9
    assert.equal(M, 9);
    assert.equal(paper.slice(0, M).filter((q) => q.source === 'wrong').length, M, '前 M 题应为错题');
    assert.equal(paper.slice(M).filter((q) => q.source === 'wrong').length, 0, '其余题不应混入错题');
    // 错题按用户答案原样收录（题目快照 id 前加 w 标记，judge 可判）
    assert.ok(paper[0].id.startsWith('w'), '错题题号带 w 前缀');
  });

  test('R4 错题插入：异知识点错题被过滤（M=0）', () => {
    const other = generate({ kpId: 'g1a-add-carry-20', count: 5, difficultyMode: 'mixed', random: seeded(403) });
    const paper = generate({
      kpId: 'g3a-add-sub-3digit', count: 20, difficultyMode: 'mixed',
      wrongQuestions: other, random: seeded(404),
    });
    assert.equal(paper.filter((q) => q.source === 'wrong').length, 0);
  });

  test('R5 除法反向构造：整除（商×除数=被除数）与余数（余数<除数）', () => {
    const exact = generate({ kpId: 'g3b-div-1digit', count: 20, difficultyMode: 'mixed', random: seeded(501) });
    for (const q of exact) {
      const [n1, n2] = numsOf(q.expression);
      assert.equal(n1 % n2, 0, `应整除 ${q.expression}`);
      assert.equal(q.answer, n1 / n2, `答案应等于商 ${q.expression}`);
    }
    const rem = generate({ kpId: 'g2b-div-remainder', count: 20, difficultyMode: 'mixed', random: seeded(502) });
    for (const q of rem) {
      const [n1, n2] = numsOf(q.expression);
      assert.ok(n1 % n2 >= 1 && n1 % n2 < n2, `余数应在 [1,除数-1] ${q.expression}`);
    }
  });

  test('R5 减法非负：全部减法题被减数 ≥ 减数', () => {
    const paper = generate({ kpId: 'g3a-add-sub-3digit', count: 30, difficultyMode: 'mixed', random: seeded(503) });
    for (const q of paper) {
      if (/^\d+-\d+=/.test(q.expression)) {
        const { n1, n2 } = twoNum(q.expression);
        assert.ok(n1 >= n2, q.expression);
      }
    }
  });

  test('R6 填空呈现：blankPos 落 a/b/result、blankAnswer 与空位一致、可判分', () => {
    const paper = generate({ kpId: 'g1a-add-carry-20', count: 30, difficultyMode: 'mixed', presentMode: 'blank', random: seeded(601) });
    const posCount = { a: 0, b: 0, result: 0 };
    for (const q of paper) {
      assert.equal(q.presentMode, 'blank');
      assert.ok(['a', 'b', 'result'].includes(q.blankPos), `blankPos 非法 ${q.blankPos}`);
      posCount[q.blankPos]++;
      if (q.blankPos === 'result') {
        assert.equal(String(q.blankAnswer), String(q.answer), '结果位空位答案应为题目答案');
      } else {
        // 操作数位挖空：把空位填回 blankAnswer 后再解析
        const filled = String(q.expression).replace('□', q.blankAnswer);
        const { n1, n2 } = twoNum(filled);
        assert.equal(String(q.blankAnswer), String(q.blankPos === 'a' ? n1 : n2), '空位答案应为对应操作数');
      }
      assert.equal(judge(q, String(q.blankAnswer)), true, `填空应能按空位判分 ${q.expression}`);
    }
    assert.ok(posCount.result >= 1 && posCount.a + posCount.b >= 1, '空位位置应覆盖结果位与操作数位');
  });

  test('R6 填空呈现：26 知识点 blank 模式 260 题全部可按空位判分', () => {
    const n = eachPaper(10, 'blank', 'mixed');
    assert.equal(n, 260);
    // 每道题再独立复判一次（eachPaper 只查范围，这里查判分闭环）
    let judged = 0;
    for (const kp of KPS) {
      const paper = generate({ kpId: kp.id, count: 10, difficultyMode: 'mixed', presentMode: 'blank', random: seeded(602) });
      for (const q of paper) {
        assert.equal(judge(q, String(getCorrectAnswer(q))), true, `[${kp.id}] ${q.expression}`);
        judged++;
      }
    }
    assert.equal(judged, 260);
  });

  test('参数校验：错误统一返回 {ok:false, message}（2.4 约定第 4 条）', () => {
    assert.equal(generate({ kpId: 'no-such-kp' }).ok, false);
    assert.equal(generate({ kpId: 'g1a-add-carry-20', count: 0 }).ok, false);
    assert.equal(generate({ kpId: 'g1a-add-carry-20', count: 101 }).ok, false);
    assert.equal(generate({ kpId: 'g1a-add-carry-20', count: 1.5 }).ok, false);
    assert.equal(generate({ kpId: 'g1a-add-carry-20', difficultyMode: 'hard' }).ok, false);
    assert.equal(generate({ kpId: 'g1a-add-carry-20', semester: '一下' }).ok, false);
  });

  test('listKnowledgePoints：全量 26 个 + 按学期过滤', () => {
    assert.equal(listKnowledgePoints().length, 26);
    const g1a = listKnowledgePoints('一上');
    assert.deepEqual(g1a.map((k) => k.id).sort(), ['g1a-add-carry-20', 'g1a-add-sub-10', 'g1a-clock-order', 'g1a-picture-calc']);
    assert.ok(listKnowledgePoints().every((k) => k.id && k.name && k.semester && k.op && k.basicRules && k.advanceRules), '知识点配置字段完整');
  });
});

// ================= 3.3.3 判题正确性 =================
describe('judge（3.3.3 判题）', () => {
  test('算式式：整数比较（前导零/空白等价）', () => {
    assert.equal(judge({ answer: 7 }, '7'), true);
    assert.equal(judge({ answer: 7 }, '007'), true);
    assert.equal(judge({ answer: 7 }, ' 7 '), true);
    assert.equal(judge({ answer: 7 }, '8'), false);
    assert.equal(judge({ answer: 7 }, '7.0'), false);  // 口算答案不做小数比较
    assert.equal(judge({ answer: 7 }, 'abc'), false);
  });
  test('空输入一律判错（防空串转 0 误判）', () => {
    assert.equal(judge({ answer: 0 }, ''), false);
    assert.equal(judge({ answer: 0 }, '   '), false);
    assert.equal(judge({ answer: 0 }, null), false);
    assert.equal(judge({ answer: 0 }, undefined), false);
  });
  test('字符串答案：有余数除法（规范化去空白）', () => {
    assert.equal(judge({ answer: '5余2' }, '5余2'), true);
    assert.equal(judge({ answer: '5余2' }, '5 余 2'), true);
    assert.equal(judge({ answer: '5余2' }, '5余3'), false);
  });
  test('字符串答案：分数', () => {
    assert.equal(judge({ answer: '3/4' }, '3/4'), true);
    assert.equal(judge({ answer: '3/4' }, ' 3/4 '), true);
    assert.equal(judge({ answer: '3/4' }, '4/3'), false);
  });
  test('填空式：数值空位整数比较，字符串空位精确比较', () => {
    assert.equal(judge({ presentMode: 'blank', blankAnswer: 7 }, '007'), true);
    assert.equal(judge({ presentMode: 'blank', blankAnswer: 7 }, '8'), false);
    assert.equal(judge({ presentMode: 'blank', blankAnswer: '5余2' }, '5余2'), true);
    assert.equal(judge({ presentMode: 'blank', blankAnswer: '5余2' }, '5 余 2'), false);
  });
  test('getCorrectAnswer：填空式返回空位对应值', () => {
    assert.equal(getCorrectAnswer({ answer: 15, presentMode: 'normal' }), 15);
    assert.equal(getCorrectAnswer({ answer: 15, presentMode: 'blank', blankPos: 'result', blankAnswer: 15 }), 15);
    assert.equal(getCorrectAnswer({ answer: 15, presentMode: 'blank', blankPos: 'a', blankAnswer: 7 }), 7);
  });
});

describe('PracticeSession（3.3.3 会话状态机，M2 接口）', () => {
  const makePaper = () => generate({ kpId: 'g1a-add-carry-20', count: 4, difficultyMode: 'mixed', random: seeded(701) });

  test('submit：逐题判分，未知题返回 {ok:false}', () => {
    const [q1, q2] = makePaper();
    const s = new PracticeSession([q1, q2]);
    assert.deepEqual(s.submit(q1.id, q1.answer), { correct: true, correctAnswer: q1.answer });
    assert.equal(s.submit(q2.id, '0').correct, false);
    assert.equal(s.submit('nope', '1').ok, false);
  });

  test('submit：重复提交幂等（返回首次判分结果）', () => {
    const [q1] = makePaper();
    const s = new PracticeSession([q1]);
    s.submit(q1.id, '999');
    const again = s.submit(q1.id, q1.answer); // 第二次答对不改变结果
    assert.equal(again.correct, false);
  });

  test('finish：得分/正确率/用时/错题列表（未答按错计）', () => {
    let t = 1000;
    const paper = makePaper();
    const s = new PracticeSession(paper, { now: () => t });
    s.submit(paper[0].id, paper[0].answer);
    s.submit(paper[1].id, paper[1].answer);
    s.submit(paper[2].id, '0'); // 答错
    // paper[3] 漏答
    t += 25000; // 25 秒（now 单位为毫秒）
    const r = s.finish();
    assert.equal(r.total, 4);
    assert.equal(r.answered, 3);
    assert.equal(r.correctCount, 2);
    assert.equal(r.score, 50); // 百分制 round(2/4×100)
    assert.equal(r.accuracy, 0.5);
    assert.equal(r.durationSeconds, 25);
    assert.equal(r.wrongQuestions.length, 2);
    const missed = r.wrongQuestions.find((w) => w.question.id === paper[3].id);
    assert.equal(missed.userAnswer, null, '漏答标记 userAnswer=null');
    assert.equal(r.detail.length, 4);
    assert.equal(r.detail.filter((d) => d.correct).length, 2);
  });

  test('finish：空卷安全（total=0 不得分为 NaN）', () => {
    const r = new PracticeSession([]).finish();
    assert.equal(r.total, 0);
    assert.equal(r.score, 0);
    assert.equal(r.accuracy, 0);
  });
});
