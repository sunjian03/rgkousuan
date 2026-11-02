/**
 * helpers.js —— 单元测试公共工具（不被 node --test 自动执行）
 * - seeded：种子伪随机（LCG），保证测试可复现
 * - makeRepo：内存假 Repository（save/load 契约同 C6 Repository）
 * - makeQuestion：构造题目快照（错题本/统计测试输入用）
 */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function makeRepo() {
  const store = new Map(); // type__id → entity
  return {
    save(type, entity) {
      store.set(type + '__' + entity._id, entity);
    },
    load(type, id) {
      if (id != null) {
        return store.get(type + '__' + id) ?? null;
      }
      return [...store.entries()]
        .filter(([k]) => k.startsWith(type + '__'))
        .map(([, v]) => v);
    },
    _store: store,
  };
}

/** 构造题目快照（id 缺省自增） */
export function makeQuestion(id, kpId = 'g1a-add-carry-20', extra = {}) {
  return {
    id,
    kpId,
    difficulty: 'basic',
    source: 'new',
    presentMode: 'normal',
    expression: `${id}+1=`,
    answer: Number(id) + 1,
    ...extra,
  };
}

/** 构造 SessionResult（PracticeSession.finish() 同构） */
export function makeSessionResult({ correct = [], wrong = [], durationSeconds = 60 } = {}) {
  const detail = [
    ...correct.map((q) => ({ question: q, correct: true, userAnswer: String(q.answer), answered: true })),
    ...wrong.map((q) => ({ question: q, correct: false, userAnswer: '0', answered: true })),
  ];
  const total = detail.length;
  const correctCount = correct.length;
  return {
    total,
    answered: total,
    correctCount,
    score: total === 0 ? 0 : Math.round((correctCount / total) * 100),
    accuracy: total === 0 ? 0 : correctCount / total,
    durationSeconds,
    wrongQuestions: wrong.map((q) => ({ question: q, userAnswer: '0', correctAnswer: q.answer })),
    detail,
  };
}
