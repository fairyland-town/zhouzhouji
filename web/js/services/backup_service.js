/**
 * backup_service.js —— 把全部数据自动备份到手机文件系统
 *
 * 只在**安卓壳（Capacitor）内**生效；普通浏览器里所有函数都是安全 no-op，
 * 这样网页版行为完全不受影响（网页版仍走「设置 → 导出 JSON」）。
 *
 * 落点优先级（逐级回退，第一个写成功的就用它）：
 *   ① Documents/周周记备份/  —— 文件管理器里可见，用户能自己拷走
 *   ② ExternalStorage/…      —— 部分机型 Documents 不可写时兜底
 *   ③ Data/…                 —— 应用私有目录，必定可写（但用户看不见）
 *
 * 每次备份写两份：
 *   · `周周记-最新备份.json`     —— 固定名，覆盖写，用于「恢复」
 *   · `YYYY-MM-DD.json`          —— 按天留档，最多保留 KEEP_DAILY 份
 */

import { isNative, callNative, DIR, ENC } from './native_bridge.js';

const BACKUP_DIR = '周周记备份';
const LATEST_NAME = '周周记-最新备份.json';
const KEEP_DAILY = 7;

const KV_LAST_AT = 'backup_last_at';
const KV_LAST_PATH = 'backup_last_path';
const KV_LAST_SIZE = 'backup_last_size';
const KV_BACKUP_DIR = 'backup_dir_used';

/** 目录回退链 */
const DIR_CHAIN = [DIR.DOCUMENTS, DIR.EXTERNAL_STORAGE, DIR.DATA];

let autoTimer = null;
let installed = false;

/** 生成日期串（YYYY-MM-DD）与时间戳串 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { date, time: `${date} ${p(d.getHours())}:${p(d.getMinutes())}` };
}

/**
 * 按目录链逐级尝试写入，返回第一个成功的目录。
 * 全部失败时抛出最后一个错误。
 */
async function writeInChain(relPath, json) {
  let lastErr = null;
  for (const directory of DIR_CHAIN) {
    try {
      await callNative('Filesystem', 'writeFile', {
        path: relPath,
        data: json,
        directory,
        encoding: ENC.UTF8,
        recursive: true,
      });
      return directory;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('没有可写入的目录');
}

/** 只保留最近 keep 份按天归档；失败不影响备份本身 */
async function pruneDaily(dir, keep = KEEP_DAILY) {
  try {
    const res = await callNative('Filesystem', 'readdir', { path: BACKUP_DIR, directory: dir });
    const files = (res && Array.isArray(res.files) ? res.files : [])
      .map((f) => (typeof f === 'string' ? f : f && f.name))
      .filter((n) => typeof n === 'string' && /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .sort();
    const drop = files.slice(0, Math.max(0, files.length - keep));
    for (const n of drop) {
      await callNative('Filesystem', 'deleteFile', { path: `${BACKUP_DIR}/${n}`, directory: dir });
    }
  } catch { /* 清理失败忽略 */ }
}

/**
 * 立刻执行一次备份。
 * @returns {Promise<{skipped?:boolean, reason?:string, dir?:string, path?:string, bytes?:number, at?:string}>}
 */
export async function backupNow(db) {
  if (!isNative()) return { skipped: true, reason: 'not-native' };

  const json = await db.exportJSON();
  const { date, time } = stamp();

  const dir = await writeInChain(`${BACKUP_DIR}/${LATEST_NAME}`, json);
  await writeInChain(`${BACKUP_DIR}/${date}.json`, json).catch(() => {});
  pruneDaily(dir);

  await db.setSetting(KV_LAST_AT, time);
  await db.setSetting(KV_LAST_PATH, `${BACKUP_DIR}/${LATEST_NAME}`);
  await db.setSetting(KV_LAST_SIZE, json.length);
  await db.setSetting(KV_BACKUP_DIR, dir);

  return { dir, path: `${BACKUP_DIR}/${LATEST_NAME}`, bytes: json.length, at: time };
}

/**
 * 防抖自动备份 —— 数据改动后调用，避免频繁写盘。
 * 浏览器里直接返回，不做任何事。
 */
export function scheduleAutoBackup(db, delay = 5000) {
  if (!isNative()) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    backupNow(db).catch((err) => {
      console.warn('[backup_service] 自动备份失败：', err && err.message);
    });
  }, delay);
}

/**
 * 读取备份状态（设置页展示用）。浏览器里 `isNative` 为 false。
 */
export async function backupStatus(db) {
  const [lastAt, lastPath, lastSize, dir] = await Promise.all([
    db.getSetting(KV_LAST_AT, null),
    db.getSetting(KV_LAST_PATH, null),
    db.getSetting(KV_LAST_SIZE, 0),
    db.getSetting(KV_BACKUP_DIR, null),
  ]);
  return { isNative: isNative(), lastAt, lastPath, lastSize, dir };
}

/**
 * 把备份文件交给系统分享面板 —— 用户可存到网盘 / 发给自己。
 * 这是「数据出手机」的唯一可靠通道，不依赖任何权限声明。
 */
export async function shareBackup(db) {
  if (!isNative()) return { skipped: true, reason: 'not-native' };

  const json = await db.exportJSON();
  const rel = `${BACKUP_DIR}/周周记备份-${stamp().date}.json`;
  const dir = await writeInChain(rel, json);

  let url = null;
  try {
    const uriRes = await callNative('Filesystem', 'getUri', { path: rel, directory: dir });
    url = uriRes && uriRes.uri;
  } catch { /* 拿不到 URI 就只分享文本 */ }

  await callNative('Share', 'share', {
    title: '周周记备份',
    text: '周周记的数据备份文件',
    ...(url ? { url } : {}),
    dialogTitle: '保存或发送备份',
  });

  return { dir, path: rel, bytes: json.length };
}

/**
 * 安装自动备份：
 *   · 应用切到后台时**立刻**备份一次（不等防抖，避免被系统杀进程丢数据）
 *   · 数据改动后走 scheduleAutoBackup 的防抖
 * 浏览器里是 no-op。
 */
export function installAutoBackup(db) {
  if (!isNative() || installed) return;
  installed = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    clearTimeout(autoTimer);
    backupNow(db).catch((err) => {
      console.warn('[backup_service] 切后台备份失败：', err && err.message);
    });
  });
}

/* ================================================================
   重装之后把数据找回来
   ================================================================
 *
 * 背景：**卸载应用会删掉 IndexedDB**（它躺在应用私有目录里），
 * 所以用户最怕的就是「重装一下，我的账全没了」。
 *
 * 但备份文件通常不在私有目录 —— 它在手机「文档 / Documents」下，
 * **卸载应用不会删它**。数据其实还在，只是没人告诉用户。
 * 这一节就是那个「告诉用户」的环节：
 * 本机第一次打开、数据库又是空的，就去三个候选目录里翻一翻，
 * 翻到了就问一句「要恢复吗」。
 *
 * 🔴 「只问一次」的标记用 localStorage，**不能用 kv**：
 *    kv 会被「设置 → 清空数据」一起清掉，
 *    那样用户刚清完数据、下次启动又会被问「要不要恢复你刚删的东西」。
 *    localStorage 在「清空数据」时不动，正好。
 */

const FIRST_LAUNCH_KEY = 'cw_first_launch_done';

/** 在目录链里找最近那份固定名备份；找不到返回 null */
async function findLatestBackup() {
  for (const directory of DIR_CHAIN) {
    try {
      const res = await callNative('Filesystem', 'readFile', {
        path: `${BACKUP_DIR}/${LATEST_NAME}`,
        directory,
        encoding: ENC.UTF8,
      });
      const data = res && typeof res.data === 'string' ? res.data : '';
      if (data.length > 20) return { directory, json: data };
    } catch { /* 这个目录没有，试下一个 */ }
  }
  return null;
}

/**
 * 本机第一次打开时，若数据库是空的、但手机里躺着上一份备份 —— 返回它。
 *
 * @returns {Promise<null | {json:string, dir:string, total:number, at:string}>}
 */
export async function offerRestoreIfFresh(db) {
  if (!isNative()) return null;

  // 只在本机「第一次打开」时问一次
  try {
    if (localStorage.getItem(FIRST_LAUNCH_KEY)) return null;
    localStorage.setItem(FIRST_LAUNCH_KEY, '1');
  } catch { /* 隐私模式等，忽略 */ }

  // 本机已经有数据就别打扰 —— 覆盖安装（正常更新）时数据本来就在，
  // 这条路只在「重装 / 换机 / 被系统清了数据」时才会走到。
  // ⚠️ 用 isEmpty() 而不是 count()：后者只数 events 表，
  //    「只打过卡没记过活动」会被误判成空库，然后把提示弹给一个正在用的人。
  try {
    if (!(await db.isEmpty())) return null;
  } catch { return null; }

  const found = await findLatestBackup();
  if (!found) return null;

  let total = 0; let at = '';
  try {
    const parsed = JSON.parse(found.json);
    total = Number(parsed && parsed.count) || 0;
    at = (parsed && parsed.exported_at) || '';
  } catch { return null; }
  if (!total) return null;

  return { json: found.json, dir: found.directory, total, at };
}

/** 目录的中文名（设置页与恢复提示共用） */
export const BACKUP_DIR_LABEL = {
  DOCUMENTS: '手机「文档」目录',
  EXTERNAL_STORAGE: '应用外部目录',
  DATA: '应用私有目录',
};
