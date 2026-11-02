/**
 * repository.js —— 数据仓库 Repository（设计报告 3.1 / 3.4，对应任务 C6）
 *
 * 定位：数据访问门面（3.1 Repository「封装 localStorage 读写与 JSON 导出/导入，
 * 对上层屏蔽存储细节」），核心层唯一数据出入口（2.4 数据接口：页面只允许通过
 * 本模块读写数据）；无后端、无账号体系，数据全程在浏览器 localStorage（3.4）。
 *
 * 存储布局（3.2.1 五类实体 + 2 个缓存；键前缀 ksl_＝口算练，为约定实现决策，
 * 设计报告 3.4 未规定具体前缀名）：
 *   ksl_profiles          孩子档案集合（JSON 数组）
 *   ksl_practice_records  练习记录集合
 *   ksl_wrong_items       错题集合
 *   ksl_achievements      成就与打卡集合
 *   ksl_recent_papers     近 3 次练习快照（R2 去重；3.4：仅存本地，不随备份导出）
 *   ksl_session_draft     未完成练习草稿（NFR-06 离线中断恢复）
 * knowledge_points 是随版本发布的配置数据（3.2.1(5)、3.4 配置化更新），
 * 以 JSON 模块随代码发布，不入 localStorage。
 *
 * 接口（设计报告 2.4 数据接口）：
 *   save(type, entity)    实体 upsert（按 _id）
 *   load(type, id)        id 给定 → 单实体 | null；省略 id → 实体数组【扩展：
 *                         2.4 表未列省略 id 的形态，但 3.2.1 规定实体以集合保存、
 *                         服务层需全量遍历（如 3.3.5 按日期聚合），故约定省略 id
 *                         返回该类型全部实体（按写入顺序）】
 *   exportJson()          生成 JSON 备份文件内容（3.3.6：档案/记录/错题/成就）
 *   importJson(data)      校验格式后合并写入（3.3.6：校验恢复；FR-09 跨设备迁移）
 *   clear(type?)          FR-09 一键删除：type 省略清空全部，指定则记录级清除（3.4）
 *   辅助：saveRecentPapers / getRecentPapers（R2）、saveDraft / loadDraft / clearDraft（NFR-06）
 *
 * 错误约定（2.4 约定第 4 条 + 分层原则）：
 *   - 运行时数据错误（导入文件格式非法等）→ 返回 { ok:false, message }；
 *   - 调用方编程错误（type 不在白名单、entity 缺 _id 主键）→ 直接抛异常，
 *     与 C2~C5 一致（如 WrongBook 构造缺 Repository 也抛异常）。
 *
 * 存储后端可注入（2.4 约定第 1 条可测试性 + 3.4 离线）：
 *   默认浏览器 localStorage，读取/写入异常（隐私模式、配额满）自动降级为内存
 *   存储并在控制台警告——练习过程不因存储不可用而中断（NFR-06）；
 *   Node 环境（C7 单元测试）注入 MemoryStorage。后端契约与 localStorage 一致：
 *   getItem(key) / setItem(key, value) / removeItem(key)。
 */

/** 实体类型白名单（3.2.1 实体表名；knowledge_points 为配置，不在其中） */
export const ENTITY_TYPES = ['profiles', 'practice_records', 'wrong_items', 'achievements'];
/** 缓存结构白名单（3.2.1(6)） */
export const CACHE_TYPES = ['recent_papers', 'session_draft'];

const KEY_PREFIX = 'ksl_';
/** 备份数据包标识与结构版本（3.3.6；跨版本导入时按版本向前兼容） */
const APP_ID = 'rgkousuan';
const APP_NAME = '口算天天练';
const SCHEMA_VERSION = 1;
/** R2：仅比对近 3 次练习快照 */
const RECENT_PAPERS_LIMIT = 3;

/** 内存存储后端（Node 测试 / 浏览器降级用），契约与 localStorage 一致 */
export class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

export class Repository {
  /**
   * @param {object} storage   存储后端（契约同 localStorage）；缺省时浏览器用
   *                           localStorage，Node/测试环境自动用内存后端
   * @param {object} options   { now }：时间函数可注入（与 C2~C5 一致）
   */
  constructor(storage, options = {}) {
    this.storage =
      storage ||
      (typeof localStorage !== 'undefined' ? localStorage : new MemoryStorage());
    this.now = options.now || (() => Date.now());
  }

  /** localStorage 键：ksl_ + 类型名；type 不在白名单 → 抛异常（编程错误） */
  keyOf(type) {
    if (!ENTITY_TYPES.includes(type) && !CACHE_TYPES.includes(type)) {
      throw new Error('未知数据类型: ' + type + '（白名单见 ENTITY_TYPES / CACHE_TYPES）');
    }
    return KEY_PREFIX + type;
  }

  /** 读集合：损坏/缺失时返回默认值并告警，不中断练习（NFR-06） */
  _read(type) {
    const raw = this._readRaw(this.keyOf(type));
    if (raw == null) {
      return ENTITY_TYPES.includes(type) ? [] : {};
    }
    try {
      const value = JSON.parse(raw);
      if (ENTITY_TYPES.includes(type)) {
        return Array.isArray(value) ? value : [];
      }
      return value && typeof value === 'object' ? value : {};
    } catch {
      console.warn(`[repository] ${this.keyOf(type)} 数据损坏，已按空集合处理`);
      return ENTITY_TYPES.includes(type) ? [] : {};
    }
  }

  /** 写集合：配额满/隐私模式异常 → 降级内存并在控制台告警（NFR-06） */
  _write(type, value) {
    try {
      this.storage.setItem(this.keyOf(type), JSON.stringify(value));
    } catch (e) {
      console.warn(`[repository] 写入 ${this.keyOf(type)} 失败（${e.message}），本次数据仅存于内存`);
      if (!this._memFallback) {
        this._memFallback = new Map();
      }
      this._memFallback.set(this.keyOf(type), JSON.stringify(value));
    }
  }

  /** 降级内存参与读取：写入失败期间数据仍可读（storage 可用时优先 storage） */
  _readRaw(key) {
    const raw = this.storage.getItem(key);
    if (raw != null) {
      return raw;
    }
    return this._memFallback ? (this._memFallback.get(key) ?? null) : null;
  }

  /**
   * save(type, entity) —— 实体 upsert（设计报告 2.4 数据接口）
   * 按 entity._id 插入或覆盖；同一 _id 重复保存即更新（3.2.1 主键语义）。
   */
  save(type, entity) {
    if (!entity || typeof entity._id !== 'string' || entity._id === '') {
      throw new Error('save 需要带非空字符串主键 _id 的实体');
    }
    if (ENTITY_TYPES.includes(type)) {
      const list = this._read(type);
      const i = list.findIndex((x) => x._id === entity._id);
      if (i >= 0) {
        list[i] = entity;
      } else {
        list.push(entity);
      }
      this._write(type, list);
      return;
    }
    // 缓存结构（对象形态）：按需写入
    this._write(type, entity);
  }

  /**
   * load(type, id) —— 实体读取（设计报告 2.4 数据接口）
   * id 给定：返回该实体（无则 null）；省略 id：返回全部实体数组（见文件头扩展说明）。
   */
  load(type, id) {
    if (ENTITY_TYPES.includes(type)) {
      const list = this._read(type);
      if (id != null) {
        return list.find((x) => x._id === id) ?? null;
      }
      return list;
    }
    const cache = this._read(type);
    return id != null ? (cache[id] ?? null) : cache;
  }

  /** clear(type?) —— FR-09 一键删除（3.4 隐私与安全：记录级清除） */
  clear(type) {
    if (type != null) {
      this.storage.removeItem(this.keyOf(type));
      return;
    }
    for (const t of [...ENTITY_TYPES, ...CACHE_TYPES]) {
      this.storage.removeItem(KEY_PREFIX + t);
    }
  }

  // ------------------------------------------------------------------
  // 近 3 次练习快照（3.2.1(6) recent_papers，支撑 3.3.1 R2 去重）
  // 结构：{ [profileId]: [ [表达式,...], ... 最多 3 个快照 ] }
  // 每次练习完成由成绩页流程调用，超出 3 次滚动丢弃最旧快照。
  // ------------------------------------------------------------------

  /** saveRecentPapers(profileId, paper)：paper 为 Question[] 或表达式字符串数组 */
  saveRecentPapers(profileId, paper) {
    const all = this._read('recent_papers');
    const exprs = (Array.isArray(paper) ? paper : [paper]).map((q) =>
      typeof q === 'string' ? q : q.expression
    );
    const queue = all[profileId] || [];
    queue.push(exprs);
    while (queue.length > RECENT_PAPERS_LIMIT) {
      queue.shift();
    }
    all[profileId] = queue;
    this._write('recent_papers', all);
  }

  /** getRecentPapers(profileId) → [[...], ...]：直接喂给 generate({recentPapers}) */
  getRecentPapers(profileId) {
    return this._read('recent_papers')[profileId] || [];
  }

  // ------------------------------------------------------------------
  // 练习草稿（3.2.1(6) session_draft，支撑 NFR-06 离线中断恢复）
  // 结构：{ [profileId]: { paper, answers, startedAt } }
  // ------------------------------------------------------------------

  /** saveDraft(profileId, draft)：draft = { paper: Question[], answers, startedAt } */
  saveDraft(profileId, draft) {
    const all = this._read('session_draft');
    all[profileId] = { ...draft, savedAt: this.now() };
    this._write('session_draft', all);
  }

  /** loadDraft(profileId) → draft | null（无未完成草稿） */
  loadDraft(profileId) {
    return this._read('session_draft')[profileId] ?? null;
  }

  /** clearDraft(profileId)：练习完成/主动放弃后清除草稿 */
  clearDraft(profileId) {
    const all = this._read('session_draft');
    delete all[profileId];
    this._write('session_draft', all);
  }

  // ------------------------------------------------------------------
  // JSON 备份导出 / 导入（3.3.6 离线练习与数据备份，FR-09 跨设备迁移）
  // ------------------------------------------------------------------

  /**
   * exportJson() → string（设计报告 2.4 数据接口）
   * 备份包含 4 类实体（3.3.6 流程图：档案/练习记录/错题/成就）；2 个缓存仅存
   * 本地（3.4），不入备份。页面层负责 Blob 下载与文件命名（家长自行保管）。
   */
  exportJson() {
    const data = {};
    for (const t of ENTITY_TYPES) {
      data[t] = this._read(t);
    }
    return JSON.stringify({
      app: APP_ID,
      name: APP_NAME,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: this.now(),
      data,
    });
  }

  /**
   * importJson(data) → { ok:true, imported, skipped } | { ok:false, message }
   * （设计报告 2.4 数据接口；3.3.6：校验格式后写入，数据完整恢复）
   * - 校验：可解析 JSON、本应用标识、schemaVersion ≤ 当前版本、data 为四类数组；
   * - 合并写入：按 _id upsert（不整体覆盖）。跨设备迁移时目标设备通常为空，
   *   合并与覆盖等效；本地已有数据时合并更安全。如需「清空后恢复」，页面层
   *   可先调 clear() 再导入；
   * - 实体级容错：无 _id 主键的非法实体跳过并计数，不因个别脏数据整体失败。
   */
  importJson(data) {
    let obj = data;
    if (typeof data === 'string') {
      try {
        obj = JSON.parse(data);
      } catch {
        return { ok: false, message: '不是合法的 JSON 文件' };
      }
    }
    if (!obj || typeof obj !== 'object') {
      return { ok: false, message: '不是合法的备份文件' };
    }
    if (obj.app !== APP_ID) {
      return { ok: false, message: '不是本应用（口算天天练）的数据文件' };
    }
    if (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion > SCHEMA_VERSION) {
      return { ok: false, message: `数据版本 ${obj.schemaVersion} 高于当前支持版本 ${SCHEMA_VERSION}，请升级应用后导入` };
    }
    const pack = obj.data;
    if (!pack || typeof pack !== 'object') {
      return { ok: false, message: '备份文件缺少 data 数据段' };
    }
    for (const t of ENTITY_TYPES) {
      if (!Array.isArray(pack[t])) {
        return { ok: false, message: `数据段 ${t} 不是数组` };
      }
    }
    const imported = {};
    let skipped = 0;
    for (const t of ENTITY_TYPES) {
      const list = this._read(t);
      let n = 0;
      for (const entity of pack[t]) {
        if (!entity || typeof entity._id !== 'string' || entity._id === '') {
          skipped++;
          continue;
        }
        const i = list.findIndex((x) => x._id === entity._id);
        if (i >= 0) {
          list[i] = entity;
        } else {
          list.push(entity);
        }
        n++;
      }
      this._write(t, list);
      imported[t] = n;
    }
    return { ok: true, imported, skipped };
  }
}
