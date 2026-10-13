/**
 * verify_all.mjs —— 把 `package.json` 里所有 `verify:*` 脚本**顺序**跑一遍，给一张可信的总表。
 *
 * 为什么要专门写这个：
 *
 *   ① **直接 for 循环跑会假红。** 这些脚本里大量使用 `wait(固定毫秒)`
 *      （典型的是「滚动到某处 → sleep → 量坐标」）。14 个 Chrome 连着起、机器一忙，
 *      量到的就是**动画中途**的坐标 —— 2026-10-13 实测：`nav` 2 红、`ledgerform` 5 红、
 *      `ledgeracct` 一条没跑成，而**单独重跑全是绿的**。假红比假绿更费时间：
 *      它会让人去查一个不存在的回归。所以这里脚本之间留出喘息，跑完还逐条复核。
 *
 *   ② **退出码不可信。** 这些脚本失败时照样 `exit 0`（`check()` 只累加计数器）。
 *      唯一的真相是 stdout 里那两行总结：`全部通过：N 项` / `失败 N 项 / 共 M 项`。
 *      所以这里**解析输出**，不看 exit code。
 *
 *   ③ 之前用 `grep -cE '^\s+✗'` 数红项也**漏报** —— 失败项最后会再汇总成
 *      `  · 项目名` 列表（不带 ✗）。汇总行才靠得住。
 *
 * 用法：node tools/verify_all.mjs            （需先 npm run serve）
 *       node tools/verify_all.mjs --fast     （脚本之间不留间隔，机器空闲时用）
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAST = process.argv.includes('--fast');
const GAP = FAST ? 0 : 1200;

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const jobs = Object.keys(pkg.scripts)
  // ⚠️ 必须排除自己（`verify:all` 也是 `verify:` 开头）—— 否则无限递归把自己 spawn 起来
  .filter((k) => k.startsWith('verify:') && k !== 'verify:all')
  .map((k) => {
    const name = k.slice('verify:'.length);
    const cmd = pkg.scripts[k].trim();
    const m = cmd.match(/^node\s+(.+)$/);
    return { name, file: m ? m[1] : null, cmd };
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 去掉 ANSI 颜色码。
 *
 * 🔴 必须先去色再解析 —— `acctdetail` 打印的是 `\x1b[32m全部通过\x1b[0m（34 项）`，
 *    而重置码 `\x1b[0m` **自带一个数字 0**，会把「全部通过后面跟几个非数字字符」
 *    这种写法直接噎死（`[^0-9]` 匹配不了 `0`）。
 *    2026-10-13 实测：脚本明明全绿，汇总表却报 `acctdetail ? 项失败` —— 解析器的锅。
 */
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/** 从 stdout 里抠出真相：失败项数 / 通过项数 */
function verdict(raw) {
  const out = stripAnsi(raw);
  const fail = out.match(/失败\s*(\d+)\s*项/);
  if (fail && Number(fail[1]) > 0) return { ok: false, n: Number(fail[1]) };
  // 「全部通过：41 项」「资产总览全部通过：80 项」「全部通过（34 项）」
  const pass = out.match(/全部通过[^0-9]{0,6}(\d+)\s*项/);
  if (pass) return { ok: true, n: Number(pass[1]) };
  return { ok: false, n: null, unknown: true };
}

const results = [];
let totalItems = 0;

function runOnce(job) {
  const r = job.file
    ? spawnSync(process.execPath, [job.file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(job.cmd, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { out, v: verdict(out) };
}

for (const job of jobs) {
  process.stdout.write(`\x1b[2m▶ ${job.name} …\x1b[0m `);
  let { out, v } = runOnce(job);

  // 「没认出总结行」= 脚本**压根没跑到最后**（不是断言失败）——
  // 14 个 Chrome 连着起，最后一个常被资源抢崩。空转一次比报假红划算。
  // ⚠️ 只重试「没跑完」的；**真正断言失败的绝不重试**（否则就变成掩盖回归了）。
  let retried = false;
  if (v.unknown) {
    retried = true;
    await sleep(3000);
    ({ out, v } = runOnce(job));
  }

  if (v.ok) {
    totalItems += v.n || 0;
    results.push({ ...job, ...v });
    console.log(`\x1b[32mOK\x1b[0m  ${v.n} 项${retried ? ' \x1b[2m(重跑一次才跑完)\x1b[0m' : ''}`);
  } else {
    // 把失败项原文抄出来，省得再回去翻
    // 「没认出总结行」时没有 `· 项目名` 也没有 `Error:`，光看过滤器会一片空白 ——
    // 这种情况直接把**原始尾巴**抄出来（多半是进程被抢崩，或脚本卡在某处没跑完）。
    const detail = v.unknown
      ? out.split('\n').filter((l) => l.trim()).slice(-10)
      : out.split('\n')
        .filter((l) => /^\s+·\s/.test(l) || /Error:/.test(l) || /失败/.test(l))
        .slice(0, 8);
    results.push({ ...job, ...v, detail });
    console.log(`\x1b[31mFAIL\x1b[0m${v.unknown ? '（没认出总结行）' : ` ${v.n} 项`}`);
    detail.forEach((l) => console.log(`    ${l.trim()}`));
  }

  if (GAP) await sleep(GAP);
}

/* ---------------- 总表 ---------------- */
const failed = results.filter((x) => !x.ok);
console.log('\n' + '='.repeat(58));
for (const x of results) {
  const tag = x.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${tag} ${x.name.padEnd(14)} ${x.ok ? `${x.n} 项` : `${x.n ?? '?'} 项失败`}`);
}
console.log('='.repeat(58));
console.log(`共 ${results.length} 个脚本，通过 ${results.length - failed.length} 个，累计 ${totalItems} 项断言`);
if (failed.length) {
  console.log(`\x1b[31m红：${failed.map((f) => f.name).join(' / ')}\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32m全绿。\x1b[0m');
}
