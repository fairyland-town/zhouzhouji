/**
 * ledger_view.js —— 记账子视图（v1.3.0）
 *
 * 结构（自上而下）：
 *   ① 月度汇总卡：支出 / 收入 / 结余 + 预算进度条（超支标红、进度偏快提示）
 *   ② 快捷动作：记一笔 / 识别图片 / 设置预算
 *   ③ 「记一笔」表单（打开时插在动作下面）
 *   ④ 支出分类占比（横向条，最多 5 条）
 *   ⑤ 流水列表：按日分组，组头显示当日合计
 *
 * 一键导入：图片走已有的本机离线 OCR（ocr_service），
 * 文字走 receipt_parser，两条路最终都落到同一张「确认草稿」表单，
 * 让用户核对后再保存 —— 自动识别永远不当成事实直接入库。
 *
 * v1.13.5 表单改版（用户：「点击记一笔后，每次都是自动滑到最底下，
 * 不是显示输入金额在里面，然后 ui 能改成如图所示吗」）：
 *   版式改为「取消 + 标题 + 收支切换 / 大号金额 / 分类格子 / 备注 / 日期·账户 / 数字键盘」。
 *   · 键盘是**自己画的**，手机上不用等系统键盘弹起又收起；
 *     金额框用 `inputmode="none"` 挡掉系统键盘，桌面物理键盘仍可输入。
 *   · 第二轮（同日）改成**从底部弹出的浮层模块**，彻底和页面滚动解耦：
 *     原来那套「滚到表单顶部 / 要不要垫底占位」的推导随之作废，已删。
 *   · 新增可选的「消费账户」：选了就真从该账户扣钱，并计入它的累计消耗。
 *     挂账关系存在账户侧（账户流水的 ledgerId），不是记账流水的 account_id ——
 *     原因见 account_service.linkLedger 的注释。
 */

import {
  h, mount, toast, confirmDialog, actionSheet,
  pushOverlay, popOverlay, dismissTopOverlay,
} from '../../utils/dom.js';
import { Icons } from '../../widgets/icons.js';
import LedgerService from '../../services/ledger_service.js';
import AccountService from '../../services/account_service.js';
import { ocrService } from '../../services/ocr_service.js';
import { parseReceipt } from '../../services/receipt_parser.js';
import {
  LedgerEntry, DIRECTION, ledgerCategoriesOf, getLedgerCategory,
} from '../../models/ledger_entry.js';
import { formatDate, weekdayName, parseDateInput } from '../../utils/date_utils.js';
import { money, amountShort, signedAmount } from '../../utils/money.js';
import { promptDialog } from './checkin_view.js';

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 金额串规范化：只留数字与**一个**小数点，整数最多 8 位、小数最多 2 位。
 *
 * 自定义键盘是按这个规则「拼」金额的，但金额输入框本身仍然可编辑
 * （桌面用物理键盘直接打、E2E 也要能 type 进去），
 * 所以两条路都得过一遍同一个规范化函数，否则会出现
 * 「键盘打出来是 12.50，手打进去是 12.505」这种两套行为。
 */
function normalizeAmount(raw) {
  let s = String(raw ?? '').replace(/[^\d.]/g, '');
  const first = s.indexOf('.');
  if (first >= 0) s = `${s.slice(0, first + 1)}${s.slice(first + 1).replace(/\./g, '')}`;
  const [intPart, decPart] = s.split('.');
  const int = intPart.slice(0, 8);
  if (decPart === undefined) return int;
  return `${int}.${decPart.slice(0, 2)}`;
}

/**
 * 数字键盘的键位表。
 *
 * 布局（4 列 × 4 行，和参考图一致）：
 *     1   2   3   日期
 *     4   5   6   ＋（收入）
 *     7   8   9   －（支出）
 *     .   0   ⌫   ✓（保存，圆形）
 *
 * 用显式 gridArea 而不是靠自动排布：格子全是 1×1 也先别省 ——
 * 一旦以后哪格要跨行，自动排布会把它后面的键挤到不可预期的位置。
 *
 * 🔴 `＋` / `－` 是**收支方向切换**，不是金额加减（用户 2026-09-23 确认）。
 *    参考图顶部没有单独的「支出 / 收入」胶囊，方向就靠这两格切：
 *    当前方向那一格高亮，另一格是灰的。所以别再把 `.led-dir` 胶囊加回来。
 */
const PAD_KEYS = [
  { k: '1', r: 1, c: 1 }, { k: '2', r: 1, c: 2 }, { k: '3', r: 1, c: 3 },
  { k: 'date', label: '📅', cls: 'led-key--fn', r: 1, c: 4 },
  { k: '4', r: 2, c: 1 }, { k: '5', r: 2, c: 2 }, { k: '6', r: 2, c: 3 },
  { k: 'in', label: '＋', cls: 'led-key--fn led-key--dir', r: 2, c: 4, dir: 'income' },
  { k: '7', r: 3, c: 1 }, { k: '8', r: 3, c: 2 }, { k: '9', r: 3, c: 3 },
  { k: 'out', label: '－', cls: 'led-key--fn led-key--dir', r: 3, c: 4, dir: 'expense' },
  { k: '.', label: '.', r: 4, c: 1 },
  { k: '0', r: 4, c: 2 },
  { k: 'del', label: '⌫', cls: 'led-key--fn', r: 4, c: 3 },
  // 保存键照参考图做成**圆形对勾**。标签不是「保存」了，
  // 所以测试一律用 `[data-action="save-entry"]` 定位，别再按文字找。
  { k: 'save', label: '✓', cls: 'led-key--ok btn btn--primary', r: 4, c: 4 },
];

/**
 * 日期键 / 日期行的显示文案。
 * 今天 / 昨天给「人话」，其余给「月-日 + 星期」——
 * 记账绝大多数是补当天的账，写「今天」比写「09-22」更快认出来。
 */
function dateChipLabel(date) {
  const today = formatDate(new Date());
  const d1 = new Date(); d1.setDate(d1.getDate() - 1);
  if (date === today) return `今天 ${date.slice(5)}`;
  if (date === formatDate(d1)) return `昨天 ${date.slice(5)}`;
  const wd = weekdayName(new Date(String(date).replace(/-/g, '/')));
  return `${date.slice(5)} ${wd}`;
}

/**
 * 流水来源角标（v1.7.0，v1.9.0 收窄）。
 * 账户页镜像过来的流水要明确标出「来自账户」——
 * 删账户或关掉月扣款时余额会变，用户在账单上得能认出是哪来的。
 *
 * v1.9.0 起账户「消费」不再进总账，所以这里只会遇到两部分：
 *   · 充值（`acct_in`）—— 钱从哪张卡充进来的
 *   · 每月扣款 —— 定时任务自动落的流水
 */
/**
 * 流水来源标签（纯文本，**不带分隔符**）。
 *
 * 🔴 v1.13.5：以前这里返回值自带前缀 `' · '`，因为当时只有一个调用点、
 *    直接拼在字符串尾巴上。现在副标题是几段拼起来的，让被调用方带分隔符
 *    会拼出 `备注 ·  · 来自账户 · 充值` 这种双分隔符。分隔符归调用方管。
 */
function sourceTag(e) {
  if (e.fromAccount) {
    return e.source === 'recurring' ? '来自账户 · 每月扣款' : '来自账户 · 充值';
  }
  if (e.source === 'image' || e.source === 'text') return '自动识别';
  return '';
}

export function LedgerView(ctx) {
  const root = h('div', { class: 'app-body' });
  let month = monthKey(new Date());

  /** 近 6 个月支出趋势（单独取，避免 overview 每次都算） */
  let trendData = [];

  /** 正在编辑的草稿：null=不显示表单；对象=显示表单 */
  let draft = null;

  /** 未归档账户，供「消费账户」选择器用（v1.13.5） */
  let accounts = [];

  /** ledgerId → 账户名。列表里标出「这笔钱从哪个账户走的」（v1.13.5） */
  let linkNames = new Map();

  /**
   * v1.6.0：消费快速记录抽屉传进来的动作。
   * 在首次 render 之后执行，因为 openForm / importFromImage 内部都会自己再 render 一次。
   */
  const pendingAction = ctx.params?.action || null;

  async function render() {
    // v1.9.0：账户「消费」不再进记账总账（避免同一笔钱算两遍）。
    // 历史上 v1.7–v1.8 已经镜像过来的 acct_out 支出在这里清一次（幂等，靠 kv 标记）。
    try {
      await AccountService.purgeAcctLedgerMirrors();
    } catch (err) {
      console.warn('[ledger_view] 清理旧账户镜像失败：', err && err.message);
    }
    // v1.13.7：账户之间的**转账**也不再进总账（用户 2026-09-24）。
    // v1.13.5 起已经镜像过去的那批在这里清一次（同样是 kv 标记，只跑一次）。
    try {
      await AccountService.purgeTransferLedgerMirrors();
    } catch (err) {
      console.warn('[ledger_view] 清理转账镜像失败：', err && err.message);
    }

    const ov = await LedgerService.overview(month);
    trendData = await LedgerService.trend(6);

    // v1.13.5：账户数据只为「消费账户」选择器和列表上的账户名服务。
    // 读失败不能拖垮整页 —— 记账本身不依赖账户，退化成「没有账户可选」即可。
    try {
      const all = await AccountService.list();
      accounts = all.filter((a) => !a.archived);
      linkNames = await AccountService.linkedAccountNames();
    } catch (err) {
      console.warn('[ledger_view] 读取账户失败，本次不显示消费账户选项：', err && err.message);
      accounts = [];
      linkNames = new Map();
    }

    mount(root, [
      buildMonthNav(),
      buildSummaryCard(ov),
      buildActions(),
      // v1.13.5：表单不再插在页面里，改成从底部弹出的浮层（openSheet）。
      // 页面重绘和表单生命周期彻底解耦 —— 表单开着的时候切月份、改预算都不会把它顶掉。
      ov.byCategory.length ? buildCategoryBreakdown(ov) : null,
      buildTrend(ov),
      buildEntryList(ov),
    ]);
  }

  /* ---------------- 月份切换 ---------------- */

  function buildMonthNav() {
    const [y, m] = month.split('-').map(Number);
    const isCurrent = month === monthKey(new Date());
    return h('div', { class: 'cal-nav' }, [
      h('button', { class: 'cal-nav__btn', onclick: () => { month = shiftMonth(month, -1); render(); } }, h('span', { html: Icons.chevronLeft })),
      h('div', { class: 'cal-nav__center' }, [
        h('div', { class: 'cal-nav__month', text: `${y} 年 ${m} 月` }),
        h('div', { class: 'cal-nav__sub', text: isCurrent ? '本月' : '历史月份' }),
      ]),
      h('button', {
        class: 'cal-nav__btn',
        disabled: isCurrent,
        style: isCurrent ? { opacity: '.4', cursor: 'default' } : null,
        onclick: () => { if (isCurrent) return; month = shiftMonth(month, 1); render(); },
      }, h('span', { html: Icons.chevronRight })),
    ]);
  }

  /* ---------------- 汇总卡 ---------------- */

  function buildSummaryCard(ov) {
    const { stats, budget, usedRate, remaining, overBudget, aheadOfPace, expectedRate } = ov;
    const over = overBudget ? ' is-over' : (aheadOfPace ? ' is-warn' : '');

    const rows = [
      h('div', { class: 'sum-cell' }, [
        h('div', { class: 'sum-cell__label', text: '支出' }),
        h('div', { class: 'sum-cell__value sum-cell__value--expense', text: `¥${stats.expense.toFixed(2)}` }),
      ]),
      h('div', { class: 'sum-cell' }, [
        h('div', { class: 'sum-cell__label', text: '收入' }),
        h('div', { class: 'sum-cell__value sum-cell__value--income', text: `¥${stats.income.toFixed(2)}` }),
      ]),
      h('div', { class: 'sum-cell' }, [
        h('div', { class: 'sum-cell__label', text: '结余' }),
        h('div', {
          class: `sum-cell__value ${stats.balance < 0 ? 'sum-cell__value--expense' : 'sum-cell__value--income'}`,
          text: `¥${stats.balance.toFixed(2)}`,
        }),
      ]),
    ];

    const budgetBlock = budget > 0
      ? h('div', { class: `budget${over}` }, [
        h('div', { class: 'budget__head' }, [
          h('span', { class: 'budget__label', html: `${Icons.target}<span>本月预算</span>` }),
          h('span', { class: 'budget__amount', text: `¥${budget.toFixed(2)}` }),
        ]),
        h('div', { class: 'budget__bar' }, [
          h('div', { class: 'budget__fill', style: { width: `${Math.min(100, usedRate)}%` } }),
          // 参考线：按已过去天数应花的比例
          h('div', { class: 'budget__pace', style: { left: `${Math.min(100, expectedRate)}%` }, title: `按进度应花 ${expectedRate}%` }),
        ]),
        h('div', { class: 'budget__foot' }, [
          h('span', {
            class: 'budget__used',
            text: overBudget
              ? `已超支 ¥${Math.abs(remaining).toFixed(2)}`
              : `剩余 ¥${remaining.toFixed(2)} · 已用 ${usedRate}%`,
          }),
          h('button', { class: 'budget__edit', onclick: editBudget }, '修改'),
        ]),
      ])
      : h('button', { class: 'budget budget--empty', onclick: editBudget }, [
        h('span', { html: `${Icons.target}<span>设置本月预算</span>` }),
        h('span', { class: 'budget__cta', text: '去设置 →' }),
      ]);

    return h('div', { class: 'sum-card' }, [
      h('div', { class: 'sum-card__row' }, rows),
      budgetBlock,
    ]);
  }

  /* ---------------- 快捷动作 ---------------- */

  function buildActions() {
    return h('div', { class: 'led-actions' }, [
      h('button', { class: 'led-action led-action--primary', onclick: () => openForm(null) }, [
        h('span', { html: Icons.plus }),
        h('span', { text: '记一笔' }),
      ]),
      h('button', { class: 'led-action', onclick: importFromImage }, [
        h('span', { html: Icons.camera }),
        h('span', { text: '识别图片' }),
      ]),
      h('button', { class: 'led-action', onclick: importFromText }, [
        h('span', { html: Icons.edit }),
        h('span', { text: '粘贴文字' }),
      ]),
    ]);
  }

  /* ---------------- 分类占比 ---------------- */

  function buildCategoryBreakdown(ov) {
    const top = ov.byCategory.slice(0, 5);
    const max = top[0]?.total || 1;
    const total = ov.stats.expense || 1;

    return h('div', {}, [
      h('div', { class: 'section-title', text: '支出构成' }),
      h('div', { class: 'cat-break' }, top.map((c) => h('div', { class: 'cat-break__row' }, [
        h('span', { class: 'cat-break__icon', text: c.icon }),
        h('span', { class: 'cat-break__label', text: c.label }),
        h('span', { class: 'cat-break__bar' }, [
          h('i', { style: { width: `${Math.round((c.total / max) * 100)}%`, background: c.color } }),
        ]),
        h('span', { class: 'cat-break__amount', text: `¥${c.total.toFixed(2)}` }),
        h('span', { class: 'cat-break__pct', text: `${Math.round((c.total / total) * 100)}%` }),
      ]))),
    ]);
  }

  /* ---------------- 近月趋势（曲线图） ---------------- */

  /**
   * 图上看的是支出还是收入（用户 2026-09-23 给的参考图里带这个切换）。
   * 放在闭包外，切完页签回来还保持用户上次的选择。
   */
  let trendDir = DIRECTION.EXPENSE;

  /**
   * 近 6 个月趋势 —— **曲线图**（用户 2026-09-23 第 3 条，给了参考图）。
   *
   * 参考图的要点：一条平滑曲线 + 曲线下的渐变填充 + 几条横向网格线 +
   * 峰值那个点套一个「空心圆环」+ 一条虚线垂到基线 + 两端轴标签。
   *
   * 🔴 为什么手拼 SVG 字符串而不引图表库：本项目**零依赖、零构建**（MEMORY 红线 1）。
   *    曲线用 Catmull-Rom 转三次贝塞尔，控制点 y 夹在绘图区内 ——
   *    不夹的话 Catmull-Rom 会过冲，曲线会钻到基线下面去（看着像负支出）。
   */
  function buildTrend(ov) {
    if (!ov.entries.length || !trendData.length) return null;

    const box = h('div', { class: 'led-trend-card', dataset: { trend: '1' } });
    const paint = () => mount(box, [h('div', { class: 'led-trend__inner' }, trendInner())]);

    function trendInner() {
      const isExp = trendDir === DIRECTION.EXPENSE;
      const dirWord = isExp ? '支出' : '收入';
      const values = trendData.map((t) => (isExp ? t.expense : t.income));
      const max = Math.max(...values, 1);
      const allZero = values.every((v) => v === 0);

      /* ---- 几何：viewBox 固定 320×112，整体等比缩放（圆环才不会被拉成椭圆） ---- */
      const W = 320; const H = 112;
      const padL = 8; const padR = 8; const padT = 14; const padB = 10;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const baseY = padT + plotH;
      const stepX = plotW / Math.max(1, values.length - 1);
      const pts = values.map((v, i) => ({
        x: padL + i * stepX,
        // v = max 顶到 padT，v = 0 落在基线上
        y: baseY - (v / max) * plotH,
      }));

      const clampY = (y) => Math.min(baseY, Math.max(padT, y));
      let line = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2] || p2;
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
        line += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
      }
      const area = `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${baseY} L ${pts[0].x.toFixed(1)} ${baseY} Z`;

      // 峰值那个点 —— 参考图高亮的就是它。
      // ⚠️ 用 `>=`：并列时取**最近的那个月**。用 `>` 的话「每月都是 500」这种
      //    平线会去高亮 6 个月前那一格，看着很没道理。
      let peak = 0;
      values.forEach((v, i) => { if (v >= values[peak]) peak = i; });
      const pk = pts[peak];

      // 参考图里是 **3 条**横向网格线：顶线正好压在峰值那一格（= max 的高度）、
      // 中间一条、底线（= 基线）。所以取 [0, 1/2, 1] 而不是 [0, 1/3, 2/3, 1] ——
      // 6 个点画 4 条线太密，参考图那版更透气。
      const grid = [0, 1 / 2, 1]
        .map((f) => `<line x1="${padL}" y1="${(padT + plotH * f).toFixed(1)}" x2="${W - padR}" y2="${(padT + plotH * f).toFixed(1)}" class="led-trend__grid" />`)
        .join('');

      const svg = `<svg class="led-trend__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
  <defs>
    <linearGradient id="ledTrendFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--c-primary)" stop-opacity=".22" />
      <stop offset="100%" stop-color="var(--c-primary)" stop-opacity="0" />
    </linearGradient>
  </defs>
  ${grid}
  <path d="${area}" fill="url(#ledTrendFill)" stroke="none" />
  <path d="${line}" fill="none" class="led-trend__line" />
  ${allZero ? '' : `<line x1="${pk.x.toFixed(1)}" y1="${pk.y.toFixed(1)}" x2="${pk.x.toFixed(1)}" y2="${baseY}" class="led-trend__drop" />
  <circle cx="${pk.x.toFixed(1)}" cy="${pk.y.toFixed(1)}" r="5" class="led-trend__dot" />`}
</svg>`;

      /* ---- 顶部：标题 + 支出/收入切换 ---- */
      const seg = h('div', { class: 'led-trend__seg' }, [
        h('button', {
          class: `led-trend__seg-item${isExp ? ' led-trend__seg-item--on' : ''}`,
          dataset: { dir: DIRECTION.EXPENSE },
          onclick: () => { if (trendDir === DIRECTION.EXPENSE) return; trendDir = DIRECTION.EXPENSE; paint(); },
        }, '支出'),
        h('button', {
          class: `led-trend__seg-item${!isExp ? ' led-trend__seg-item--on' : ''}`,
          dataset: { dir: DIRECTION.INCOME },
          onclick: () => { if (trendDir === DIRECTION.INCOME) return; trendDir = DIRECTION.INCOME; paint(); },
        }, '收入'),
      ]);

      return [
        h('div', { class: 'led-trend__head' }, [
          h('div', {}, [
            h('div', { class: 'led-trend__title', text: '近 6 个月' }),
            h('div', { class: 'led-trend__sub', text: isExp ? '按月查看支出变化' : '按月查看收入变化' }),
          ]),
          seg,
        ]),
        // 读数：当前高亮那个月 + 金额（参考图那行「8月4日 · 支出 ¥306.85」）
        h('div', { class: 'led-trend__readout' }, [
          h('span', { class: 'led-trend__dot-sep' }),
          h('span', {
            text: `${trendData[peak].label} · ${dirWord} ${money(values[peak])}`,
          }),
        ]),
        h('div', { class: 'led-trend__plot', html: svg }),
        h('div', { class: 'led-trend__axis' }, [
          h('span', { text: trendData[0].label }),
          h('span', { text: trendData[trendData.length - 1].label }),
        ]),
      ];
    }

    paint();
    return box;
  }

  /* ---------------- 流水列表 ---------------- */

  /**
   * 组头日期文案：`2026-09-24` → `09月24日 周四`
   *
   * 参考图里写的是「05月09日 周一」。原来的 `09-24 周四` 也能看，
   * 但少了「日」这个字，和后面跟着的 `支出 385` 排在一起时断句不清 ——
   * 「09-24 周四 支出 385」像一串编号，而「09月24日 周四 | 支出 385」
   * 一眼能看出「哪天 · 哪个方向 · 多少钱」三段。
   */
  function dayLabel(date) {
    const d = new Date(date.replace(/-/g, '/'));
    return `${date.slice(5, 7)}月${date.slice(8, 10)}日 ${weekdayName(d)}`;
  }

  /**
   * 流水列表 —— 版式照用户给的参考图（v1.13.5）。
   *
   * 参考图的结构是「日期 + 支出金额」的**胶囊组头**，下面跟一串**平铺**的行：
   *
   *   [ 05月09日 周一 | 支出 385 ]        ← 圆角浅底胶囊，宽度只包住内容
   *   🍲  餐饮                             ← 分类名（大、深色）
   *       跟同事一起AA                      ← 备注（小、灰色）
   *                                        -42.5   ← 深色数字，靠符号区分方向
   *
   * 四处和旧版式**不同**，都是照图改的，不要顺手改回去：
   *   ① 组头从「两端对齐的一行小字」变成**只包内容的胶囊**。
   *   ② 行不再是一张卡片：去掉卡片底、边框和行间分隔线，图标从圆角方块改成**正圆**。
   *   ③ **分类名当标题、备注降为副标题**（旧版是反的）。
   *      参考图里大号那行是「餐饮 / 购物 / 通讯」= 分类，小号那行才是备注。
   *   ④ 金额改成深色 + 正负号（`-42.5`），不再是红/绿。
   *      方向已经由组头的「支出 / 收入」和行首的符号说清楚了，
   *      满屏红绿反而会和账户页的配色抢注意力。改回彩色只需改 CSS。
   *
   * 🔴 **一天只有一组。**（用户 2026-09-23：「记账里面同一天的收入和支出放在一起啊」）
   *    v1.13.5 最初按「日期 → 收支方向」两级分组，一天里既有支出又有收入就**裂成两个
   *    `.led-day`**，同一天被拆成上下两块、各带一个小计 —— 扫起来像两天，用户要来回
   *    对两次日期才知道是同一天。现在同一天的收支在同一个 `.led-day` 里，
   *    组头把两边的小计都报出来：
   *
   *      [ 09月19日 周六 | 支出 22.5 · 收入 500 ]
   *
   *    ⚠️ 只有一边有就**只显示那一边**，不给另一边补「收入 0」——
   *    零值小计是纯噪音，用户这天没记收入，不需要被告知。
   */
  function buildEntryList(ov) {
    if (!ov.entries.length) {
      return h('div', { class: 'empty-state' }, [
        h('div', { class: 'empty-state__icon', text: '🧾' }),
        h('div', { class: 'empty-state__title', text: '本月还没有记账' }),
        h('div', { class: 'empty-state__desc', text: '点「记一笔」手动添加，或直接用支付截图一键识别。' }),
      ]);
    }

    // 按**日期**分组。`ov.entries` 已是「日期倒序 + 同日内录入时间倒序」，顺序 push 即可。
    // 🔴 同一天内部**不再按方向二次排序** —— 流水是流水，录入先后本身就是信息，
    //    重排会让「先记的在上、后记的在下」这条线索消失。
    //    （组头里的小计顺序仍固定「支出在前、收入在后」，那只是标签顺序。）
    const days = new Map();
    ov.entries.forEach((e) => {
      if (!days.has(e.date)) days.set(e.date, []);
      days.get(e.date).push(e);
    });

    const wrap = h('div', {});
    wrap.appendChild(h('div', { class: 'section-title', text: `流水明细（${ov.stats.count} 笔）` }));

    days.forEach((list, date) => {
      const out = list.filter((e) => e.isExpense);
      const inc = list.filter((e) => !e.isExpense);
      const sumOf = (arr) => arr.reduce((s, e) => s + e.amount, 0);

      // 支出在前、收入在后 —— 与顶部方向切换、汇总卡的顺序一致
      const sums = [];
      if (out.length) sums.push({ word: '支出', total: sumOf(out) });
      if (inc.length) sums.push({ word: '收入', total: sumOf(inc) });

      wrap.appendChild(h('div', { class: 'led-day' }, [
        h('div', { class: 'led-day__head' }, [
          h('span', { class: 'led-day__date', text: dayLabel(date) }),
          h('span', { class: 'led-day__sep' }),
          // 每组小计包成 `.led-day__sum`，两个方向各一个 —— 窄屏要换行时
          // 断在「方向 + 数字」之间才不会把「支出」和「385」拆到两行
          ...sums.map((s) => h('span', { class: 'led-day__sum' }, [
            h('span', { class: 'led-day__dir', text: s.word }),
            h('span', { class: 'led-day__total', text: amountShort(s.total) }),
          ])),
        ]),
        h('div', { class: 'led-day__items' }, list.map((e) => {
          const meta = e.categoryMeta;
          // 挂过消费账户的，把账户名标出来 —— 用户得能一眼看出这笔钱是从哪张卡走的
          const acct = linkNames.get(String(e.id));
          const sub = [e.note, acct ? `账户 · ${acct}` : '', sourceTag(e)]
            .filter(Boolean).join(' · ');
          return h('button', {
            class: 'led-item',
            dataset: { entryId: String(e.id) },
            onclick: () => openItemMenu(e),
          }, [
            h('span', { class: 'led-item__icon', style: { background: `${meta.color}18`, color: meta.color }, text: meta.icon }),
            h('span', { class: 'led-item__main' }, [
              h('span', { class: 'led-item__title', text: meta.label }),
              // 没备注、没账户、也不是镜像流水时不留一行空的 —— 空元素会白白撑高行
              sub ? h('span', { class: 'led-item__desc', text: sub }) : null,
            ]),
            h('span', {
              class: `led-item__amount ${e.isExpense ? 'led-item__amount--expense' : 'led-item__amount--income'}`,
              text: signedAmount(e.amount, e.isExpense),
            }),
          ]);
        })),
      ]));
    });

    return wrap;
  }

  /* ---------------- 表单：从底部弹出的浮层 ---------------- */

  /*
   * v1.13.5（第二轮）：表单从「插在页面里的内联块」改成**从底部弹出的浮层模块**。
   *
   * 用户原话：「记一笔的时候，我要的效果是，从底部弹出一个模块，如图一样，
   * 是一个全新的 ui 模块」。
   *
   * 这个改动顺带**彻底消灭**了上一轮那个「点记一笔就滑到最底下」的问题：
   * 浮层是 `position: fixed` 的，跟页面滚动完全无关，
   * 所以 `scrollFormIntoView()` 那一整套推导（以及配套的「要不要垫底占位」的讨论）
   * 全部作废，已经删掉。别再把它加回来。
   *
   * 🔴 浮层必须登记进 `dom.js` 的浮层栈（`pushOverlay`），并且 dismiss 走
   *    `closeSheet()` 这个**正常取消路径**，绝不能写 `overlay.remove()` ——
   *    见 MEMORY.md 红线 13。
   */

  /** 当前打开的浮层句柄：null = 没开 */
  let sheet = null;

  /**
   * 「打开表单」的序号，用来作废还没跑完的 openForm。
   *
   * 🔴 为什么需要：`openForm` 是 async 的 —— 编辑已有流水时要先 await
   *    `findLedgerLinks` 才知道当初挂了哪个账户。如果用户在这段 await 里
   *    点了「取消」（或按了返回键），`cancelForm` 会把 `draft` 清成 null，
   *    而 await 一恢复，`openSheet()` 照样去 `buildDraftForm()` 读
   *    `draft.direction` → **TypeError，浮层弹不出来还留一条未处理的 rejection**。
   *    （`verify_ledger_form.mjs` 里就是这么复现的：连点打开 + 取消。）
   */
  let formSeq = 0;

  async function openForm(entry) {
    const seq = ++formSeq;
    const base = entry
      ? { ...entry.toRecord(), direction: entry.direction, category: entry.category }
      : { amount: '', direction: DIRECTION.EXPENSE, category: 'meal', note: '', date: formatDate(new Date()), source: 'manual' };
    draft = {
      id: entry ? entry.id : null,
      amount: base.amount === '' ? '' : String(base.amount),
      direction: base.direction,
      category: base.category,
      note: base.note || '',
      date: base.date,
      source: base.source || 'manual',
      // 🔴 账户是**三态**，别压成两态：
      //      undefined = 用户还没选（新建时的初始态，保存会被拦下）
      //      null      = 用户**明确**选了「不关联账户」
      //      数字      = 选了具体账户
      //    压成两态就没法区分「没选」和「选了不关联」，
      //    「必选」也就无从谈起（这正是用户 2026-09-23 提的第 2 条）。
      accountId: undefined,
    };
    if (entry) {
      // 编辑时要把当初挂的账户带出来。
      // 不带的话，用户改个备注再保存，`linkLedger` 会先撤旧关联再按 null 走，
      // 账户上那笔扣款就悄悄没了 —— 余额凭空变多，用户只会以为「软件算错了」。
      try {
        const links = await AccountService.findLedgerLinks(entry.id);
        // 老数据（v1.13.5 之前记的）本来就没挂账户，按「不关联」回填，
        // 不然用户每改一次旧账都要重新选一遍账户，很烦。
        draft.accountId = links.length ? links[0].accountId : null;
      } catch (err) {
        console.warn('[ledger_view] 读取挂账账户失败：', err && err.message);
        draft.accountId = null;
      }
    }
    // 等数据的这段时间里用户可能已经取消了 —— 那就别再弹了
    if (seq !== formSeq || !draft) return;
    openSheet();
  }

  /** 打开浮层。重复调用（比如连点两次「记一笔」）不会叠出两层 */
  function openSheet() {
    if (!draft) return;      // 兜底：任何路径下都不允许拿着空草稿渲染
    // ⚠️ `closeSheet()` 会把 draft 一起清掉，而这里是要**换一层**、不是要取消，
    //    所以先把草稿接住，收完旧的再放回去。
    const keep = draft;
    if (sheet) closeSheet();
    draft = keep;

    const panel = h('div', { class: 'led-form' });
    const overlay = h('div', { class: 'modal-overlay modal-overlay--bottom' }, [panel]);
    // 点遮罩 = 取消（和 actionSheet 的行为一致）
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancelForm(); });
    document.body.appendChild(overlay);

    /**
     * 键盘 Esc = 返回键。
     *
     * 安卓壳里有原生返回键（走 `pushOverlay` 登记的 dismiss），
     * 但**浏览器 / 桌面 PWA 里没有** —— 那边用户唯一的「退出去」手段
     * 就是点遮罩或点「‹」，很多人会下意识按 Esc，按了没反应就像卡死了。
     *
     * 🔴 这里刻意调 `dismissTopOverlay()` 而**不是**直接 `cancelForm()`：
     *    表单上还会叠一层 actionSheet（选账户 / 选日期），
     *    那种时候 Esc 应该先关上面那一层，而不是把整个表单一起收掉。
     *    `dismissTopOverlay()` 走的是各浮层自己登记的 dismiss（红线 13），
     *    所以底层那个 `await actionSheet(...)` 会正常 resolve。
     */
    const onKey = (e) => { if (e.key === 'Escape') dismissTopOverlay(); };
    document.addEventListener('keydown', onKey);

    sheet = {
      overlay,
      panel,
      onKey,
      /** 只重绘浮层内部。页面不用跟着重绘 —— 表单开着时页面上的数字本来就没变 */
      paint() {
        if (!draft) return;  // 同上：草稿没了就别画
        mount(panel, [buildDraftForm()]);
      },
    };
    sheet.paint();
    // 返回键 = 走正常取消路径（红线 13）
    pushOverlay(overlay, () => cancelForm());
  }

  /**
   * 关掉浮层。取消 / 返回键 / 保存成功后都走这里。
   *
   * ⚠️ 这里**只负责收浮层**，不负责重绘页面 —— 重绘交给调用方，
   *    因为「取消」不需要重绘（页面本来就没动），「保存」才需要（要把新流水刷出来）。
   */
  function closeSheet() {
    // 作废任何还在 await 里的 openForm（见 formSeq 的说明）
    formSeq += 1;
    if (!sheet) { draft = null; return; }
    // Esc 监听是挂在 document 上的，不收就会一直留着（每开一次多一个）
    if (sheet.onKey) document.removeEventListener('keydown', sheet.onKey);
    popOverlay(sheet.overlay);
    sheet.overlay.remove();
    sheet = null;
    draft = null;
  }

  /** 取消：收浮层 + 重绘（把可能残留的高亮状态清掉） */
  function cancelForm() {
    closeSheet();
    render();
  }

  /* ---------------- 表单：日期 / 账户 ---------------- */

  /** 选日期：今天 / 昨天 / 前天 / 自己填（自己填走 parseDateInput，多种写法都认） */
  async function pickDate() {
    const today = formatDate(new Date());
    const d1 = new Date(); d1.setDate(d1.getDate() - 1);
    const d2 = new Date(); d2.setDate(d2.getDate() - 2);
    const act = await actionSheet({
      title: '这笔账记在哪天',
      actions: [
        { label: `今天（${today.slice(5)}）`, value: today },
        { label: `昨天（${formatDate(d1).slice(5)}）`, value: formatDate(d1) },
        { label: `前天（${formatDate(d2).slice(5)}）`, value: formatDate(d2) },
        { label: '其他日期…', value: '__pick' },
      ],
    });
    // actionSheet 只有两种返回：null=取消，其余是选项值（都是非空字符串）
    if (act === null) return;

    if (act === '__pick') {
      const raw = await promptDialog({
        title: '输入日期',
        message: '2026-10-01、2026.10.1、2026/10/1、2026年10月1日 都认。',
        value: draft.date,
        placeholder: '例如：2026-10-01',
        okText: '确定',
        required: true,
        requiredHint: '填一个日期，或者点「取消」',
      });
      if (raw === null) return;
      const parsed = parseDateInput(raw);
      if (!parsed) { toast('日期看不懂，试试 2026-10-01 或 2026.10.1', 'warn'); return; }
      draft.date = parsed;
    } else {
      draft.date = act;
    }
    sheet?.paint();
  }

  /**
   * 选「关联账户」。
   *
   * 口径（用户确认）：选了具体账户就**真从该账户扣钱**，并计入该账户的累计消耗；
   * 记账总账里仍然只有这一笔。「不关联账户」也是**要主动点的一个选项** ——
   * 它不再是一个默认值（用户 2026-09-23 第 2 条）。
   */
  async function pickAccount() {
    const isIncome = draft.direction === DIRECTION.INCOME;
    const act = await actionSheet({
      title: isIncome ? '这笔钱存进哪个账户' : '这笔钱从哪个账户扣',
      // 一个账户都没有时给一句出路，别让用户对着空列表发懵
      message: accounts.length ? undefined : '你还没有账户。可以先选「不关联账户」，或去「账户」页建一个再回来。',
      actions: [
        { label: '不关联账户', value: '__none' },
        ...accounts.map((a) => ({
          label: `${a.name}（余额 ¥${a.balance.toFixed(2)}）`,
          value: String(a.id),
        })),
      ],
    });
    // actionSheet 只有两种返回：null=取消（保持原选择不变），其余是选项值
    if (act === null) return;
    draft.accountId = act === '__none' ? null : Number(act);
    sheet?.paint();
  }

  /* ---------------- 浮层内容 ---------------- */

  /**
   * 浮层内容 —— 版式照参考图（v1.13.5 第二轮）。
   *
   * 自上而下：
   *   ‹ 返回 + 居中标题
   *   支出 / 收入（真实状态，不是解释 —— 方向由键盘上的 ＋ / － 切）
   *   4 列圆形分类格（沿用现有 8 个支出 / 4 个收入类目）
   *   大号金额
   *   备注行 / 账户行
   *   4 列自定义键盘
   *
   * 🔴 每次调用都返回**一棵新树**，由 `sheet.paint()` 整体换上。
   *    所以这里不能依赖任何 DOM 引用跨次存活 —— 状态全在 `draft` 里。
   */
  function buildDraftForm() {
    const isIncome = draft.direction === DIRECTION.INCOME;

    /* ---- 顶部：返回 + 标题 ---- */
    // 参考图顶部只有一个「‹」和居中的「记一笔」，没有收支胶囊 ——
    // 方向改由键盘上的 ＋ / － 切，所以这里不再渲染 .led-dir。
    const head = h('div', { class: 'led-form__head' }, [
      h('button', {
        class: 'btn btn--ghost btn--sm led-form__cancel',
        dataset: { action: 'close-entry' },
        'aria-label': '取消',
        onclick: cancelForm,
      }, [h('span', { class: 'led-form__cancel-icon', html: Icons.chevronLeft })]),
      h('span', {
        class: 'led-form__title',
        text: draft.id ? '编辑记录' : (draft.source !== 'manual' ? '确认识别结果' : '记一笔'),
      }),
      // 占位，让标题真正居中（否则会被左边的返回键顶偏）
      h('span', { class: 'led-form__head-spacer' }),
    ]);

    /* ---- 方向状态 ---- */
    const dirTag = h('div', {
      class: `led-form__dir led-form__dir--${isIncome ? 'income' : 'expense'}`,
      dataset: { dir: draft.direction },
      text: isIncome ? '收入' : '支出',
    });

    /* ---- 大号金额 ---- */
    // 🔴 `inputmode="none"` 是关键：手机上点它**不弹系统键盘**，
    //    因为下面已经有一块自己的键盘了。但它仍然是可编辑的 input，
    //    桌面物理键盘照常能打，E2E 也照常能 type —— 不需要为测试留后门。
    const amountBox = h('div', {
      class: 'led-amount',
      dataset: { tone: isIncome ? 'income' : 'expense', filled: draft.amount ? '1' : '0' },
    });
    const amountI = h('input', {
      class: 'input input--amount led-amount__input',
      type: 'text',
      inputmode: 'none',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: '0.00',
      value: draft.amount,
      dataset: { field: 'amount' },
      oninput: (e) => {
        const v = normalizeAmount(e.target.value);
        draft.amount = v;
        if (e.target.value !== v) e.target.value = v;
        amountBox.dataset.filled = v ? '1' : '0';
      },
    });
    // 参考图里金额是**裸的一行数字**（没有 ¥ 前缀）——
    // 方向由上面的胶囊说、是不是钱由分类说，不必再挂一个币号。
    amountBox.appendChild(amountI);

    /**
     * 键盘上按数字只改这两处的显示，**不整棵重绘**。
     * 整棵重绘会把金额输入框的焦点和光标一起弄丢 ——
     * 用户用物理键盘打了一半再点一下键盘，光标就跳回开头了。
     */
    const syncAmount = () => {
      if (amountI.value !== draft.amount) amountI.value = draft.amount;
      amountBox.dataset.filled = draft.amount ? '1' : '0';
    };

    function onPad(key) {
      if (key === 'del') {
        draft.amount = String(draft.amount || '').slice(0, -1);
        syncAmount();
        return;
      }
      if (key === 'date') { pickDate(); return; }
      if (key === 'save') { saveDraft(); return; }
      // ＋ / － = 收支方向切换（用户确认；不是金额加减）
      if (key === 'in' || key === 'out') {
        const dir = key === 'in' ? DIRECTION.INCOME : DIRECTION.EXPENSE;
        if (draft.direction === dir) return;
        draft.direction = dir;
        // 切方向时把分类纠正到该方向的合法类目，否则会存出
        // 「支出方向 + 生活费分类」这种自相矛盾的数据
        if (getLedgerCategory(draft.category).direction !== dir) {
          draft.category = dir === DIRECTION.INCOME ? 'allowance' : 'meal';
        }
        sheet?.paint();
        return;
      }

      const v = String(draft.amount || '');
      if (key === '.') {
        if (v.includes('.')) return;                 // 只允许一个小数点
        draft.amount = v ? `${v}.` : '0.';           // 直接点小数点 → 0.
        syncAmount();
        return;
      }
      const dot = v.indexOf('.');
      if (dot >= 0 && v.length - dot - 1 >= 2) return;   // 小数位已满 2 位
      if (dot < 0 && v.length >= 8) return;              // 整数位上限 8 位
      // 前导 0 换掉：连按「0 5」得到 5，而不是 05
      draft.amount = (v === '0' ? '' : v) + key;
      syncAmount();
    }

    /* ---- 分类格子（4 列圆形） ---- */
    const catPicker = h('div', { class: 'led-cat-picker' }, ledgerCategoriesOf(draft.direction).map((c) => h('button', {
      class: `led-cat${draft.category === c.id ? ' led-cat--active' : ''}`,
      // 颜色走 CSS 自定义属性，具体怎么用（圆底 / 高亮环）交给 CSS。
      // 浅色底和描边在这里就拼好成 8 位 hex —— 见 style.css 里为什么不用 color-mix()
      style: { '--cat-color': c.color, '--cat-soft': `${c.color}1f`, '--cat-line': `${c.color}3d` },
      dataset: { cat: c.id },
      onclick: () => {
        if (draft.category === c.id) return;
        draft.category = c.id;
        // 分类只影响这一格的高亮，不值得整棵重绘
        catPicker.querySelectorAll('.led-cat').forEach((b) => {
          b.classList.toggle('led-cat--active', b.dataset.cat === c.id);
        });
      },
    }, [
      h('span', { class: 'led-cat__icon', text: c.icon }),
      h('span', { class: 'led-cat__label', text: c.label }),
    ])));

    /* ---- 备注行 ---- */
    const noteI = h('input', {
      class: 'input led-note',
      placeholder: '点击填写备注',
      value: draft.note,
      dataset: { field: 'note' },
      oninput: (e) => { draft.note = e.target.value; },
    });
    const noteRow = h('label', { class: 'led-field' }, [
      h('span', { class: 'led-field__k', text: '备注' }),
      noteI,
    ]);

    /* ---- 账户行（必选） ---- */
    // 🔴 用户 2026-09-23 第 2 条：「关联账户或者不关联账户的选项是必选项，
    //    要我们自己选，而不是默认不关联」。
    //    `draft.accountId === undefined` = 还没选 → 显示待办样式，保存会被拦下。
    const acctChosen = draft.accountId !== undefined;
    const acct = acctChosen && draft.accountId !== null
      ? accounts.find((a) => a.id === draft.accountId)
      : null;
    const acctText = !acctChosen
      ? '请选择账户'
      : (acct ? acct.name : '不关联账户');
    const acctRow = h('button', {
      class: `led-field led-field--btn${acctChosen ? '' : ' led-field--todo'}`,
      dataset: { action: 'pick-account', chosen: acctChosen ? '1' : '0' },
      onclick: pickAccount,
    }, [
      h('span', { class: 'led-field__k', text: '账户' }),
      h('span', {
        class: 'led-field__v',
        text: acctChosen && acct ? `${acctText}（余额 ¥${acct.balance.toFixed(2)}）` : acctText,
      }),
      h('span', { class: 'led-field__arrow', html: Icons.chevronRight }),
    ]);

    /* ---- 识别结果提示 ---- */
    const conf = draft.confidence != null
      ? h('div', { class: `notice ${draft.confidence >= 0.75 ? 'notice--info' : 'notice--warn'}` }, [
        h('span', { class: 'notice__icon', html: draft.confidence >= 0.75 ? Icons.check : Icons.warn }),
        h('span', {
          text: !draft.note
            // 没抓到备注要单独提示：分类只说明「哪一大类」，
            // 用户真正想留的是「这笔钱买的是什么」，必须引导补上。
            ? '已识别金额与分类，但没读出「这笔钱花在哪」——建议在备注里补一下。'
            : (draft.confidence >= 0.75
              ? '已自动识别，请核对金额、分类与备注后保存。'
              : '识别结果不太确定，请重点核对金额、分类与备注。'),
        }),
      ])
      : null;

    /* ---- 键盘 ---- */
    const pad = h('div', { class: 'led-pad' }, PAD_KEYS.map((k) => {
      const activeDir = k.dir && k.dir === draft.direction;
      return h('button', {
        class: `led-key${k.cls ? ` ${k.cls}` : ''}${activeDir ? ' led-key--active' : ''}`,
        style: { gridArea: `${k.r} / ${k.c} / span ${k.rs || 1} / span ${k.cs || 1}` },
        dataset: k.k === 'save' ? { action: 'save-entry' }
          : (k.dir ? { dir: k.dir } : { key: k.k }),
        'aria-label': k.k === 'save' ? '保存' : (k.dir ? (k.dir === 'income' ? '收入' : '支出') : undefined),
        onclick: () => onPad(k.k),
      }, k.label || k.k);
    }));

    return h('div', { class: 'led-form__body' }, [
      head,
      conf,
      dirTag,
      catPicker,
      amountBox,
      noteRow,
      acctRow,
      pad,
    ]);
  }

  async function saveDraft() {
    // 🔴 「账户」是**必选**（用户 2026-09-23 第 2 条）：没主动选过就不给存。
    //    拦在构造 LedgerEntry **之前** —— 先建对象再拦的话，
    //    用户会看到「金额不对」之类的次要报错，而真正的问题（没选账户）被盖掉。
    if (draft.accountId === undefined) {
      toast('先选一下这笔钱从哪个账户走（也可以选「不关联账户」）', 'warn');
      // 把那一行闪一下，让用户知道该点哪儿 —— 光弹提示还是得自己找
      const row = sheet?.panel.querySelector('.led-field--todo');
      if (row) {
        row.classList.add('led-field--shake');
        setTimeout(() => row.classList.remove('led-field--shake'), 700);
      }
      return;
    }

    const entry = new LedgerEntry({
      id: draft.id,
      amount: draft.amount,
      direction: draft.direction,
      category: draft.category,
      note: draft.note,
      date: draft.date,
      source: draft.source,
    });
    const check = entry.validate();
    if (!check.ok) { toast(check.errors[0], 'warn'); return; }
    try {
      if (entry.id) await LedgerService.update(entry);
      else entry.id = await LedgerService.add(entry);

      // 关联账户：真扣余额 + 计入该账户累计消耗。
      // 一条记账流水只挂一个账户 —— linkLedger 内部会先撤掉旧关联，
      // 所以「换账户 / 改金额」都不会叠加出第二条扣款。
      // 账户可能已经被删掉了，那就当成没挂账，不要因此让用户存不进去。
      const accId = (draft.accountId != null && accounts.some((a) => a.id === draft.accountId))
        ? draft.accountId : null;
      if (accId != null) await AccountService.linkLedger(accId, entry);
      else await AccountService.unlinkLedgerEverywhere(entry.id);

      // 保存后跳到该笔所在月份，确保用户能看到刚记的账
      month = entry.month;
      closeSheet();
      toast('已保存', 'success');
      render();
    } catch (err) {
      toast('保存失败：' + err.message, 'error');
    }
  }

  /* ---------------- 单条操作 ---------------- */

  async function openItemMenu(e) {
    // 账户镜像过来的流水不能在记账页直接改/删 —— 改了会两边对不上，
    // 而它真正的源头在「账户」页，所以引导用户去那里操作。
    if (e.fromAccount) {
      await actionSheet({
        title: `${e.note || e.categoryMeta.label} ¥${e.amount.toFixed(2)}`,
        message: e.source === 'recurring'
          ? '这笔是账户页「每月扣款」自动落的流水，改动请回账户页操作，这样两边的账才对得上。'
          : '这笔是你在账户页记的「充值」，改动请回账户页操作，这样两边的账才对得上。',
        actions: [{ label: '知道了', value: 'ok' }],
      });
      return;
    }
    const acct = linkNames.get(String(e.id));
    const act = await actionSheet({
      title: `${e.note || e.categoryMeta.label} ¥${e.amount.toFixed(2)}`,
      // 挂过消费账户的，明确说一句「钱是从哪儿走的」——
      // 用户删这笔账之前，得知道账户余额也会跟着回退。
      message: acct ? (e.isExpense ? `这笔钱从「${acct}」扣的` : `这笔钱存进了「${acct}」`) : undefined,
      actions: [
        { label: '编辑', value: 'edit' },
        { label: '删除', value: 'delete', danger: true },
      ],
    });
    if (act === 'edit') openForm(e);
    else if (act === 'delete') {
      const ok = await confirmDialog({
        title: '删除记录',
        message: acct
          ? `确定删除这笔记录吗？删除后不可恢复，同时会把「${acct}」上对应的那笔流水一起撤掉。`
          : '确定删除这笔记录吗？删除后不可恢复。',
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      // 🔴 顺序很重要：**先撤挂账，再删记账**。
      //    反过来一旦中间失败，会留下「记账已经没了、但账户还在扣」的幽灵支出 ——
      //    用户在记账页根本看不到它，只能靠对账差额去猜。
      //    先撤挂账的话，最坏情况是「记账还在、但没挂账户」，这是看得见、点一下就修得回来的。
      try {
        await AccountService.unlinkLedgerEverywhere(e.id);
      } catch (err) {
        console.warn('[ledger_view] 撤销账户挂账失败：', err && err.message);
      }
      await LedgerService.remove(e.id);
      toast('已删除', 'success');
      render();
    }
  }

  /* ---------------- 预算 ---------------- */

  async function editBudget() {
    const cur = await LedgerService.getBudget(month);
    const v = await promptDialog({
      title: '设置月度预算',
      message: `用于 ${month} 及之后的月份。填 0 表示不设预算。`,
      value: cur ? String(cur) : '',
      placeholder: '例如：1500',
      okText: '保存',
    });
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { toast('请输入不小于 0 的数字', 'warn'); return; }
    await LedgerService.setBudget(month, n);
    toast(n > 0 ? '预算已更新' : '已取消预算', 'success');
    render();
  }

  /* ---------------- 一键导入 ---------------- */

  async function importFromImage() {
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    document.body.appendChild(input);
    input.onchange = async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      toast('正在识别图片…', 'info');
      try {
        const text = await ocrService.recognize(file);
        if (!text || !text.trim()) { toast('没识别到文字，试试更清晰的截图', 'warn'); return; }
        applyParsed(parseReceipt(text), text);
      } catch (err) {
        // 不要把插件的原始报错直接抛给用户（形如 `[TextRecognition.processImage] ...`，
        // 英文且难懂）—— ocr_service 已把原因翻译成中文，这里只用它的 message。
        console.warn('[ledger_view] 图片识别失败：', err && err.message);
        toast(`识别失败：${err.message}`, 'error');
      }
    };
    input.click();
  }

  async function importFromText() {
    const text = await promptDialog({
      title: '粘贴支付信息',
      message: '把支付截图里提取的文字，或一句「午饭 12.5 元」粘进来即可。支持多行。',
      placeholder: '例如：\n微信支付\n付款成功\n¥12.50\n收款方 瑞幸咖啡',
      okText: '解析',
      multiline: true,
      required: true,
      requiredHint: '先把支付信息粘进来',
    });
    if (!text) return;
    applyParsed(parseReceipt(text), text);
  }

  /** 把解析结果填进草稿表单，等用户核对 */
  function applyParsed(parsed, rawText) {
    if (!parsed.amount) {
      toast('没能识别出金额，请手动填写', 'warn');
    }
    draft = {
      id: null,
      amount: parsed.amount ? String(parsed.amount) : '',
      direction: parsed.direction,
      category: parsed.category,
      note: parsed.note || '',
      date: parsed.date,
      source: rawText ? 'image' : 'manual',
      confidence: parsed.confidence,
      // 识别结果不预选账户：从哪张卡走的钱，只有用户自己知道，猜错了就是凭空扣钱。
      // undefined = 还没选，用户必须自己点一下（第 2 条「账户必选」）。
      accountId: undefined,
    };
    openSheet();
  }

  render().then(() => {
    // 抽屉深链：'entry' 直接摊开记一笔表单，'ocr' 直接进图片识别
    if (pendingAction === 'entry') openForm(null);
    else if (pendingAction === 'ocr') importFromImage();
  });
  return root;
}

export default LedgerView;
