// run_all.mjs —— 一键运行全部测试
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PY = [
  process.env.PYTHON_PATH,
  'C:/Users/27693/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe',
  'python',
].filter(Boolean).find((p) => p === 'python' || existsSync(p));

const SUITES = [
  { name: '单元测试（解析器 / 周计算 / 模型）', cmd: process.execPath, args: [join(__dirname, 'run_tests.mjs')] },
  { name: '分类与报告人测试（三分类：学术 / 就业 / 其他）', cmd: process.execPath, args: [join(__dirname, 'category_test.mjs')] },
  { name: '人工语料测试（31 条真实通知，含分类校验）', cmd: process.execPath, args: [join(__dirname, 'corpus_test.mjs')] },
  { name: '记录页测试（打卡连续天数 / 记账汇总 / 收据解析）', cmd: process.execPath, args: [join(__dirname, 'record_test.mjs')] },
  { name: '待办测试（任务 / 想要 · 完成折叠 · 逾期与排序）', cmd: process.execPath, args: [join(__dirname, 'todo_test.mjs')] },
  { name: '账户对账测试（余额推导 · 对账差额 · 快照基准）', cmd: process.execPath, args: [join(__dirname, 'account_test.mjs')] },
  { name: '资产总览测试（净资产算式 · 借贷方向 · 黄金定期 · 逾期分方向）', cmd: process.execPath, args: [join(__dirname, 'asset_test.mjs')] },
  { name: '本地提醒测试（闹钟换算 · 增量对账 · 浏览器降级）', cmd: process.execPath, args: [join(__dirname, 'reminder_test.mjs')] },
  { name: '原生调用链测试（设备端 OCR · 系统闹钟 · 假 Capacitor 桥）', cmd: process.execPath, args: [join(__dirname, 'native_services_test.mjs')] },
  ...(PY ? [{ name: 'OCR 文本清洗回归测试', cmd: PY, args: [join(__dirname, 'test_ocr_clean.py')] }] : []),
  { name: '端到端测试（真实浏览器）', cmd: process.execPath, args: [join(__dirname, 'e2e_test.mjs')] },
];

console.log('\n' + '#'.repeat(60));
console.log('#  周周记 —— 全部测试');
console.log('#'.repeat(60));

const results = [];
for (const s of SUITES) {
  console.log(`\n\n>>> ${s.name}`);
  console.log('-'.repeat(60));
  const r = spawnSync(s.cmd, s.args, { stdio: 'inherit', cwd: ROOT });
  results.push({ name: s.name, code: r.status });
}

console.log('\n\n' + '#'.repeat(60));
console.log('#  测试汇总');
console.log('#'.repeat(60));
results.forEach((r) => {
  const ok = r.code === 0;
  console.log(`  ${ok ? '[通过]' : '[未通过]'}  ${r.name}`);
});
const allOk = results.every((r) => r.code === 0);
console.log('\n' + (allOk ? '全部测试通过' : '存在未通过的测试'));
process.exit(allOk ? 0 : 1);
