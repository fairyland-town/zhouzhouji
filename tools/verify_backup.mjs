/**
 * verify_backup.mjs —— 验证 v1.11.0 的备份覆盖范围与安卓原生桥接
 *
 * 分三部分：
 *   ① 数据层（真实 IndexedDB）：导出是否覆盖全部 7 个 store、
 *      往返导入是否还原、外键是否完好、旧格式备份是否仍能导入
 *   ② 原生桥接（mock Capacitor）：安卓壳内设置页是否出现「自动备份」区块、
 *      手动备份是否真的调到了 Filesystem.writeFile、负载是否含全部数据
 *   ③ 目录回退：Documents 写失败时是否自动退到 ExternalStorage
 *   ④ 反向确认：普通浏览器里**不出现**该区块（网页版无回归）
 *
 * 需要先运行 `npm run serve`。
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js']
  .find((p) => existsSync(p));
const puppeteer = (await import(pathToFileURL(P).href)).default;

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8080/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL_STORES = ['events', 'checkins', 'checkin_logs', 'ledger', 'todos', 'accounts', 'kv'];

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
}
const eq = (name, actual, expected) => check(name, actual === expected, `期望 ${expected} / 实际 ${actual}`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 430, height: 900 },
});

console.log('\n=== v1.11.0 备份覆盖范围与原生桥接验证 ===\n');

/* ================================================================
   一、数据层：导出覆盖 7 个 store
   ================================================================ */
console.log('1. 导出覆盖范围（真实 IndexedDB）');

const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(600);

const seeded = await page.evaluate(async (stores) => {
  const { default: DB } = await import('/js/services/database_service.js');
  for (const s of stores) await DB._clear(s);

  await DB.add({ title: '备份测试活动', location: 'A101', startTime: '2026-09-20 14:00', rawText: '' });
  const cid = await DB.addCheckin('背单词');
  await DB.toggleCheckin(cid, '2026-09-15');
  await DB.toggleCheckin(cid, '2026-09-16');
  await DB.addLedgerEntry({ amount: 25, direction: 'out', category: 'food', note: '午餐', date: '2026-09-16' });
  await DB.addTodo({ title: '写作业', kind: 'task' });
  const aid = await DB.addAccount({ name: '饭卡', opening: 500, openingDate: '2026-09-01' });
  await DB.setSetting('ledger_budget_2026-09', 1500);

  const json = await DB.exportJSON();
  const p = JSON.parse(json);
  const logs = await DB._getAll('checkin_logs');
  const checkins = await DB._getAll('checkins');

  return {
    json,
    version: p.version,
    keys: Object.keys(p),
    counts: p.counts,
    total: p.count,
    logFk: logs.map((l) => l.checkin_id),
    checkinIds: checkins.map((c) => c.id),
    accountIds: (await DB._getAll('accounts')).map((a) => a.id),
    accountId: aid,
  };
}, ALL_STORES);

eq('导出格式版本为 2', seeded.version, 2);
for (const s of ALL_STORES) {
  check(`导出含 ${s} 字段`, Array.isArray(seeded.keys) && seeded.keys.includes(s),
    `实际字段：${seeded.keys.join(',')}`);
}
eq('活动 1 条', seeded.counts.events, 1);
eq('打卡项 1 条', seeded.counts.checkins, 1);
eq('打卡记录 2 条', seeded.counts.checkin_logs, 2);
eq('记账 1 条', seeded.counts.ledger, 1);
eq('待办 1 条', seeded.counts.todos, 1);
eq('账户 1 条', seeded.counts.accounts, 1);
eq('设置 1 条', seeded.counts.kv, 1);
eq('总数 = 各表之和', seeded.total, 8);
check('账户记录保留了 id（外键需要）', seeded.accountIds[0] != null, `实际 ${seeded.accountIds[0]}`);
check('打卡记录带 checkin_id 外键', seeded.logFk.every((v) => v != null), JSON.stringify(seeded.logFk));

/* ================================================================
   二、往返导入：替换模式应完整还原
   ================================================================ */
console.log('\n2. 替换模式往返导入');

const roundTrip = await page.evaluate(async (json) => {
  const { default: DB } = await import('/js/services/database_service.js');
  const res = await DB.importJSON(json, { merge: false });
  const after = JSON.parse(await DB.exportJSON());

  // 外键完整性：每条打卡记录的 checkin_id 都必须指向真实存在的打卡项
  const logs = await DB._getAll('checkin_logs');
  const checkins = await DB._getAll('checkins');
  const ids = new Set(checkins.map((c) => c.id));

  // 记账流水若挂账户，accountId 也必须真实存在
  const led = await DB._getAll('ledger');
  const accts = await DB._getAll('accounts');
  const acctIds = new Set(accts.map((a) => a.id));

  return {
    res,
    counts: after.counts,
    orphanLogs: logs.filter((l) => !ids.has(l.checkin_id)).length,
    danglingLedger: led.filter((e) => e.accountId != null && !acctIds.has(e.accountId)).length,
  };
}, seeded.json);

eq('还原后活动数一致', roundTrip.counts.events, 1);
eq('还原后打卡项数一致', roundTrip.counts.checkins, 1);
eq('还原后打卡记录数一致', roundTrip.counts.checkin_logs, 2);
eq('还原后记账数一致', roundTrip.counts.ledger, 1);
eq('还原后待办数一致', roundTrip.counts.todos, 1);
eq('还原后账户数一致', roundTrip.counts.accounts, 1);
eq('还原后设置数一致', roundTrip.counts.kv, 1);
eq('导入总数', roundTrip.res.total, 8);
eq('无跳过项', roundTrip.res.skipped, 0);
eq('打卡记录无孤儿外键', roundTrip.orphanLogs, 0);
eq('记账流水无悬空账户引用', roundTrip.danglingLedger, 0);

/* ================================================================
   2.5 合并导入：转账指认（linkedAccountId）必须跟着重映射
   ================================================================
   `accounts.entries[].linkedAccountId` 存的是**对方账户的整数 id**，
   而导入会把所有账户 id 重新发号（`_add` 会 delete rec.id）。
   第 4 步给记账流水的 `accountId` 做了重映射，账户流水这一侧**当初漏了**。

   漏了的后果不是报错，是**静默留半截账**：`removeEntry()` 靠这个字段
   找对方那条流水一起撤，找不到就只删一半 —— 用户在 A 看到 +200，
   B 那边没有对应的 −200，两边余额各自看着都「算得通」。

   ⚠️ 必须用 **merge（合并）** 模式测：替换模式下自增会从 1 重新发号，
      旧 id 恰好还能对上，**测不出来**。合并到非空库才会偏移（实测 1/2 → 4/5）。
   ================================================================ */
console.log('\n2.5 合并导入后转账指认仍有效');

const transferImport = await page.evaluate(async () => {
  const { default: DB } = await import('/js/services/database_service.js');
  const { default: AccountService } = await import('/js/services/account_service.js');

  const clear = () => new Promise((res) => {
    const req = indexedDB.open('campus_week_calendar');
    req.onsuccess = () => {
      const db = req.result;
      const names = ['ledger', 'accounts'].filter((n) => db.objectStoreNames.contains(n));
      const t = db.transaction(names, 'readwrite');
      names.forEach((n) => t.objectStore(n).clear());
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
    };
    req.onerror = () => res(false);
  });

  // ① 干净库：两个账户 + 一笔转账
  //    ⚠️ create() 返回的是新 id（number），不是 Account 实例
  await clear();
  const fromId = await AccountService.create({ name: '零钱', type: 'wallet', opening: 500 });
  const toId = await AccountService.create({ name: '饭卡', type: 'meal_card', opening: 100 });
  await AccountService.transfer({ fromId, toId, amount: 200, note: '挪一下' });
  const backup = await DB.exportJSON();

  // ② 清空后**先建一个无关账户**把自增顶开，再合并导入
  //    —— 这就是「换手机后先建过账户、再导入备份」的真实场景
  await clear();
  await AccountService.create({ name: '占位账户', type: 'custom', opening: 0 });
  await DB.importJSON(backup, { merge: true });

  // ③ 指认还成立吗
  const accs = await AccountService.list();
  const card = accs.find((a) => a.name === '饭卡');
  const wallet = accs.find((a) => a.name === '零钱');
  const inEntry = card?.entries.find((e) => e.kind === 'in');
  const outEntry = wallet?.entries.find((e) => e.kind === 'out');
  const acctIds = new Set(accs.map((a) => a.id));

  const peerResolves = inEntry?.linkedAccountId != null && acctIds.has(inEntry.linkedAccountId);
  const peerIsRight = inEntry?.linkedAccountId === wallet?.id;
  const entryLinkIntact = inEntry?.linkedEntryId === outEntry?.id;

  // ④ 真正的行为保证：删掉一半，另一半跟着没
  await AccountService.removeEntry(wallet.id, outEntry.id);
  const after = await AccountService.list();
  const cardAfter = after.find((a) => a.name === '饭卡');
  const peerAlsoRemoved = !cardAfter.entries.some((e) => e.id === inEntry.id);

  return { peerResolves, peerIsRight, entryLinkIntact, peerAlsoRemoved, walletId: wallet.id, linked: inEntry?.linkedAccountId };
});

check('转账转入侧的 linkedAccountId 指向真实存在的账户',
  transferImport.peerResolves, `linkedAccountId=${transferImport.linked} / 零钱新 id=${transferImport.walletId}`);
check('而且指向的是**正确**的那个账户（不是随便一个）',
  transferImport.peerIsRight, `linkedAccountId=${transferImport.linked}`);
check('linkedEntryId 未受影响（流水 id 是字符串，原样保留）',
  transferImport.entryLinkIntact, true);
check('🔴 删掉转账的一半，另一半跟着撤（不留半截账）',
  transferImport.peerAlsoRemoved, true);

/* ================================================================
   三、向后兼容：旧格式备份仍能导入
   ================================================================ */
console.log('\n3. 旧格式（v1 / 纯数组）兼容');

const legacyV1 = JSON.stringify({
  app: 'campus_week_calendar',
  version: 1,
  count: 1,
  events: [{
    title: '旧格式活动', location: 'B201',
    start_time: '2026-09-21 10:00', created_at: '2026-09-01 09:00',
  }],
});

const legacyRes = await page.evaluate(async (txt) => {
  const { default: DB } = await import('/js/services/database_service.js');
  return DB.importJSON(txt, { merge: false });
}, legacyV1);

eq('v1 文件能导入', legacyRes.total, 1);
eq('v1 文件导入 1 条活动', legacyRes.counts.events, 1);

const arrayRes = await page.evaluate(async () => {
  const { default: DB } = await import('/js/services/database_service.js');
  const oldest = JSON.stringify([{
    title: '最早期数组格式', location: 'C301',
    start_time: '2026-09-22 09:00', created_at: '2026-09-01 09:00',
  }]);
  return DB.importJSON(oldest, { merge: false });
});

eq('纯数组格式能导入', arrayRes.counts.events, 1);

const emptyRes = await page.evaluate(async () => {
  const { default: DB } = await import('/js/services/database_service.js');
  try {
    await DB.importJSON(JSON.stringify({ app: 'x', version: 2 }), { merge: false });
    return { threw: false };
  } catch (e) { return { threw: true, msg: e.message }; }
});

check('空备份被拒绝且给出提示', emptyRes.threw && /没有任何可导入/.test(emptyRes.msg || ''),
  emptyRes.msg || '未抛错');

check('数据层全程无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
await page.close();

/* ================================================================
   四、原生桥接：mock Capacitor
   ================================================================ */
console.log('\n4. 安卓壳内（mock Capacitor）');

const page2 = await browser.newPage();
const errs2 = [];
page2.on('pageerror', (e) => errs2.push(e.message));

// 在应用脚本执行前注入假的 Capacitor 运行时
await page2.evaluateOnNewDocument(() => {
  window.__calls = [];
  window.__failDirs = [];
  window.__backupFile = null;   // 设成字符串就表示「手机里躺着这份备份」
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    nativePromise: (plugin, method, options) => {
      window.__calls.push({ plugin, method, options });
      if (plugin === 'Filesystem' && method === 'writeFile') {
        if (window.__failDirs.includes(options.directory)) {
          return Promise.reject(new Error('mock: 目录不可写 ' + options.directory));
        }
        return Promise.resolve({ uri: 'file:///mock/' + options.path });
      }
      if (plugin === 'Filesystem' && method === 'readFile') {
        if (window.__backupFile && String(options.path).endsWith('周周记-最新备份.json')) {
          return Promise.resolve({ data: window.__backupFile });
        }
        return Promise.reject(new Error('mock: 文件不存在'));
      }
      if (plugin === 'Filesystem' && method === 'readdir') return Promise.resolve({ files: [] });
      if (plugin === 'Filesystem' && method === 'getUri') return Promise.resolve({ uri: 'file:///mock/uri' });
      if (plugin === 'Share' && method === 'share') return Promise.resolve({});
      return Promise.resolve(null);
    },
  };
});

await page2.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(700);

// 进入设置页
await page2.click('.icon-btn');
await sleep(600);

const nativeTitles = await page2.$$eval('.list-item__title', (els) => els.map((e) => e.textContent.trim()));
check('设置页出现「立即备份一次」', nativeTitles.some((t) => t.includes('立即备份一次')),
  nativeTitles.join(' / '));
check('设置页出现「分享备份文件」', nativeTitles.some((t) => t.includes('分享备份文件')));
check('尚未备份时提示「还没有备份过」', nativeTitles.some((t) => t.includes('还没有备份过')));

// 点「立即备份一次」
const clicked = await page2.evaluate(() => {
  const items = [...document.querySelectorAll('.list-item')];
  const btn = items.find((b) => b.textContent.includes('立即备份一次'));
  if (!btn) return false;
  btn.click();
  return true;
});
check('找到并点击了备份按钮', clicked);
await sleep(900);

const backupCall = await page2.evaluate(() => {
  const c = window.__calls.find((x) => x.plugin === 'Filesystem' && x.method === 'writeFile');
  if (!c) return null;
  let payload = null;
  try { payload = JSON.parse(c.options.data); } catch { /* 非 JSON */ }
  return {
    directory: c.options.directory,
    path: c.options.path,
    encoding: c.options.encoding,
    recursive: c.options.recursive,
    keys: payload ? Object.keys(payload) : [],
    version: payload ? payload.version : null,
    callCount: window.__calls.filter((x) => x.plugin === 'Filesystem' && x.method === 'writeFile').length,
  };
});

check('确实调用了 Filesystem.writeFile', !!backupCall);
check('写入的是 Documents 目录（链上第一个可写的）', backupCall && backupCall.directory === 'DOCUMENTS',
  backupCall && backupCall.directory);
check('路径在「周周记备份」子目录下', backupCall && /周周记备份\//.test(backupCall.path),
  backupCall && backupCall.path);
eq('使用 UTF-8 编码', backupCall && backupCall.encoding, 'utf8');
eq('开启 recursive 自动建目录', backupCall && backupCall.recursive, true);
check('写入负载含全部 7 个 store',
  backupCall && ALL_STORES.every((s) => backupCall.keys.includes(s)),
  backupCall ? backupCall.keys.join(',') : '无');
eq('写入负载版本为 2', backupCall && backupCall.version, 2);
check('同时写了「最新」和「按天归档」两份', backupCall && backupCall.callCount >= 2,
  backupCall && backupCall.callCount);

// 备份后状态是否回写到界面
await page2.evaluate(() => {
  const items = [...document.querySelectorAll('.list-item')];
  const btn = items.find((b) => b.textContent.includes('立即备份一次'));
  if (btn) btn.click();
});
await sleep(300);

/* ================================================================
   五、目录回退：Documents 写失败应退到 ExternalStorage
   ================================================================ */
console.log('\n5. 目录回退链');

const fallback = await page2.evaluate(async () => {
  window.__failDirs = ['DOCUMENTS'];
  window.__calls.length = 0;
  const { default: DB } = await import('/js/services/database_service.js');
  const { backupNow } = await import('/js/services/backup_service.js');
  const res = await backupNow(DB);
  const tried = window.__calls
    .filter((c) => c.method === 'writeFile')
    .map((c) => c.options.directory);
  return { dir: res.dir, tried };
});

eq('Documents 失败后落到 EXTERNAL_STORAGE', fallback.dir, 'EXTERNAL_STORAGE');
check('先试过 DOCUMENTS 再退到 EXTERNAL_STORAGE',
  fallback.tried[0] === 'DOCUMENTS' && fallback.tried.includes('EXTERNAL_STORAGE'),
  fallback.tried.join(' → '));

/* ================================================================
   六、分享面板
   ================================================================ */
console.log('\n6. 分享备份文件');

const shared = await page2.evaluate(async () => {
  window.__failDirs = [];
  window.__calls.length = 0;
  const { default: DB } = await import('/js/services/database_service.js');
  const { shareBackup } = await import('/js/services/backup_service.js');
  const res = await shareBackup(DB);
  const shareCall = window.__calls.find((c) => c.plugin === 'Share' && c.method === 'share');
  const uriCall = window.__calls.find((c) => c.method === 'getUri');
  return { skipped: !!res.skipped, hasShare: !!shareCall, hasUri: !!uriCall, title: shareCall && shareCall.options.title };
});

check('分享未被跳过（识别为原生环境）', !shared.skipped);
check('调用了 Share.share', shared.hasShare);
check('先取了文件 URI 再分享', shared.hasUri);
eq('分享标题正确', shared.title, '周周记备份');

check('原生模式全程无未捕获异常', errs2.length === 0, errs2.slice(0, 2).join(' | '));

/* ================================================================
   六·五、重装后找回数据
   ----------------------------------------------------------------
   卸载应用会删掉 IndexedDB（应用私有目录），但**删不掉「文档」目录里的备份文件**。
   数据其实还在，只是没人告诉用户。offerRestoreIfFresh 就是那个「告诉」。
   这里钉住它的三个边界：别打扰有数据的人、没文件别空提示、同一台机器只问一次。
   ================================================================ */
console.log('\n6.5 重装后找回数据');

const restore = await page2.evaluate(async () => {
  const { offerRestoreIfFresh } = await import('/js/services/backup_service.js');
  const KEY = 'cw_first_launch_done';
  const reset = () => localStorage.removeItem(KEY);

  const empty = { isEmpty: async () => true };
  const full = { isEmpty: async () => false };
  const payload = JSON.stringify({
    app: 'campus_week_calendar', version: 2, exported_at: '2026-09-20 10:00', count: 42, events: [],
  });

  // ① 本机已经有数据（正常覆盖更新）→ 不该打扰
  reset(); window.__backupFile = payload;
  const withData = await offerRestoreIfFresh(full);

  // ② 空库、但手机里没有备份文件 → 什么都不提示
  reset(); window.__backupFile = null;
  const noFile = await offerRestoreIfFresh(empty);

  // ③ 空库 + 有备份文件 → 把备份交出来
  reset(); window.__backupFile = payload;
  const found = await offerRestoreIfFresh(empty);

  // ④ 紧接着再问一次：标记已写入，应该直接跳过
  const secondTime = await offerRestoreIfFresh(empty);

  // ⑤ 标记写在 localStorage，不能被「清空数据」顺手清掉
  const flag = localStorage.getItem(KEY);

  window.__backupFile = null;
  return { withData, noFile, found, secondTime, flag };
});

eq('本机已有数据时不打扰', restore.withData, null);
eq('空库但没有备份文件时不提示', restore.noFile, null);
check('空库 + 有备份 → 交出备份（42 条）',
  !!(restore.found && restore.found.total === 42), restore.found && restore.found.total);
check('同时带回了备份时间',
  !!(restore.found && restore.found.at === '2026-09-20 10:00'), restore.found && restore.found.at);
eq('同一台机器只问一次', restore.secondTime, null);
eq('「只问一次」的标记写在 localStorage', restore.flag, '1');

await page2.close();

/* ================================================================
   七、反向确认：普通浏览器不出现原生区块
   ================================================================ */
console.log('\n7. 网页版无回归');

const page3 = await browser.newPage();
await page3.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(600);
await page3.click('.icon-btn');
await sleep(600);

const webTitles = await page3.$$eval('.list-item__title', (els) => els.map((e) => e.textContent.trim()));
check('网页版不显示「立即备份一次」', !webTitles.some((t) => t.includes('立即备份一次')));
check('网页版仍显示「导出 JSON 备份」', webTitles.some((t) => t.includes('导出 JSON 备份')));
check('网页版仍显示「从 JSON 导入」', webTitles.some((t) => t.includes('从 JSON 导入')));

const webBridge = await page3.evaluate(async () => {
  const { isNative } = await import('/js/services/native_bridge.js');
  const { backupNow } = await import('/js/services/backup_service.js');
  const { default: DB } = await import('/js/services/database_service.js');
  const r = await backupNow(DB);
  return { isNative: isNative(), skipped: !!r.skipped, reason: r.reason };
});

eq('浏览器里 isNative() 为 false', webBridge.isNative, false);
check('浏览器里 backupNow 安全跳过', webBridge.skipped && webBridge.reason === 'not-native',
  webBridge.reason);

// 浏览器里连「翻历史备份」都不该发生（offerRestoreIfFresh 第一行就 return）
const webRestore = await page3.evaluate(async () => {
  const { offerRestoreIfFresh } = await import('/js/services/backup_service.js');
  const { default: DB } = await import('/js/services/database_service.js');
  return await offerRestoreIfFresh(DB);
});
check('浏览器里不检查历史备份', webRestore === null, webRestore);

await page3.close();
await browser.close();

console.log('\n' + '='.repeat(52));
console.log(fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} 项 / 通过 ${pass} 项`);
console.log('='.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
