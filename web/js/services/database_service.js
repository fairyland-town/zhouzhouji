/**
 * database_service.js
 * 本地存储层。浏览器端使用 IndexedDB（等价于 03 文档的 SQLite 本地持久化）。
 *
 * 表结构（object store: events）与 03 文档 SQLite 表一致：
 *   id          INTEGER PRIMARY KEY AUTOINCREMENT  -> IndexedDB autoIncrement
 *   title       TEXT NOT NULL
 *   location    TEXT NOT NULL
 *   start_time  TEXT NOT NULL
 *   raw_text    TEXT
 *   created_at  TEXT NOT NULL
 *
 * 查询规则（03 文档第 7 节）：
 *   start_time >= weekStart  AND  start_time < nextWeekStart
 *   ORDER BY start_time ASC
 *
 * v1.3.0 新增三个 store（打卡与记账）：
 *   checkins      打卡项定义   id / title / created_at / archived
 *   checkin_logs  打卡记录     id / checkin_id / date(YYYY-MM-DD) / created_at
 *   ledger        记账流水     id / amount / direction / category / note / date / created_at
 *   kv            通用键值     key / value （存月度预算等设置）
 *
 * v1.4.0 新增一个 store（待办：任务 / 想要）：
 *   todos         待办事项     id / title / kind(task|want) / done / due / done_at / created_at / sort
 *
 * v1.5.0 新增一个 store（账户余额对账）：
 *   accounts      账户         id / name / type / balance_mode / opening / opening_date
 *                              / entries(充值消费流水) / checkpoints(对账快照) / archived / note / created_at
 * 升级走 onupgradeneeded，只新增缺失的 store，旧数据不受影响。
 */

import { Event } from '../models/event.js';
import { startOfWeek, startOfNextWeek, formatDateTime } from '../utils/date_utils.js';

const DB_NAME = 'campus_week_calendar';
const DB_VERSION = 4;
const STORE = 'events';
const STORE_CHECKINS = 'checkins';
const STORE_CHECKIN_LOGS = 'checkin_logs';
const STORE_LEDGER = 'ledger';
const STORE_KV = 'kv';
const STORE_TODOS = 'todos';
const STORE_ACCOUNTS = 'accounts';

/**
 * 设置页「清空数据」可选的类别（v1.12.0）。
 *
 * ⚠️ `key` 同时是 `actionSheet` 的返回值，改 key 必须同步改 `settings_screen.js`。
 * ⚠️ 打卡是**两个 store**（打卡项 + 打卡记录），必须一起清 ——
 *    只清 `checkins` 会留下一堆没有归属的孤儿打卡记录，月完成率会算出乱数。
 */
const CLEAR_CATEGORIES = [
  { key: 'events', label: '活动', desc: '周历里的全部活动记录', stores: [STORE] },
  { key: 'checkins', label: '打卡', desc: '全部打卡项与打卡记录', stores: [STORE_CHECKINS, STORE_CHECKIN_LOGS] },
  { key: 'todos', label: '待办', desc: '任务与「想要」清单', stores: [STORE_TODOS] },
  { key: 'ledger', label: '记账', desc: '全部收支流水（含账户充值镜像）', stores: [STORE_LEDGER] },
  {
    key: 'accounts',
    label: '账户',
    desc: '全部账户与余额基准，以及资产总览里的借入借出 / 报销 / 黄金 / 定期',
    stores: [STORE_ACCOUNTS],
    /**
     * v1.13.0：资产总览那四类明细存在 kv 里（取舍理由见 models/asset.js 文件头）。
     * 必须跟着账户一起清 —— 否则账户清空了，借入/借出、黄金克重还挂在净资产上，
     * 用户会认为「清空没生效」。
     * ⚠️ 这些 key 与 models/asset.js 的 ASSET_KEYS 必须保持一致，改名要两边一起改。
     */
    kvKeys: ['cw_loans', 'cw_reimbursements', 'cw_gold', 'cw_gold_price', 'cw_deposits'],
  },
];

/**
 * v1.11.0 备份覆盖的全部 store。
 * 顺序 = 导入顺序，**有外键依赖的必须排在被依赖者之后**：
 *   checkin_logs.checkin_id → checkins.id
 *   ledger.accountId       → accounts.id
 *   ledger.accountEntryId  → accounts.entries[].id（字符串 id，原样保留即可）
 * events 排最后，因为它走 Event 模型校验（bulkAdd），与其余 raw 写入路径不同。
 */
const BACKUP_STORES = [
  { key: 'checkins', store: STORE_CHECKINS },
  { key: 'checkin_logs', store: STORE_CHECKIN_LOGS },
  { key: 'accounts', store: STORE_ACCOUNTS },
  { key: 'ledger', store: STORE_LEDGER },
  { key: 'todos', store: STORE_TODOS },
  { key: 'kv', store: STORE_KV },
  { key: 'events', store: STORE },
];

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion || 0;

      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('start_time', 'start_time', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
      }

      // ---- v2：打卡 ----
      if (!db.objectStoreNames.contains(STORE_CHECKINS)) {
        db.createObjectStore(STORE_CHECKINS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_CHECKIN_LOGS)) {
        const logs = db.createObjectStore(STORE_CHECKIN_LOGS, { keyPath: 'id', autoIncrement: true });
        logs.createIndex('checkin_id', 'checkin_id', { unique: false });
        // 同一个打卡项同一天只允许一条记录
        logs.createIndex('checkin_date', ['checkin_id', 'date'], { unique: true });
      }

      // ---- v2：记账 ----
      if (!db.objectStoreNames.contains(STORE_LEDGER)) {
        const led = db.createObjectStore(STORE_LEDGER, { keyPath: 'id', autoIncrement: true });
        led.createIndex('date', 'date', { unique: false });
      }

      // ---- v2：通用键值（月度预算等）----
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'key' });
      }

      // ---- v3：待办（任务 / 想要）----
      if (!db.objectStoreNames.contains(STORE_TODOS)) {
        const todos = db.createObjectStore(STORE_TODOS, { keyPath: 'id', autoIncrement: true });
        todos.createIndex('kind', 'kind', { unique: false });
        todos.createIndex('done', 'done', { unique: false });
      }

      // ---- v4：账户余额对账 ----
      if (!db.objectStoreNames.contains(STORE_ACCOUNTS)) {
        const acc = db.createObjectStore(STORE_ACCOUNTS, { keyPath: 'id', autoIncrement: true });
        acc.createIndex('type', 'type', { unique: false });
        acc.createIndex('archived', 'archived', { unique: false });
      }

      // 旧库升级时无需搬运数据：新功能从零开始，已有 store 原样保留
      void oldVersion;
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, storeName = STORE) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const DatabaseService = {
  /** 新增，返回新 id */
  async add(event) {
    const e = event instanceof Event ? event : new Event(event);
    const check = e.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    const rec = e.toRecord();
    delete rec.id; // autoIncrement 由数据库分配
    const store = await tx('readwrite');
    const id = await wrap(store.add(rec));
    return id;
  },

  /** 按 id 更新 */
  async update(event) {
    const e = event instanceof Event ? event : new Event(event);
    if (e.id == null) throw new Error('缺少 id，无法更新');
    const check = e.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    const store = await tx('readwrite');
    await wrap(store.put(e.toRecord()));
    return e.id;
  },

  /** 按 id 删除 */
  async remove(id) {
    const store = await tx('readwrite');
    await wrap(store.delete(Number(id)));
    return true;
  },

  async getById(id) {
    const store = await tx('readonly');
    const rec = await wrap(store.get(Number(id)));
    return Event.fromRecord(rec);
  },

  /** 全部活动，按 start_time 升序 */
  async getAll() {
    const store = await tx('readonly');
    const all = await wrap(store.getAll());
    return all.map((r) => Event.fromRecord(r)).filter(Boolean)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  },

  /**
   * 查询某周活动（03 文档第 7 节查询规则）
   * @param {Date|string} anyDayInWeek 该周任意一天
   */
  async getByWeek(anyDayInWeek) {
    const from = formatDateTime(startOfWeek(anyDayInWeek));
    const to = formatDateTime(startOfNextWeek(anyDayInWeek));
    // start_time 为 'YYYY-MM-DD HH:mm'，字典序即时间序，可直接比较
    const all = await this.getAll();
    return all.filter((e) => e.startTime >= from && e.startTime < to);
  },

  /** 某一天的活动 */
  async getByDay(date) {
    const all = await this.getAll();
    const ds = new Date(date);
    return all.filter((e) => {
      const d = e.startDate;
      return d.getFullYear() === ds.getFullYear()
        && d.getMonth() === ds.getMonth()
        && d.getDate() === ds.getDate();
    });
  },

  async count() {
    const store = await tx('readonly');
    return wrap(store.count());
  },

  /**
   * 是不是「一条记录都没有」。
   *
   * ⚠️ 别拿 count() 当空库判断 —— 它只数 `events` 那张表，
   *    「只打过卡、没记过活动」的用户会被误判成空库。
   *    这里按 BACKUP_STORES 逐表数，口径与备份一致。
   */
  async isEmpty() {
    for (const { store } of BACKUP_STORES) {
      const s = await tx('readonly', store);
      if ((await wrap(s.count())) > 0) return false;
    }
    return true;
  },

  async clear() {
    const store = await tx('readwrite');
    await wrap(store.clear());
  },

  /* ---------------- v1.12.0 分类清空（设置页「清空数据」） ---------------- */

  /**
   * 一个事务里清空多个 store。
   *
   * 用 `store.clear()` 而不是逐条 `delete`：后者在几千条记录时会很慢，
   * 而且中途失败会留下「清了一半」的状态 —— 同一个事务里要么全清、要么全不动。
   */
  async clearStores(names) {
    const list = [...new Set(names)];
    if (!list.length) return;
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction(list, 'readwrite');
      for (const n of list) t.objectStore(n).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('清空事务被中止'));
    });
  },

  /** 可清空的类别清单（顺序即设置页展示顺序），返回副本避免外部改到常量 */
  clearCategories() {
    return CLEAR_CATEGORIES.map((c) => ({
      ...c, stores: [...c.stores], kvKeys: [...(c.kvKeys || [])],
    }));
  },

  /** 某一类当前有多少条 —— 清空前要显示给用户看，避免「不知道删了多少」 */
  async countCategory(kind) {
    const spec = CLEAR_CATEGORIES.find((c) => c.key === kind);
    if (!spec) throw new Error('未知的数据类别：' + kind);
    const per = {};
    let total = 0;
    for (const s of spec.stores) {
      const store = await tx('readonly', s);
      const n = await wrap(store.count());
      per[s] = n;
      total += n;
    }
    // kv 里的条目按「数组长度」计，不是按 key 个数 ——
    // 用户关心的是「几笔借入借出 / 几笔报销」，不是「有几个键」。
    // ⚠️ 纯标量设置（如金价）**不计入条数**：它会被一起清掉，
    //    但把「一个金价」说成「1 条记录」会让清空提示的数字莫名其妙。
    for (const k of spec.kvKeys || []) {
      const rec = await this._get(STORE_KV, k);
      const v = rec ? rec.value : null;
      const n = Array.isArray(v) ? v.length : 0;
      per[`kv:${k}`] = n;
      total += n;
    }
    return { total, per };
  },

  /**
   * 清空某一类数据，返回清掉的条数。
   *
   * ⚠️ 清「账户」时必须连带清掉记账页里由账户**镜像**出来的流水。
   *    判定依据是 `accountId != null` —— 用户手记的流水 `accountId` 为 null，
   *    所以不会被误删。不清理的话，记账页会留下一批「· 来自账户 · 充值」
   *    但账户已经不存在的幽灵记录，也和 `AccountService.removeWithLedger` 的行为不一致。
   */
  async clearCategory(kind) {
    const spec = CLEAR_CATEGORIES.find((c) => c.key === kind);
    if (!spec) throw new Error('未知的数据类别：' + kind);

    const { total } = await this.countCategory(kind);

    if (kind === 'accounts') {
      const all = await this.getLedgerEntries();
      for (const e of all.filter((e) => e.accountId != null)) {
        await this.removeLedgerEntry(e.id);
      }
    }

    await this.clearStores(spec.stores);
    // kv 里的资产明细：整键删掉即可，getSetting 会兜底成空数组。
    // ⚠️ 用 removeSetting（字符串键），不能用 _remove（会把键转成 Number）
    for (const k of spec.kvKeys || []) await this.removeSetting(k);
    return total;
  },

  /**
   * 批量导入（JSON 备份还原）
   *
   * 🔴 必须走 `Event.fromRecord`，**不能**直接 `new Event(item)`。
   *    原因：备份文件里的字段是 snake_case（`start_time` / `raw_text` / `created_at`，
   *    与 SQLite 列名一致），而 Event 构造函数只认 camelCase（`startTime` / `rawText`）。
   *    直接用构造函数会让 startTime 变成空串 → validate() 失败 → 记录被静默丢弃。
   *
   *    v1.11.0 之前正是这么坏的：**「导出 JSON 备份」再「从 JSON 导入」，
   *    活动会全部消失且不报任何错**（toast 只显示「已导入 0 个活动」）。
   *    fromRecord 同时兼容 snake_case 与 camelCase，是唯一的正确入口。
   */
  async bulkAdd(events) {
    const store = await tx('readwrite');
    let n = 0;
    for (const item of events) {
      const e = item instanceof Event ? item : Event.fromRecord(item);
      if (!e || !e.validate().ok) continue;
      const rec = e.toRecord();
      delete rec.id;
      await wrap(store.add(rec));
      n++;
    }
    return n;
  },

  /**
   * 导出为 JSON 文本（v1.11.0 起覆盖全部 7 个 store）
   *
   * ⚠️ events 用 `toJSON()`（**不含 id**，保持 v1 格式兼容）；
   *    其余 6 个 store 用**原始记录**（**保留 id**）——
   *    因为 ledger.accountId / checkin_logs.checkin_id 是真外键，
   *    用 toJSON() 会丢 id 导致还原后关联断裂。
   *    （Account.toJSON() 故意不含 id，那是给「导入单个账户」用的，别混用。）
   */
  async exportJSON() {
    const all = await this.getAll();
    const counts = { events: all.length };

    const payload = {
      app: 'campus_week_calendar',
      version: 2,
      exported_at: formatDateTime(new Date()),
      counts,
      events: all.map((e) => e.toJSON()),
    };

    for (const { key, store } of BACKUP_STORES) {
      if (key === 'events') continue;
      const rows = await this._getAll(store);
      payload[key] = rows;
      counts[key] = rows.length;
    }

    payload.count = Object.values(counts).reduce((a, b) => a + b, 0);
    return JSON.stringify(payload, null, 2);
  },

  /**
   * 从 JSON 文本导入（v1.11.0 起覆盖全部 7 个 store）。
   *
   * 兼容三种历史形态：
   *   ① 纯数组              —— 最早期，只含活动
   *   ② `{ events: [...] }` —— v1（version 1），只含活动
   *   ③ 多表对象            —— v2（version 2），7 个 store 齐全
   *
   * 导入时**一律重新分配整数自增 id，并同步重映射外键**
   * （`checkin_logs.checkin_id`、`ledger.accountId`、**`accounts.entries[].linkedAccountId`**）。
   * 好处：合并两份来自不同设备的备份时不会 id 撞车；
   * 代价：导入后的 id 与原设备不同 —— 但外键关系完整，用户无感。
   * `accounts.entries[].id` 是字符串（`e<时间戳><序号>`），全局唯一，原样保留。
   *
   * @param {string} text
   * @param {{merge?: boolean}} opts `merge=true` 追加（默认）；`false` 先清空再还原
   * @returns {Promise<{counts: Record<string,number>, total: number, skipped: number}>}
   */
  async importJSON(text, { merge = true } = {}) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('文件不是合法的 JSON 格式');
    }

    let payload;
    if (Array.isArray(data)) payload = { events: data };
    else if (data && typeof data === 'object') payload = data;
    else throw new Error('无法识别的备份文件');

    const arr = (v) => (Array.isArray(v) ? v : []);
    const hasAny = BACKUP_STORES.some(({ key }) => arr(payload[key]).length > 0);
    if (!hasAny) throw new Error('备份文件里没有任何可导入的数据');

    if (!merge) {
      for (const { store } of BACKUP_STORES) await this._clear(store);
    }

    const counts = {};
    const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
    let skipped = 0;

    /* 1) 打卡项 —— 先建，供 checkin_logs 引用 */
    const checkinIdMap = new Map();
    for (const rec of arr(payload.checkins)) {
      if (!rec || typeof rec !== 'object') { skipped++; continue; }
      const { id, ...rest } = rec;
      try {
        const newId = await this._add(STORE_CHECKINS, rest);
        if (id != null) checkinIdMap.set(Number(id), newId);
        bump('checkins');
      } catch { skipped++; }
    }

    /* 2) 打卡记录 —— checkin_id 必须重映射；找不到归属的孤儿记录丢弃 */
    for (const rec of arr(payload.checkin_logs)) {
      if (!rec || typeof rec !== 'object') { skipped++; continue; }
      const mapped = checkinIdMap.get(Number(rec.checkin_id));
      if (mapped == null) { skipped++; continue; }
      const { id, ...rest } = rec;
      try {
        await this._add(STORE_CHECKIN_LOGS, { ...rest, checkin_id: mapped });
        bump('checkin_logs');
      } catch { skipped++; }   // 复合唯一索引冲突（同项同日）也算跳过
    }

    /* 3) 账户 —— entries[].id 是字符串，原样保留 */
    const acctIdMap = new Map();
    const addedAccounts = [];   // 第二遍补 linkedAccountId 要用
    for (const rec of arr(payload.accounts)) {
      if (!rec || typeof rec !== 'object') { skipped++; continue; }
      const { id, ...rest } = rec;
      try {
        const newId = await this._add(STORE_ACCOUNTS, rest);
        if (id != null) acctIdMap.set(Number(id), newId);
        addedAccounts.push({ newId, entries: rest.entries });
        bump('accounts');
      } catch { skipped++; }
    }

    /* 3b) 🔴 账户流水的 `linkedAccountId` 也要重映射 —— 它存的是**对方账户的整数 id**
     *
     *     上面刚把所有账户 id 重新分配过（`_add` 会 `delete rec.id` 让自增重新发号），
     *     可 `linkedAccountId` 里还是**旧 id**。后果不是「报错」，是**静默留半截账**：
     *     `AccountService.removeEntry()` 靠这个字段找对方那条流水一起撤，
     *     找不到就只删一半 —— 用户在 A 看到 +200，B 那边却没有对应的 −200，
     *     两边余额各自看着都「算得通」。
     *
     *     ⚠️ 必须等 `acctIdMap` 建完才能做，所以只能第二遍（不能塞进上面那个循环）。
     *     ⚠️ 实测：合并导入到非空库时 id 必然偏移（旧 1/2 → 新 4/5），
     *        这个坑 100% 会踩到，不是理论问题。
     *     🔴 **找不到对方时「保持原样」而不是清空** —— 和下面第 4 步「不留悬空指针」的
     *        做法**故意相反**。因为 `linkedAccountId` 同时是 `isTransferLeg()` 的唯一判据：
     *        清掉它，这条转账就会被当成「外部充值」重新算进累计充值 —— 正好又变成双计。
     *        留着旧 id 只是找不到对方（本来就找不到），但「这是转账」这个事实保住了。
     */
    for (const { newId, entries } of addedAccounts) {
      if (!Array.isArray(entries) || !entries.length) continue;
      let changed = false;
      const fixed = entries.map((e) => {
        if (!e || e.linkedAccountId == null) return e;
        const mapped = acctIdMap.get(Number(e.linkedAccountId));
        if (mapped == null || mapped === Number(e.linkedAccountId)) return e;
        changed = true;
        return { ...e, linkedAccountId: mapped };
      });
      if (!changed) continue;
      try {
        const stored = await this._get(STORE_ACCOUNTS, newId);
        if (stored) await this._put(STORE_ACCOUNTS, { ...stored, entries: fixed });
      } catch { /* 补映射失败不该让整次导入失败：账户已经导进来了 */ }
    }

    /* 4) 记账流水 —— accountId 重映射；找不到就断开关联，不留悬空指针 */
    for (const rec of arr(payload.ledger)) {
      if (!rec || typeof rec !== 'object') { skipped++; continue; }
      const { id, ...rest } = rec;
      if (rest.accountId != null) {
        const mapped = acctIdMap.get(Number(rest.accountId));
        if (mapped == null) { rest.accountId = null; rest.accountEntryId = null; }
        else rest.accountId = mapped;
      }
      try {
        await this._add(STORE_LEDGER, rest);
        bump('ledger');
      } catch { skipped++; }
    }

    /* 5) 待办 —— 无外键 */
    for (const rec of arr(payload.todos)) {
      if (!rec || typeof rec !== 'object') { skipped++; continue; }
      const { id, ...rest } = rec;
      try {
        await this._add(STORE_TODOS, rest);
        bump('todos');
      } catch { skipped++; }
    }

    /* 6) kv —— keyPath 是字符串 key，直接 put 覆盖 */
    for (const rec of arr(payload.kv)) {
      if (!rec || rec.key == null) { skipped++; continue; }
      try {
        await this._put(STORE_KV, rec);
        bump('kv');
      } catch { skipped++; }
    }

    /* 7) 活动 —— 沿用 Event 模型校验（bulkAdd 内部已跳过非法项） */
    counts.events = await this.bulkAdd(arr(payload.events));

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { counts, total, skipped };
  },

  /* ==========================================================
     v1.3.0 通用 CRUD —— 打卡 / 记账 / 键值三个 store 复用
     ========================================================== */

  async _add(storeName, record) {
    const store = await tx('readwrite', storeName);
    const rec = { ...record };
    delete rec.id;
    return wrap(store.add(rec));
  },

  async _put(storeName, record) {
    const store = await tx('readwrite', storeName);
    return wrap(store.put(record));
  },

  async _getAll(storeName) {
    const store = await tx('readonly', storeName);
    return wrap(store.getAll());
  },

  async _get(storeName, key) {
    const store = await tx('readonly', storeName);
    return wrap(store.get(key));
  },

  async _remove(storeName, id) {
    const store = await tx('readwrite', storeName);
    // ⚠️ 这里把 id 转成 Number，是因为 _remove 服务的是**自增主键**的 store
    //    （打卡 / 记账 / 待办 / 账户），调用方传进来的多是字符串形式的数字。
    // 🔴 kv 是**字符串主键**（keyPath: 'key'），绝不能走这条路 ——
    //    Number('cw_loans') 是 NaN，IndexedDB 会抛
    //    DataError: The parameter is not a valid key。
    //    删 kv 请用 removeSetting()。
    await wrap(store.delete(Number(id)));
    return true;
  },

  async _clear(storeName) {
    const store = await tx('readwrite', storeName);
    await wrap(store.clear());
  },

  /* ---------------- 打卡 ---------------- */

  /** 新建打卡项，返回新 id */
  async addCheckin(title) {
    const t = String(title || '').trim();
    if (!t) throw new Error('打卡名称不能为空');
    return this._add(STORE_CHECKINS, { title: t, created_at: formatDateTime(new Date()) });
  },

  /** 重命名打卡项 */
  async renameCheckin(id, title) {
    const t = String(title || '').trim();
    if (!t) throw new Error('打卡名称不能为空');
    const rec = await this._get(STORE_CHECKINS, Number(id));
    if (!rec) throw new Error('打卡项不存在');
    rec.title = t;
    await this._put(STORE_CHECKINS, rec);
    return true;
  },

  /** 删除打卡项，连带删除它的全部打卡记录 */
  async removeCheckin(id) {
    const logs = await this.getCheckinLogs(id);
    const store = await tx('readwrite', STORE_CHECKIN_LOGS);
    for (const l of logs) await wrap(store.delete(l.id));
    await this._remove(STORE_CHECKINS, id);
    return true;
  },

  async getCheckins() {
    const all = await this._getAll(STORE_CHECKINS);
    return all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  },

  /**
   * 某打卡项的全部记录日期（YYYY-MM-DD 字符串数组，升序）
   */
  async getCheckinLogs(checkinId) {
    const all = await this._getAll(STORE_CHECKIN_LOGS);
    return all
      .filter((l) => Number(l.checkin_id) === Number(checkinId))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  },

  /** 全部打卡记录（跨打卡项） */
  async getAllCheckinLogs() {
    return this._getAll(STORE_CHECKIN_LOGS);
  },

  /**
   * 打卡 / 取消打卡（同一打卡项同一天幂等）
   * @returns {Promise<boolean>} true=新增了打卡，false=取消了打卡
   */
  async toggleCheckin(checkinId, dateStr) {
    const all = await this._getAll(STORE_CHECKIN_LOGS);
    const hit = all.find((l) => Number(l.checkin_id) === Number(checkinId) && l.date === dateStr);
    if (hit) {
      await this._remove(STORE_CHECKIN_LOGS, hit.id);
      return false;
    }
    await this._add(STORE_CHECKIN_LOGS, {
      checkin_id: Number(checkinId),
      date: dateStr,
      created_at: formatDateTime(new Date()),
    });
    return true;
  },

  /* ---------------- 记账 ---------------- */

  async addLedgerEntry(entry) {
    const { LedgerEntry } = await import('../models/ledger_entry.js');
    const e = entry instanceof LedgerEntry ? entry : new LedgerEntry(entry);
    const check = e.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    const rec = e.toRecord();
    delete rec.id;
    return this._add(STORE_LEDGER, rec);
  },

  async updateLedgerEntry(entry) {
    const { LedgerEntry } = await import('../models/ledger_entry.js');
    const e = entry instanceof LedgerEntry ? entry : new LedgerEntry(entry);
    if (e.id == null) throw new Error('缺少 id，无法更新');
    const check = e.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    await this._put(STORE_LEDGER, e.toRecord());
    return e.id;
  },

  async removeLedgerEntry(id) {
    return this._remove(STORE_LEDGER, id);
  },

  /** 全部流水，按日期倒序（同日内按录入时间倒序） */
  async getLedgerEntries() {
    const { LedgerEntry } = await import('../models/ledger_entry.js');
    const all = await this._getAll(STORE_LEDGER);
    return all.map((r) => LedgerEntry.fromRecord(r)).filter(Boolean)
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
  },

  /** 某个月份的流水（month 形如 '2026-09'） */
  async getLedgerByMonth(month) {
    const all = await this.getLedgerEntries();
    return all.filter((e) => e.date.startsWith(month));
  },

  /* ---------------- 待办（任务 / 想要） ---------------- */

  async addTodo(todo) {
    const { Todo } = await import('../models/todo.js');
    const t = todo instanceof Todo ? todo : new Todo(todo);
    const check = t.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    const rec = t.toRecord();
    delete rec.id;
    return this._add(STORE_TODOS, rec);
  },

  async updateTodo(todo) {
    const { Todo } = await import('../models/todo.js');
    const t = todo instanceof Todo ? todo : new Todo(todo);
    if (t.id == null) throw new Error('缺少 id，无法更新');
    const check = t.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    await this._put(STORE_TODOS, t.toRecord());
    return t.id;
  },

  async removeTodo(id) {
    return this._remove(STORE_TODOS, id);
  },

  async getTodoById(id) {
    const { Todo } = await import('../models/todo.js');
    const rec = await this._get(STORE_TODOS, Number(id));
    return Todo.fromRecord(rec);
  },

  /** 全部待办（未排序，排序交给模型的 sortTodos） */
  async getTodos() {
    const { Todo } = await import('../models/todo.js');
    const all = await this._getAll(STORE_TODOS);
    return all.map((r) => Todo.fromRecord(r)).filter(Boolean);
  },

  /** 切换完成状态，返回切换后的 Todo */
  async toggleTodo(id) {
    const { Todo } = await import('../models/todo.js');
    const rec = await this._get(STORE_TODOS, Number(id));
    if (!rec) throw new Error('待办不存在');
    const t = Todo.fromRecord(rec).toggleDone(new Date());
    await this._put(STORE_TODOS, t.toRecord());
    return t;
  },

  /* ---------------- 账户余额（v1.5.0） ---------------- */

  async addAccount(account) {
    const { Account } = await import('../models/account.js');
    const a = account instanceof Account ? account : new Account(account);
    const check = a.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    const rec = a.toRecord();
    delete rec.id;
    return this._add(STORE_ACCOUNTS, rec);
  },

  async updateAccount(account) {
    const { Account } = await import('../models/account.js');
    const a = account instanceof Account ? account : new Account(account);
    if (a.id == null) throw new Error('缺少 id，无法更新');
    const check = a.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    await this._put(STORE_ACCOUNTS, a.toRecord());
    return a.id;
  },

  async removeAccount(id) {
    return this._remove(STORE_ACCOUNTS, id);
  },

  async getAccountById(id) {
    const { Account } = await import('../models/account.js');
    const rec = await this._get(STORE_ACCOUNTS, Number(id));
    return Account.fromRecord(rec);
  },

  /** 全部账户，未归档在前，再按创建时间 */
  async getAccounts() {
    const { Account } = await import('../models/account.js');
    const all = await this._getAll(STORE_ACCOUNTS);
    return all.map((r) => Account.fromRecord(r)).filter(Boolean)
      .sort((a, b) => (Number(a.archived) - Number(b.archived))
        || String(a.createdAt).localeCompare(String(b.createdAt)));
  },

  /* ---------------- 键值设置（月度预算等） ---------------- */

  async setSetting(key, value) {
    await this._put(STORE_KV, { key: String(key), value });
    return true;
  },

  async getSetting(key, fallback = null) {
    const rec = await this._get(STORE_KV, String(key));
    return rec ? rec.value : fallback;
  },

  /**
   * 删掉一个设置键（v1.13.0）。
   *
   * 🔴 必须单独开这个方法，不能复用 `_remove` —— 后者会把 key 转成 Number，
   *    而 kv 是字符串主键，转完是 NaN，IndexedDB 直接抛
   *    `DataError: The parameter is not a valid key`。
   *    （踩过：清空「账户」时连带清 kv 里的资产明细，一按就报错。）
   */
  async removeSetting(key) {
    const store = await tx('readwrite', STORE_KV);
    await wrap(store.delete(String(key)));
    return true;
  },
};

export default DatabaseService;
