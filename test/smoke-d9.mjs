// 冒烟：模拟 D9 打印页链路（core/printer 排版分页 + 打印页出题逻辑）
import { layoutPaper, renderPageToCanvas } from '../src/core/printer.js';
import { generate, listKnowledgePoints } from '../src/core/generator.js';

// ============ printer.layoutPaper（2.4 M5 排版纯逻辑） ============
const fakeQ = (i) => ({ id: 'q' + i, kpId: 'k', expression: `${i}+1`, answer: String(i + 1), difficulty: 'basic', source: 'normal', presentMode: 'direct' });
const paper30 = Array.from({ length: 30 }, (_, i) => fakeQ(i));

// 30 题 → 题目 1 页；withAnswer → 题目+答案 2 页
const p1 = layoutPaper(paper30, false);
if (p1.pages.length !== 1 || p1.pages[0].kind !== 'q' || p1.pages[0].questions.length !== 30) {
  console.error('FAIL 30 题排版错误', p1.pages.length);
  process.exit(1);
}
const p2 = layoutPaper(paper30, true);
if (p2.pages.length !== 2 || p2.pages[0].kind !== 'q' || p2.pages[1].kind !== 'a') {
  console.error('FAIL 答案页未追加');
  process.exit(1);
}
// 60 题 → 每页 30 共 2 页；答案页开启共 4 页（原型同款页码）
const p3 = layoutPaper(Array.from({ length: 60 }, (_, i) => fakeQ(i)), true);
if (p3.pages.length !== 4 || p3.pages[1].questions.length !== 30) {
  console.error('FAIL 60 题分页错误', p3.pages.length);
  process.exit(1);
}
// 分页页码（答案页跟随对应题目页页码，共 2 页）
if (p3.pages[0].pageIndex !== 1 || p3.pages[1].pageIndex !== 1 || p3.pages[2].pageIndex !== 2 || p3.pages[1].pageCount !== 2) {
  console.error('FAIL 页码错误', p3.pages.map((p) => p.pageIndex));
  process.exit(1);
}
// columns/spaced 透传 + 空卷出 1 个空页（不崩）
const p4 = layoutPaper(paper30, false, { columns: 2, spaced: true, title: '口算练习 · 二年级上', sub: '表内乘法' });
if (p4.pages[0].cols !== 2 || !p4.pages[0].spaced || p4.pages[0].title !== '口算练习 · 二年级上') {
  console.error('FAIL 选项透传错误', p4.pages[0]);
  process.exit(1);
}
if (layoutPaper([], false).pages.length !== 1) {
  console.error('FAIL 空卷未出占位页');
  process.exit(1);
}
// renderPageToCanvas 在 Node 环境应明确抛错（生成走浏览器 canvas）
let threw = false;
try {
  renderPageToCanvas(p1.pages[0]);
} catch (e) {
  threw = /浏览器环境/.test(e.message);
}
if (!threw) {
  console.error('FAIL Node 环境未拒绝 canvas 渲染');
  process.exit(1);
}
console.log('printer.layoutPaper OK：30→1 页、60→2 页、答案页追加（共 4 页）、选项透传、Node 环境防护');

// ============ 打印页出题链路（Print.makePaper 同款分摊+轮转） ============
function makePaper(term, count) {
  const kps = listKnowledgePoints(term);
  if (kps.length === 0) {
    return [];
  }
  const n = kps.length;
  const perKp = Math.floor(count / n);
  const extra = count % n;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const c = perKp + (i < extra ? 1 : 0);
    if (c < 1) {
      continue;
    }
    const out = generate({ kpId: kps[i].id, semester: term, count: c, difficultyMode: 'mixed' });
    if (!Array.isArray(out)) {
      console.error('FAIL 打印出题失败', kps[i].id, out);
      process.exit(1);
    }
    parts.push(out);
  }
  const merged = [];
  const maxLen = Math.max(0, ...parts.map((p) => p.length));
  for (let i = 0; i < maxLen; i++) {
    for (const p of parts) {
      if (i < p.length) {
        merged.push(p[i]);
      }
    }
  }
  return merged.slice(0, count);
}
// 二年级上：30 与 60 题都要足量；轮转合并保证相邻题来自不同知识点（均匀分布）
for (const count of [30, 60]) {
  const paper = makePaper('二上', count);
  if (paper.length !== count) {
    console.error('FAIL 打印题量不足', count, paper.length);
    process.exit(1);
  }
  let adjSame = 0;
  for (let i = 1; i < paper.length; i++) {
    if (paper[i].kpId === paper[i - 1].kpId) {
      adjSame++;
    }
  }
  if (adjSame > paper.length / 2) {
    console.error('FAIL 轮转合并未均匀分布', count, adjSame);
    process.exit(1);
  }
}
console.log('打印页出题链路 OK：二上 30/60 题足量、知识点轮转均匀');

// ============ M1 semester 参数契约（防 Setup 把档案短值 semShort 传给 generate 的回归） ============
// 知识点配置 semester 为 6 学期全称（3.2.1(5)），档案 semester 为「上/下」（3.2.1(1)），
// 两者格式不同：generate 的 semester 必须传全称，短值按设计被拒绝
const kps3 = listKnowledgePoints('三下');
const badTerm = generate({ kpId: kps3[0].id, semester: '下', count: 10, difficultyMode: 'mixed' });
if (badTerm.ok !== false) {
  console.error('FAIL 短值学期未被拒绝（M1 semester 参数应为学期全称）');
  process.exit(1);
}
const goodTerm = generate({ kpId: kps3[0].id, semester: '三下', count: 10, difficultyMode: 'mixed' });
if (!Array.isArray(goodTerm) || goodTerm.length !== 10) {
  console.error('FAIL 全称学期出题失败');
  process.exit(1);
}
console.log('M1 semester 契约 OK：全称学期（如 三下）出题成功、短值（下）按设计拒绝');
console.log('D9 冒烟全部通过');
