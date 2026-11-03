/**
 * printer.js —— 打印服务 Printer（设计报告 2.4 M5、3.1，对应任务 D9）
 *
 * 接口（设计报告 2.4 M5）：printer.generatePdf(paper, withAnswer) → PDF
 *   A4 题纸 + 可选答案页；页面层负责 doc.save() 与文件名。
 *
 * 技术方案（2.2 技术选型 jsPDF + 一致性说明）：
 * - 排版数据（layoutPaper）：纯逻辑，Node 可测（C7）；
 * - PDF 生成（generatePdf）：jsPDF 组页。jsPDF 内置 14 种标准字体不含中文
 *   字形（页眉「口算练习」、页脚「口算天天练」等），嵌入中文字体文件体积
 *   过大，故每页内容由浏览器 canvas 按 A4 3 倍分辨率渲染成位图后写入 PDF
 *   （约 225dpi，保证打印清晰；本应用纯离线，无服务端渲染条件）；
 * - 题目表达式为纯 ASCII/算式符号，但为统一排版与填空形式（□）支持，
 *   页面渲染统一走 canvas，不混用 jsPDF 文本 API。
 *
 * 分页规则（原型 P7 同款）：每页 30 题，超出自动分页；
 * 60 题 → 题目 2 页，开启答案页后共 4 页。
 */

import { jsPDF } from 'jspdf';

/** A4 尺寸（pt）与渲染倍率（3x ≈ 225dpi，打印清晰） */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const SCALE = 3;

/** 每页题数（原型 30 题 / 页） */
const PER_PAGE = 30;

/**
 * layoutPaper(paper, withAnswer, options) → 排版数据（纯逻辑，可测）
 * @param {Array}  paper  题目快照数组（3.2.1 题目快照形状）
 * @param {boolean} withAnswer 是否追加答案页（2.4 M5 入参）
 * @param {object} options { columns:2|3, spaced:bool, title, sub }（页面层扩展）
 * @returns { pages: [{ kind:'q'|'a', title, sub, questions, pageIndex, pageCount }] }
 *   每页 questions ≤ PER_PAGE；kind='a' 的答案页与题目页一一对应。
 */
export function layoutPaper(paper, withAnswer, options = {}) {
  const cols = options.columns === 2 ? 2 : 3;
  const spaced = !!options.spaced;
  const list = Array.isArray(paper) ? paper : [];
  const chunked = [];
  for (let i = 0; i < list.length; i += PER_PAGE) {
    chunked.push(list.slice(i, i + PER_PAGE));
  }
  if (chunked.length === 0) {
    chunked.push([]);
  }
  const pages = [];
  chunked.forEach((qs, i) => {
    const pageIndex = i + 1;
    const pageCount = chunked.length;
    pages.push({
      kind: 'q',
      title: options.title || '口算练习',
      sub: options.sub || '',
      questions: qs,
      cols,
      spaced,
      pageIndex,
      pageCount,
    });
    if (withAnswer) {
      pages.push({
        kind: 'a',
        title: '参考答案（家长核对用）',
        sub: options.sub || '',
        questions: qs,
        cols,
        spaced,
        pageIndex,
        pageCount,
      });
    }
  });
  return { pages, total: list.length };
}

/**
 * renderPageToCanvas(page) → HTMLCanvasElement（浏览器环境）
 * 按 A4 ×SCALE 画单页（页眉/题号网格/页脚），canvas 用系统字体渲染中文。
 */
export function renderPageToCanvas(page) {
  if (typeof document === 'undefined') {
    throw new Error('renderPageToCanvas 需要浏览器环境（Node 测试请用 layoutPaper）');
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(PAGE_W * SCALE);
  canvas.height = Math.round(PAGE_H * SCALE);
  const ctx = canvas.getContext('2d');
  const s = SCALE;
  const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const marginX = 40;
  const topY = 46;
  const bodyBottom = PAGE_H - 46;

  // ---- 页眉 ----
  ctx.fillStyle = '#3a2c24';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${13 * s}px ${FONT}`;
  ctx.fillText(page.title, marginX * s, (topY + 13) * s);
  ctx.font = `400 ${8.5 * s}px ${FONT}`;
  ctx.fillStyle = '#a99079';
  const sub = page.sub ? `${page.sub} · 共 ${page.questions.length} 题` : `共 ${page.questions.length} 题`;
  ctx.fillText(sub, marginX * s, (topY + 28) * s);

  // 姓名/日期/得分（右上角）
  ctx.fillStyle = '#8b7565';
  ctx.font = `400 ${8.5 * s}px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('姓名：__________', (PAGE_W - marginX) * s, (topY + 13) * s);
  ctx.fillText('日期：____ 月 ____ 日　得分：____', (PAGE_W - marginX) * s, (topY + 28) * s);
  ctx.textAlign = 'left';

  // 分隔虚线
  ctx.strokeStyle = '#e6d8c8';
  ctx.setLineDash([4 * s, 3 * s]);
  ctx.beginPath();
  ctx.moveTo(marginX * s, (topY + 38) * s);
  ctx.lineTo((PAGE_W - marginX) * s, (topY + 38) * s);
  ctx.stroke();
  ctx.setLineDash([]);

  // ---- 题目网格 ----
  const qs = page.questions;
  const bodyW = PAGE_W - marginX * 2;
  const colW = bodyW / page.cols;
  const rowH = page.spaced ? 64 : 42; // 带竖式空格：行距加大留竖式书写位
  const numW = 18;
  const qFont = 13;
  ctx.font = `400 ${qFont * s}px ${FONT}`;

  for (let i = 0; i < qs.length; i++) {
    const col = i % page.cols;
    const row = Math.floor(i / page.cols);
    const x = marginX + col * colW;
    const y = topY + 50 + row * rowH;
    const q = qs[i];
    ctx.textBaseline = 'alphabetic';
    // 题号
    ctx.fillStyle = '#b6a190';
    ctx.font = `400 ${(qFont - 2) * s}px ${FONT}`;
    ctx.fillText(`${i + 1}.`, (x + numW - 4) * s, (y + qFont) * s);
    // 表达式 + 空（填空形式 □ 原样保留）
    ctx.fillStyle = '#3a2c24';
    ctx.font = `400 ${qFont * s}px ${FONT}`;
    const expr = (q.expression ?? '') + ' ＝';
    ctx.fillText(expr, (x + numW) * s, (y + qFont) * s);
    // 答题下划线（含竖式空格时画整行空白区）
    if (page.kind === 'q') {
      const lineY = (y + qFont + 6) * s;
      ctx.strokeStyle = '#d8c9b8';
      ctx.lineWidth = s * 0.8;
      ctx.beginPath();
      ctx.moveTo((x + numW) * s, lineY);
      ctx.lineTo((x + colW - 6) * s, lineY);
      ctx.stroke();
    } else {
      // 答案页：橙色加粗答案
      ctx.fillStyle = '#e9824c';
      ctx.font = `700 ${qFont * s}px ${FONT}`;
      const ans = String(q.presentMode === 'blank' ? q.blankAnswer : q.answer);
      ctx.fillText(` ${ans}`, (x + numW + ctx.measureText(expr).width) * s, (y + qFont) * s);
    }
  }

  // ---- 页脚 ----
  const footY = bodyBottom;
  ctx.strokeStyle = '#e6d8c8';
  ctx.setLineDash([4 * s, 3 * s]);
  ctx.beginPath();
  ctx.moveTo(marginX * s, footY * s);
  ctx.lineTo((PAGE_W - marginX) * s, footY * s);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#b6a190';
  ctx.font = `400 ${7.5 * s}px ${FONT}`;
  ctx.fillText('口算天天练 · 家长陪伴版', marginX * s, (footY + 16) * s);
  ctx.textAlign = 'right';
  ctx.fillText(`第 ${page.pageIndex} 页 / 共 ${page.pageCount} 页`, (PAGE_W - marginX) * s, (footY + 16) * s);
  ctx.textAlign = 'left';

  return canvas;
}

/**
 * generatePdf(paper, withAnswer, options) → jsPDF 实例（设计报告 2.4 M5）
 * 页面层调用 doc.save() 保存；canvas 位图入 PDF（见文件头技术方案说明）。
 * @param {object} options { columns, spaced, title, sub }（页面层扩展）
 */
export function generatePdf(paper, withAnswer, options = {}) {
  const { pages } = layoutPaper(paper, withAnswer, options);
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  pages.forEach((page, i) => {
    if (i > 0) {
      doc.addPage();
    }
    const canvas = renderPageToCanvas(page);
    const img = canvas.toDataURL('image/jpeg', 0.92);
    doc.addImage(img, 'JPEG', 0, 0, PAGE_W, PAGE_H);
  });
  return doc;
}
