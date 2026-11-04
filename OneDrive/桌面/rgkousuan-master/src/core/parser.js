/**
 * parser.js —— 表达式求值器与题目校验器（设计报告 3.3.2，对应任务 C3）
 *
 * 设计依据：
 * - 自实现递归下降解析器，仅支持整数四则运算与优先级，不依赖 eval（设计决策 D3）；
 * - 所有数学运算使用整数，禁止浮点参与计算与比较（NFR-01、2.4 接口约定第 2 条）；
 * - 校验器 validate：每道题生成后用 evaluate 独立复算，与存储的 answer 比对（R5）。
 *
 * 文法（设计报告 3.3.2）：
 *   parseExpression()  → 处理 + -
 *   parseTerm()        → 处理 × ÷（优先级高于加减）
 *   parseFactor()      → 处理数字 / 括号（括号为「混合运算（带括号）」知识点所需扩展）
 */
/** 词法分析：把表达式拆成 token 序列（数字、+、-、×、÷、括号；空格与等号忽略） */
export function tokenize(expr) {
  const tokens = [];
  const s = String(expr).replace(/\s+/g, '').replace(/=/g, '');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (i < s.length && s[i] >= '0' && s[i] <= '9') {
        num += s[i];
        i++;
      }
      tokens.push({ type: 'num', value: parseInt(num, 10) });
      continue;
    }
    if (ch === '+') { tokens.push({ type: 'op', value: '+' }); i++; continue; }
    if (ch === '-' || ch === '−') { tokens.push({ type: 'op', value: '-' }); i++; continue; }
    if (ch === '×' || ch === '*') { tokens.push({ type: 'op', value: '×' }); i++; continue; }
    if (ch === '÷' || ch === '/') { tokens.push({ type: 'op', value: '÷' }); i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lp' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rp' }); i++; continue; }
    throw new Error('表达式含非法字符: ' + ch);
  }
  return tokens;
}

/** 递归下降：expression = term { ('+' | '-') term } */
export function parseExpression(tokens, pos = 0) {
  let [left, p] = parseTerm(tokens, pos);
  while (p < tokens.length && tokens[p].type === 'op' && (tokens[p].value === '+' || tokens[p].value === '-')) {
    const op = tokens[p].value;
    const [right, q] = parseTerm(tokens, p + 1);
    left = op === '+' ? left + right : left - right;
    p = q;
  }
  return [left, p];
}

/** 递归下降：term = factor { ('×' | '÷') factor }（优先级高于加减） */
function parseTerm(tokens, pos = 0) {
  let [left, p] = parseFactor(tokens, pos);
  while (p < tokens.length && tokens[p].type === 'op' && (tokens[p].value === '×' || tokens[p].value === '÷')) {
    const op = tokens[p].value;
    const [right, q] = parseFactor(tokens, p + 1);
    if (op === '×') {
      left = left * right;
    } else {
      // 整数除法：生成侧保证整除（div-exact-step），这里截断仅是兜底，结果仍是整数
      left = Math.trunc(left / right);
    }
    p = q;
  }
  return [left, p];
}

/** 递归下降：factor = 数字 | '(' expression ')' */
function parseFactor(tokens, pos = 0) {
  const t = tokens[pos];
  if (!t) {
    throw new Error('表达式不完整');
  }
  if (t.type === 'num') {
    return [t.value, pos + 1];
  }
  if (t.type === 'lp') {
    const [value, p] = parseExpression(tokens, pos + 1);
    if (p >= tokens.length || tokens[p].type !== 'rp') {
      throw new Error('括号不匹配');
    }
    return [value, p + 1];
  }
  throw new Error('意外的 token: ' + JSON.stringify(t));
}

/**
 * evaluate(expr) —— 求值入口（设计报告 3.3.2）
 * 输入如 "7+8="、"2×(3+4)="，输出整数结果；无法解析时抛出异常。
 */
export function evaluate(expr) {
  const tokens = tokenize(expr);
  if (tokens.length === 0) {
    throw new Error('表达式为空');
  }
  const [value, p] = parseExpression(tokens, 0);
  if (p !== tokens.length) {
    throw new Error('表达式存在多余 token');
  }
  return value;
}

/**
 * validate(expression, answer) —— 校验器（R5「生成即复算」）
 * 用 evaluate 独立复算表达式，与存储答案做整数比较。
 */
export function validate(expression, answer) {
  try {
    return evaluate(expression) === answer;
  } catch {
    return false;
  }
}

/**
 * normalizeExpr —— 表达式规范化字符串（设计报告 3.3.1 防重复 R2）
 * 例：" 7+8= " → "7+8"；统一减号写法。用于本卷去重 Set 与近 3 次快照比对。
 */
export function normalizeExpr(expr) {
  return String(expr)
    .replace(/\s+/g, '')
    .replace(/=$/, '')
    .replace(/−/g, '-');
}
