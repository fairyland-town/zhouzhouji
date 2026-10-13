/**
 * account_view.js —— 账户余额对账视图（v1.5.0）
 *
 * 用户诉求：
 *   「我充饭卡，我饭卡有多少金额，我消耗了多少金额，还剩下多少金额；
 *     又比如，我充 100 的花费，经历几个月后还剩下多少钱…
 *     目的在于不把『我还剩多少钱』全依靠给第三方平台，
 *     好明确知道自己的钱有没有被误吞或者误扣而导致减少而没记录。」
 *
 * 所以这个视图的核心不是「展示余额」，而是**对账**：
 *   ① 我按流水算出来应该剩多少（推导值）
 *   ② 平台实际上显示剩多少（快照值）
 *   ③ 两者的差额 = 有没有被误扣 / 有笔消费没记
 *
 * 余额展示的「可信度」设计：
 *   没设过任何基准（期初 / 流水 / 快照）的账户，不显示「消耗 / 剩余」这类推导数字，
 *   而是提示「填一下当前余额」——否则会拿 0 当基准算出「已花 ¥0」这种假数据。
 */

import { h, mount, toast, confirmDialog, actionSheet } from '../../utils/dom.js';
import { Icons } from '../../widgets/icons.js';
import AccountService from '../../services/account_service.js';
import AssetService from '../../services/asset_service.js';
import {
  ACCOUNT_TYPE, ACCOUNT_TYPES, ACCOUNT_FLOW, getAccountTypeMeta, groupAccountsByType,
} from '../../models/account.js';
import { LOAN_DIRECTION, LOAN_DIRECTION_META } from '../../models/asset.js';
import { formatDate, parseDateInput } from '../../utils/date_utils.js';
// v1.13.2：money 挪到 utils/money.js —— 「设置 → 黄金持仓」也要用，
// 各留一份迟早会出现「同一个数在两处显示得不一样」。
import { money } from '../../utils/money.js';
import { promptDialog, promptDialogEx } from './checkin_view.js';

/** 天数 → 人话 */
function daysLabel(days) {
  if (days == null) return '';
  if (days <= 0) return '已用完';
  if (days < 1) return '不足 1 天';
  if (days > 365) return '一年以上';
  return `约 ${days} 天`;
}

/* ---------------- v1.13.0 金额隐私开关 ----------------
 *
 * 用户在地铁 / 教室里翻账户页时，净资产是个不该被旁边人一眼看到的东西。
 * 用 localStorage 而不是 IndexedDB：这是个**纯显示偏好**，
 * 需要在 render 同步读到（IndexedDB 是异步的，会先闪一下真实数字再被遮住）。
 */
const HIDE_KEY = 'cw_hide_amounts';

function readHidden() {
  try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
}

function writeHidden(v) {
  try { localStorage.setItem(HIDE_KEY, v ? '1' : '0'); } catch { /* 隐私模式等，忽略 */ }
}

/** 按当前开关决定显示真实金额还是遮罩 */
function mask(text) {
  return readHidden() ? '¥ ••••' : text;
}

export function AccountView(ctx) {
  const root = h('div', { class: 'acct-view' });

  /** 展开的账户 id 集合（默认全部展开，卡片信息量大，收起反而费事） */
  const collapsedIds = new Set();

  async function render() {
    // v1.7.0：进页面前先把到期的每月扣款补上（幂等，靠 lastRun 记月份）。
    // 放在 render 最前面，这样补扣的流水会立刻出现在本次渲染里。
    let autoRuns = [];
    try {
      const res = await AccountService.runDueRecurring();
      autoRuns = res.runs || [];
    } catch (err) {
      console.warn('[account_view] 每月扣款执行失败：', err && err.message);
    }
    // v1.9.0：账户「消费」不再进记账总账，历史上镜像过去的 acct_out 顺手清一次
    // （只跑一次，靠 kv 标记）。这正是用户要的「避免重复计算」。
    try {
      await AccountService.purgeAcctLedgerMirrors();
    } catch (err) {
      console.warn('[account_view] 清理旧记账镜像失败：', err && err.message);
    }
    // v1.13.7：账户之间的**转账**也不进记账总账（用户 2026-09-24
    // 「转账不计入收入，因为钱入账的时候已经计算过了」）。
    // v1.13.5 起镜像过去的那批在这里清一次（同样是只跑一次的 kv 标记）。
    try {
      await AccountService.purgeTransferLedgerMirrors();
    } catch (err) {
      console.warn('[account_view] 清理转账记账镜像失败：', err && err.message);
    }

    const board = await AccountService.board();
    const { active, archived, stats } = board;

    // v1.13.0：资产总览（净资产 / 借入借出 / 报销 / 黄金 / 定期）。
    // 账户余额合计要传进去 —— 净资产 = 账户余额 + 别人欠我的 − 我欠别人的 + 垫付 + 黄金市值
    let assets = null;
    try {
      assets = await AssetService.snapshot(stats.totalBalance);
    } catch (err) {
      console.warn('[account_view] 资产总览读取失败：', err && err.message);
    }

    const nodes = [];

    // 顶部：净资产卡（v1.13.0 由「账户总余额」升级而来）
    nodes.push(netWorthCard(stats, assets));

    // 资产明细两排小格子（照图）：借入/借出 | 报销/未报销，定期 | 即将到期
    // 🔴 v1.13.2：黄金（金价 / 总克重）已从本页移除 —— 入口在「设置 → 黄金持仓」。
    //    黄金市值仍然计入净资产，所以只是不在这里显示，不是不参与计算。
    if (assets) {
      nodes.push(assetDetailCard(assets));
      nodes.push(depositCard(assets));
      nodes.push(overviewCard(AssetService.overview([...active, ...archived])));
    }

    // 本次自动扣款的提示条：让用户知道「钱不是我花的，是定时扣的」
    if (autoRuns.length) {
      const total = autoRuns.reduce((s, r) => s + r.amount, 0);
      nodes.push(h('div', { class: 'acct-auto', dataset: { field: 'auto-runs' } }, [
        h('span', { class: 'acct-auto__icon', html: Icons.clock }),
        h('span', {
          class: 'acct-auto__text',
          text: `已按设置自动扣款 ${autoRuns.length} 笔，合计 ${money(total)}（${autoRuns.map((r) => r.name).join('、')}）`,
        }),
      ]));
    }

    if (!stats.count) {
      nodes.push(h('div', { class: 'acct-intro' }, [
        h('div', { class: 'acct-intro__title', text: '它能帮你做什么？' }),
        h('div', { class: 'acct-intro__body' }, [
          h('div', { text: '· 饭卡充了多少、花了多少、还剩多少，一眼看清' }),
          h('div', { text: '· 平台显示的余额和你自己算的差多少，差额会标出来' }),
          h('div', { text: '· 不依赖第三方 App，自己手里也有一本账' }),
        ]),
        h('div', { class: 'acct-intro__cta' }, [
          h('button', {
            class: 'btn btn--primary',
            dataset: { action: 'new-account-intro' },
            onclick: openCreate,
          }, '新建第一个账户'),
        ]),
      ]));
    }

    // v1.13.0：资产分布（按账户类型分组，带组内合计，可折叠）—— 照图的「储蓄账户 (1)」那种
    if (active.length) nodes.push(distributionCard(active));

    // v1.13.4：「账户明细」可折叠，且**默认收起**。
    // 「资产分布」已经把每个账户的名字 + 余额列了一遍，下面这一摞是同一批账户的
    // 详细版。默认全摊开 = 同一批账户在页面上出现两次，页面被拉得很长。
    // 收起后默认只看汇总，点一下标题即展开。
    if (active.length) {
      nodes.push(h('button', {
        class: `acct-section-title acct-section-title--toggle${accountsCollapsed ? ' acct-section-title--collapsed' : ' acct-section-title--open'}`,
        dataset: { action: 'toggle-account-detail' },
        'aria-expanded': accountsCollapsed ? 'false' : 'true',
        onclick: () => { accountsCollapsed = !accountsCollapsed; render(); },
      }, [
        h('span', { text: `账户明细（${active.length}）` }),
        h('span', { class: 'acct-section-title__chev', html: Icons.chevronDown }),
      ]));
      if (!accountsCollapsed) for (const a of active) nodes.push(accountCard(a));
    }

    // 已归档
    if (archived.length) {
      nodes.push(h('div', { class: 'acct-archived' }, [
        h('div', { class: 'section-title', text: `已归档（${archived.length}）` }),
        ...archived.map((a) => h('button', {
          class: 'acct-archived__item',
          onclick: () => openMenu(a),
        }, [
          h('span', { class: 'acct-archived__icon', text: a.typeMeta.icon }),
          h('span', { class: 'acct-archived__name', text: a.name }),
          h('span', { class: 'acct-archived__bal', text: money(a.balance) }),
        ])),
      ]));
    }

    mount(root, nodes);
  }

  /* ================================================================
     v1.13.0 —— 资产总览板块（照用户给的参考图）
     顺序：净资产卡 → 借入/借出 + 报销/未报销 → 定期 + 即将到期 → 全局口径 → 资产分布
     v1.13.2 起黄金不再占版面（入口在设置页），其余不变。
     每一格都能点进去管理对应明细，不留「只能看不能改」的死数字。
     ================================================================ */

  /** 折叠的账户分组（资产分布里） */
  const collapsedGroups = new Set();

  /**
   * 「账户明细」是否收起。**默认收起**。
   *
   * 上面「资产分布」已经把每个账户的名字和余额列过一遍了，下面这一摞大卡
   * 是同一批账户的详细版（充值 / 消费 / 剩余 / 对账）。默认全摊开的话，
   * 同一批账户在页面上出现两次，页面被拉得很长（用户 2026-09-22 提的）。
   * 收起后默认只看到汇总，要看细节点一下即可。
   */
  let accountsCollapsed = true;

  /**
   * 一行两格的小卡片容器。
   *
   * 🔴 v1.13.1 起每格**只有两行**（标签 + 数值）。
   *    之前每格多一行 `sub` 解释文字（「别人欠我的」「已拿回来的」…），
   *    结果是格子比净资产卡还高 —— 整页看起来「什么都一样大」，
   *    而解释文字本身又没人看（「借出」两个字已经说明了一切）。
   *    真正需要保留的状态信息（逾期笔数）改成与标签同一行的小角标，
   *    不额外占高度。
   */
  function metricGrid(className, cells) {
    return h('div', { class: `acct-grid ${className}` }, cells.map((c) => {
      // v1.13.5：没有 onclick 的格子渲染成 <div> 而不是 <button>。
      // 渲染成 button 会给用户「这个能点」的错觉，点了却什么都不发生 ——
      // 正是「点了没反应」。按钮感留给真的能点的格子。
      const interactive = typeof c.onclick === 'function';
      return h(interactive ? 'button' : 'div', {
        class: `acct-metric${c.warn ? ' acct-metric--warn' : ''}${interactive ? '' : ' acct-metric--static'}`,
        dataset: { action: c.action || '' },
        onclick: c.onclick,
      }, [
        h('span', { class: 'acct-metric__top' }, [
          h('span', { class: 'acct-metric__k', text: c.k }),
          c.flag ? h('span', { class: 'acct-metric__flag', text: c.flag }) : null,
        ]),
        h('span', {
          class: `acct-metric__v${c.tone ? ` acct-metric__v--${c.tone}` : ''}`,
          // data-field 挂在**数值**上，不是挂在整张卡上 ——
          // 回归脚本取它时拿到的应该是「¥300.00」，而不是「借入¥300.001 笔已到期」
          dataset: { field: c.field || '' },
          text: c.v,
        }),
      ]);
    }));
  }

  /**
   * 金额为 0 时不要上色。
   * 「借入 ¥0.00」涂成红色、「借出 ¥0.00」涂成绿色，等于在说
   * 「你有 0 块钱的负债」—— 数字是对的，但颜色在撒谎，一眼扫过去会以为有事。
   * 0 就是中性，交给默认色。
   */
  function toneWhen(n, tone) {
    return Math.abs(Number(n) || 0) >= 0.005 ? tone : '';
  }

  /** 净资产大卡：净资产 + 总资产 / 总负债 + 眼睛（隐藏金额） */
  function netWorthCard(stats, assets) {
    const hidden = readHidden();
    const net = assets ? assets.netWorth : stats.totalBalance;
    const totalA = assets ? assets.totalAssets : Math.max(stats.totalBalance, 0);
    const totalL = assets ? assets.totalLiabilities : Math.max(-stats.totalBalance, 0);

    const valueEl = h('div', {
      class: `acct-total__value${net < 0 ? ' acct-total__value--neg' : ''}`,
      // E2E / 回归脚本靠这个属性取「总余额」，v1.13.0 起它的语义是净资产
      // （账户没有借贷时，净资产恒等于账户余额合计，所以断言 `¥0.00` 依然成立）
      dataset: { field: 'total-balance' },
      text: hidden ? '¥ ••••' : money(net),
    });

    return h('div', { class: 'acct-total acct-total--net' }, [
      h('div', { class: 'acct-net__bar' }, [
        h('span', { class: 'acct-net__label', text: '净资产' }),
        h('div', { class: 'acct-net__tools' }, [
          h('button', {
            class: 'acct-net__eye',
            dataset: { action: 'toggle-amounts' },
            title: hidden ? '显示金额' : '隐藏金额',
            'aria-label': hidden ? '显示金额' : '隐藏金额',
            html: hidden ? Icons.eyeOff : Icons.eye,
            onclick: () => { writeHidden(!readHidden()); render(); },
          }),
          h('button', {
            class: 'acct-total__add',
            dataset: { action: 'new-account' },
            onclick: openCreate,
          }, [h('span', { html: Icons.plus }), h('span', { text: '新账户' })]),
        ]),
      ]),
      h('div', { class: 'acct-total__main' }, [
        valueEl,
      ]),
      h('div', { class: 'acct-net__split' }, [
        h('div', { class: 'acct-net__cell' }, [
          h('span', { class: 'acct-net__k', text: '总资产' }),
          h('span', { class: 'acct-net__v', dataset: { field: 'total-assets' }, text: mask(money(totalA)) }),
        ]),
        h('div', { class: 'acct-net__cell' }, [
          h('span', { class: 'acct-net__k', text: '总负债' }),
          h('span', {
            class: `acct-net__v${totalL > 0 ? ' acct-net__v--neg' : ''}`,
            dataset: { field: 'total-liabilities' },
            text: mask(money(totalL)),
          }),
        ]),
      ]),
    ]);
  }

  /**
   * 借入 / 借出 + 报销 / 未报销。
   * 逾期不写成「1 笔已到期」这种整行说明，改成标签右侧的小角标 ——
   * 它是个**状态**，不是一句解释。
   */
  function assetDetailCard(a) {
    return metricGrid('acct-grid--assets', [
      {
        k: '借入', field: 'borrowed-in', tone: toneWhen(a.borrowedIn, 'neg'), action: 'loan-in',
        v: mask(money(a.borrowedIn)),
        // 逾期数按方向分开算 —— 用总逾期数会让「借出」跟着一起报警（见 models/asset.js）
        flag: a.overdueInCount ? `${a.overdueInCount} 笔逾期` : '',
        warn: a.overdueInCount > 0,
        onclick: () => openLoans(LOAN_DIRECTION.IN),
      },
      {
        k: '报销', field: 'reimbursed', action: 'reimburse',
        v: mask(money(a.reimbursedTotal)),
        onclick: () => openReimbursements(),
      },
      {
        k: '借出', field: 'lent-out', tone: toneWhen(a.lentOut, 'pos'), action: 'loan-out',
        v: mask(money(a.lentOut)),
        flag: a.overdueOutCount ? `${a.overdueOutCount} 笔逾期` : '',
        warn: a.overdueOutCount > 0,
        onclick: () => openLoans(LOAN_DIRECTION.OUT),
      },
      {
        k: '未报销', field: 'pending-reimburse', tone: toneWhen(a.pendingTotal, 'warn'), action: 'reimburse',
        v: mask(money(a.pendingTotal)),
        onclick: () => openReimbursements(),
      },
    ]);
  }

  /**
   * 定期 + 即将到期。
   *
   * v1.13.2：这一排原来是「金价 / 定期 / 总克重 / 即将到期」四格，
   * 用户要求去掉金价板块，黄金整体撤出本页（入口挪到设置页），
   * 于是只剩两格 —— 正好一排，不再有多余的空行。
   */
  function depositCard(a) {
    return metricGrid('acct-grid--deposit', [
      {
        k: '定期', field: 'deposit-total', action: 'deposit',
        v: mask(money(a.depositTotal)),
        onclick: () => openDeposits(),
      },
      {
        k: '即将到期', field: 'due-soon', action: 'deposit',
        v: a.dueSoonCount ? `${a.dueSoonCount} 笔` : '无',
        flag: a.dueSoonCount ? mask(money(a.dueSoonAmount)) : '',
        warn: a.dueSoonCount > 0,
        onclick: () => openDeposits(),
      },
    ]);
  }

  /**
   * 账户概览：累计充值 / 累计消耗 / 每月固定扣款 / 对账有差额。
   *
   * v1.13.5：改回 2×2 格子（用户 2026-09-23：「这四个模块重新排列一下，
   * 不要拉的太长了」，并给了「借入/报销/借出/未报销」那排格子作为参照）。
   *
   * 之前是「标签在左、数值在右」的四行列表 —— 行数看着少，但四行叠起来
   * 比 2×2 格子高出一大截，把整页拖长了。
   *
   * ⚠️ 为了不退回「整页什么都一样大」，数值比上面的资产明细**小一号**
   *    （15px → 13.5px，见 CSS 的 `.acct-grid--overview`），
   *    保持一级视觉落差。这四格是次要信息，不该和借入借出抢注意力。
   */
  function overviewCard(ov) {
    return h('div', { class: 'acct-overview' }, [
      h('div', { class: 'acct-overview__head' }, [h('span', { text: '账户概览' })]),
      metricGrid('acct-grid--overview', [
        {
          k: '累计充值', field: 'total-in', tone: 'pos',
          v: mask(money(ov.totalIn)),
        },
        {
          k: '累计消耗', field: 'total-out', tone: 'warn',
          v: mask(money(ov.totalOut)),
        },
        {
          k: '每月固定扣款', field: 'recurring',
          v: ov.recurringCount ? mask(money(ov.recurringTotal)) : '无',
          flag: ov.recurringCount ? `${ov.recurringCount} 个账户` : '',
        },
        {
          k: '对账有差额', field: 'diff-accounts',
          v: ov.diffCount ? `${ov.diffCount} 个` : '全部对得上',
          flag: ov.diffCount ? `合计差 ${mask(money(ov.diffTotal))}` : '',
          warn: ov.diffCount > 0,
        },
      ]),
    ]);
  }

  /** 资产分布：按账户类型分组，带组内合计，可折叠 */
  function distributionCard(active) {
    const groups = groupAccountsByType(active);
    const body = [];

    for (const g of groups) {
      const collapsed = collapsedGroups.has(g.type);
      body.push(h('button', {
        class: `acct-dist__group${collapsed ? ' acct-dist__group--collapsed' : ''}`,
        dataset: { group: g.type },
        onclick: () => {
          if (collapsed) collapsedGroups.delete(g.type); else collapsedGroups.add(g.type);
          render();
        },
      }, [
        h('span', { class: 'acct-dist__dot', style: { background: g.color } }),
        h('span', { class: 'acct-dist__gname' }, [
          h('span', { text: g.label }),
          h('span', { class: 'acct-dist__gcount', text: `(${g.count})` }),
        ]),
        h('span', { class: 'acct-dist__gtotal', text: mask(money(g.total)) }),
        h('span', { class: 'acct-dist__chev', html: Icons.chevronDown }),
      ]));

      if (collapsed) continue;
      for (const a of g.accounts) {
        body.push(h('button', {
          class: 'acct-dist__row',
          dataset: { accountId: String(a.id) },
          onclick: () => openMenu(a),
        }, [
          h('span', {
            class: 'acct-dist__icon',
            style: { background: `${a.typeMeta.color}16`, color: a.typeMeta.color },
            text: a.typeMeta.icon,
          }),
          h('span', { class: 'acct-dist__name' }, [
            h('span', { text: a.name }),
            a.hasRecurring ? h('span', { class: 'acct-dist__tag', text: '月扣' }) : null,
          ]),
          h('span', {
            class: `acct-dist__bal${a.balance < 0 ? ' acct-dist__bal--neg' : ''}`,
            text: mask(money(a.balance)),
          }),
        ]));
      }
    }

    return h('div', { class: 'acct-dist' }, [
      h('div', { class: 'acct-overview__head' }, [h('span', { text: '资产分布' })]),
      ...body,
    ]);
  }

  /* ---------------- 资产明细的增删改（全部走弹窗，和账户侧风格一致） ---------------- */

  /** 借入 / 借出 */
  async function openLoans(direction) {
    const meta = LOAN_DIRECTION_META[direction];
    const all = (await AssetService.loans()).filter((x) => x.direction === direction);
    const openList = all.filter((x) => !x.settled);
    const total = openList.reduce((s, x) => s + x.amount, 0);

    const act = await actionSheet({
      title: `${meta.label} · 未结清 ${money(total)}`,
      message: `${meta.desc}。点某一条可以结清或删除。`,
      actions: [
        { label: `＋ 记一笔${meta.label}`, value: '__add' },
        ...all
          .slice()
          .sort((a, b) => Number(a.settled) - Number(b.settled) || b.date.localeCompare(a.date))
          .map((x) => ({
            label: `${x.settled ? '✓ 已结清 · ' : ''}${x.counterparty || '（没写对方）'}  ${money(x.amount)}`
              + `${x.dueDate ? `  ${x.dueDate.slice(5)} 到期` : ''}`,
            value: x.id,
          })),
      ],
    });
    if (!act) return;

    if (act === '__add') {
      const who = await promptDialog({
        title: `记一笔${meta.label}`,
        message: `${meta.desc}。写清楚对方是谁，日后好开口要 / 好还。`,
        placeholder: direction === LOAN_DIRECTION.IN ? '例如：室友小王' : '例如：同学小李',
        okText: '下一步',
        required: true,
        requiredHint: '请填写对方是谁',
      });
      if (!who) return;
      const amount = await promptDialog({
        title: '金额',
        placeholder: '例如：200',
        okText: '下一步',
        required: true,
        requiredHint: '请填写金额',
      });
      if (!amount) return;
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) { toast('请输入大于 0 的金额', 'warn'); return; }

      // 「可跳过」= 留空直接点保存（返回 ''），**不是**取消（返回 null）。
      // 这两者以前都返回 null，导致用户一留空就把整笔账丢了。
      const dueRaw = await promptDialog({
        title: '约定哪天还（可跳过）',
        message: '2026-10-01、2026.10.1、2026/10/1 都认。留空就是没约定日期；\n填了之后，到期还没结清会在卡片上标红提醒你。',
        placeholder: '例如：2026-10-01（留空即跳过）',
        okText: '保存',
      });
      if (dueRaw === null) return;
      const due = dueRaw ? parseDateInput(dueRaw) : null;
      if (dueRaw && !due) { toast('日期看不懂，试试 2026-10-01 或 2026.10.1', 'warn'); return; }

      try {
        await AssetService.addLoan({ direction, counterparty: who, amount: n, dueDate: due || null });
        toast(`已记下${meta.label} ${money(n)}`, 'success');
        render();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    // 选中某一条 → 结清 / 删除
    const target = all.find((x) => x.id === act);
    if (!target) return;
    const op = await actionSheet({
      title: `${target.counterparty || meta.label} ${money(target.amount)}`,
      actions: [
        { label: target.settled ? '撤销「已结清」' : '标记为已结清', value: 'settle' },
        { label: '删除这条记录', value: 'del', danger: true },
      ],
    });
    if (op === 'settle') {
      await AssetService.settleLoan(target.id, !target.settled);
      toast(target.settled ? '已撤销结清' : '已标记结清', 'success');
      render();
    } else if (op === 'del') {
      const okDel = await confirmDialog({
        title: '删除这条记录',
        message: `${target.counterparty || meta.label} ${money(target.amount)}。删除后不再计入资产总览。`,
        okText: '删除', danger: true,
      });
      if (!okDel) return;
      await AssetService.removeLoan(target.id);
      toast('已删除', 'success');
      render();
    }
  }

  /** 报销 / 未报销 */
  async function openReimbursements() {
    const all = await AssetService.reimbursements();
    const pending = all.filter((x) => !x.reimbursed);
    const pendingTotal = pending.reduce((s, x) => s + x.amount, 0);

    const act = await actionSheet({
      title: `报销 · 未报 ${money(pendingTotal)}`,
      message: '垫出去还没拿回来的钱，先记在这里，报下来了再打勾。',
      actions: [
        { label: '＋ 记一笔垫付', value: '__add' },
        ...all
          .slice()
          .sort((a, b) => Number(a.reimbursed) - Number(b.reimbursed) || b.date.localeCompare(a.date))
          .map((x) => ({
            label: `${x.reimbursed ? '✓ 已报 · ' : ''}${x.item || '（没写事由）'}  ${money(x.amount)}`,
            value: x.id,
          })),
      ],
    });
    if (!act) return;

    if (act === '__add') {
      const item = await promptDialog({
        title: '垫付了什么',
        message: '比如「实验室打印费」「团建垫付」。',
        placeholder: '例如：实验室打印费',
        okText: '下一步',
        required: true,
        requiredHint: '请填写垫付事由',
      });
      if (!item) return;
      const amount = await promptDialog({
        title: '金额',
        placeholder: '例如：58.5',
        okText: '保存',
        required: true,
        requiredHint: '请填写垫付金额',
      });
      if (!amount) return;
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) { toast('请输入大于 0 的金额', 'warn'); return; }
      try {
        await AssetService.addReimbursement({ item, amount: n });
        toast(`已记下垫付 ${money(n)}`, 'success');
        render();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    const target = all.find((x) => x.id === act);
    if (!target) return;
    const op = await actionSheet({
      title: `${target.item || '垫付'} ${money(target.amount)}`,
      actions: [
        { label: target.reimbursed ? '撤销「已报销」' : '标记为已报销', value: 'mark' },
        { label: '删除这条记录', value: 'del', danger: true },
      ],
    });
    if (op === 'mark') {
      await AssetService.markReimbursed(target.id, !target.reimbursed);
      toast(target.reimbursed ? '已撤销' : '已标记报销', 'success');
      render();
    } else if (op === 'del') {
      const okDel = await confirmDialog({
        title: '删除这条记录',
        message: `${target.item || '垫付'} ${money(target.amount)}。`,
        okText: '删除', danger: true,
      });
      if (!okDel) return;
      await AssetService.removeReimbursement(target.id);
      toast('已删除', 'success');
      render();
    }
  }

  /* 黄金面板（原 openGold）已于 v1.13.2 搬到 gold_sheet.js ——
     账户页不再有黄金入口，改由「设置 → 黄金持仓」进入。
     注意：黄金市值**仍然计入净资产**，只是不在这里显示。 */

  /** 定期存款 */
  async function openDeposits() {
    const list = await AssetService.deposits();
    const total = list.reduce((s, x) => s + x.amount, 0);

    const act = await actionSheet({
      title: `定期 · ${money(total)}`,
      message: '定期只是登记，**不计入净资产** —— 那笔钱通常已经在某个账户余额里了，再算一遍就重复了。',
      actions: [
        { label: '＋ 登记一笔定期', value: '__add' },
        ...list.map((x) => ({
          label: `${x.name || '定期'}  ${money(x.amount)}`
            + `${x.maturityDate ? `  ${x.maturityDate.slice(5)} 到期` : ''}`
            + `${x.rate > 0 ? `  ${x.rate}%` : ''}`,
          value: x.id,
        })),
      ],
    });
    if (!act) return;

    if (act === '__add') {
      const name = await promptDialog({
        title: '定期名称',
        message: '比如「一年期定存」「大额存单」。',
        placeholder: '例如：一年期定存',
        okText: '下一步',
      });
      if (name === null) return;
      const amount = await promptDialog({
        title: '本金',
        placeholder: '例如：10000',
        okText: '下一步',
        required: true,
        requiredHint: '请填写本金',
      });
      if (!amount) return;
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) { toast('请输入大于 0 的本金', 'warn'); return; }

      // 可跳过：留空 = 利率按 0 算（返回 '' → Number('') 是 0，正是我们想要的）
      const rate = await promptDialog({
        title: '年利率 %（可跳过）',
        message: '填 1.75 表示年利率 1.75%。留空就是 0。',
        placeholder: '例如：1.75（留空即跳过）',
        okText: '下一步',
      });
      if (rate === null) return;

      const matRaw = await promptDialog({
        title: '到期日（可跳过）',
        message: '2027-03-01、2027.3.1、2027/3/1 都认。留空就是不设到期日；\n填了之后，到期前 30 天会在卡片上提醒你。',
        placeholder: '例如：2027-03-01（留空即跳过）',
        okText: '保存',
      });
      if (matRaw === null) return;
      const mat = matRaw ? parseDateInput(matRaw) : null;
      if (matRaw && !mat) { toast('日期看不懂，试试 2027-03-01 或 2027.3.1', 'warn'); return; }

      try {
        await AssetService.addDeposit({
          name: name || '定期', amount: n, rate: Number(rate) || 0, maturityDate: mat || null,
        });
        toast(`已登记 ${money(n)}`, 'success');
        render();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    const target = list.find((x) => x.id === act);
    if (!target) return;
    const okDel = await confirmDialog({
      title: '删除这笔定期',
      message: `${target.name || '定期'} ${money(target.amount)}。`,
      okText: '删除', danger: true,
    });
    if (!okDel) return;
    await AssetService.removeDeposit(target.id);
    toast('已删除', 'success');
    render();
  }

  /* ---------------- 单个账户卡 ---------------- */

  function accountCard(a) {
    const meta = a.typeMeta;
    const collapsed = collapsedIds.has(a.id);
    const card = h('div', {
      class: `acct-card${collapsed ? ' acct-card--collapsed' : ''}`,
      dataset: { accountId: String(a.id) },
      style: { '--acct-color': meta.color },
    });

    /* 头部：名称 + 余额 + 折叠 */
    card.appendChild(h('div', { class: 'acct-card__head' }, [
      h('button', {
        class: 'acct-card__titlewrap',
        onclick: () => {
          if (collapsed) collapsedIds.delete(a.id); else collapsedIds.add(a.id);
          render();
        },
      }, [
        h('span', { class: 'acct-card__icon', style: { background: `${meta.color}16`, color: meta.color }, text: meta.icon }),
        h('span', { class: 'acct-card__title' }, [
          h('span', { class: 'acct-card__name' }, [
            h('span', { text: a.name }),
            // 每月扣款徽标：一眼看出这个账户有自动扣款，不用点进菜单确认
            a.hasRecurring
              ? h('span', { class: 'acct-card__badge', title: a.recurringLabel }, '每月扣款')
              : null,
          ]),
          h('span', { class: 'acct-card__type', text: meta.label }),
        ]),
      ]),
      h('button', {
        class: 'acct-card__more',
        title: '更多操作',
        dataset: { action: 'account-menu' },
        onclick: () => openMenu(a),
      }, h('span', { html: Icons.moreVertical })),
    ]));



    /* 余额区 */
    const balanceBlock = a.hasBaseline
      ? h('div', { class: 'acct-bal' }, [
        h('div', { class: 'acct-bal__row' }, [
          h('div', { class: 'acct-bal__cell' }, [
            h('div', { class: 'acct-bal__k', text: '当前余额' }),
            h('div', { class: 'acct-bal__v acct-bal__v--main', dataset: { field: 'balance' }, text: money(a.balance) }),
          ]),
          h('div', { class: 'acct-bal__cell' }, [
            h('div', { class: 'acct-bal__k', text: '累计充值' }),
            h('div', { class: 'acct-bal__v acct-bal__v--in', text: money(a.totalIn) }),
          ]),
          h('div', { class: 'acct-bal__cell' }, [
            h('div', { class: 'acct-bal__k', text: '累计消耗' }),
            h('div', { class: 'acct-bal__v acct-bal__v--out', dataset: { field: 'total-out' }, text: money(a.totalOut) }),
          ]),
        ]),
        // 期初 + 日均消耗预估
        h('div', { class: 'acct-bal__foot' }, [
          h('span', { class: 'acct-bal__hint', text: `期初 ${money(a.opening)}（${a.openingDate.slice(5)} 起）` }),
          a.daysLeft() != null
            ? h('span', {
              class: `acct-bal__pace${a.daysLeft() <= 7 ? ' acct-bal__pace--warn' : ''}`,
              // 写成「日均 ¥100.00 · 还能用 约 139 天」而不是
              // 「按日均 ¥100.00 算，还能用 约 139 天」—— 去掉「按…算」这种叙述腔
              text: `日均 ${money(a.dailyBurn())} · 还能用 ${daysLabel(a.daysLeft())}`,
            })
            : null,
        ]),
      ])
      : h('button', {
        class: 'acct-bal acct-bal--empty',
        dataset: { action: 'set-baseline' },
        onclick: () => openBaseline(a),
      }, [
        h('span', { class: 'acct-bal__empty-icon', html: Icons.warn }),
        h('span', { class: 'acct-bal__empty-text', text: '还没设过期初余额，先填一下当前余额才能算消耗' }),
        h('span', { class: 'acct-bal__empty-cta', text: '去设置 →' }),
      ]);
    card.appendChild(balanceBlock);

    /* 对账提示条 */
    const diff = a.balanceDiff;
    if (a.lastCheckpoint) {
      const cp = a.lastCheckpoint;
      const isOk = Math.abs(diff) < 0.005;
      card.appendChild(h('div', {
        class: `acct-diff${isOk ? ' acct-diff--ok' : ' acct-diff--warn'}`,
        dataset: { field: 'diff' },
      }, [
        h('span', { class: 'acct-diff__icon', html: isOk ? Icons.check : Icons.warn }),
        h('span', { class: 'acct-diff__text' }, [
          h('span', {
            text: isOk
              ? `对得上：${cp.date.slice(5)} 平台显示 ${money(cp.balance)}，与你记的一致`
              : `差额 ${money(Math.abs(diff))}：${cp.date.slice(5)} 平台显示 ${money(cp.balance)}，`
                + `你记的流水算下来应是 ${money(a.balance + diff)}`,
          }),
          isOk ? null : h('span', {
            class: 'acct-diff__hint',
            text: diff > 0
              ? '（平台扣得比你记的多 —— 可能有没记的消费）'
              : '（你记的比平台扣的多 —— 可能有重复记录）',
          }),
        ]),
      ]));
    }

    if (collapsed) return card;

    /* 每月扣款说明条（仅启用时显示） */
    if (a.hasRecurring) {
      card.appendChild(h('button', {
        class: 'acct-recur',
        dataset: { action: 'recurring' },
        onclick: () => openRecurring(a),
      }, [
        h('span', { class: 'acct-recur__icon', html: Icons.clock }),
        h('span', { class: 'acct-recur__text' }, [
          h('span', { class: 'acct-recur__main', text: a.recurringLabel }),
          h('span', {
            class: 'acct-recur__sub',
            text: a.recurring.lastRun ? `上次执行 ${a.recurring.lastRun}` : '还没执行过',
          }),
        ]),
        h('span', { class: 'acct-recur__edit', text: '设置 ›' }),
      ]));
    }

    /* 快捷操作 */
    card.appendChild(h('div', { class: 'acct-ops' }, [
      h('button', {
        class: 'acct-op acct-op--in',
        dataset: { action: 'recharge' },
        onclick: () => openEntry(a, ACCOUNT_FLOW.IN),
      }, [h('span', { text: '＋' }), h('span', { text: '充值' })]),
      h('button', {
        class: 'acct-op acct-op--out',
        dataset: { action: 'spend' },
        onclick: () => openEntry(a, ACCOUNT_FLOW.OUT),
      }, [h('span', { text: '－' }), h('span', { text: '消费' })]),
      h('button', {
        class: 'acct-op acct-op--check',
        dataset: { action: 'checkpoint' },
        onclick: () => openCheckpoint(a),
      }, [h('span', { html: Icons.check }), h('span', { text: '对账' })]),
      h('button', {
        class: `acct-op acct-op--recur${a.hasRecurring ? ' acct-op--recur-on' : ''}`,
        dataset: { action: 'recurring-setup' },
        onclick: () => openRecurring(a),
      }, [h('span', { html: Icons.clock }), h('span', { text: a.hasRecurring ? '月扣款' : '定时' })]),
    ]));

    /* 账户自己的流水（最近 8 条） */
    const recent = [...a.entries].reverse().slice(0, 8);
    if (recent.length) {
      card.appendChild(h('div', { class: 'acct-flows' }, [
        h('div', { class: 'acct-flows__head' }, [
          h('span', { text: `账户流水（共 ${a.entries.length} 笔）` }),
          h('button', {
            class: 'acct-flows__more',
            dataset: { action: 'all-flows' },
            onclick: () => openFlows(a),
          }, '全部 ›'),
        ]),
        ...recent.map((e) => h('div', {
          class: 'acct-flow',
          dataset: { flowId: e.id },
        }, [
          h('span', { class: 'acct-flow__date', text: e.date.slice(5) }),
          h('span', { class: 'acct-flow__note', text: e.note || (e.kind === ACCOUNT_FLOW.IN ? '充值' : '消费') }),
          h('span', {
            class: `acct-flow__amt acct-flow__amt--${e.kind}`,
            text: `${e.kind === ACCOUNT_FLOW.IN ? '+' : '-'}${e.amount.toFixed(2)}`,
          }),
        ])),
      ]));
    }

    return card;
  }

  /* ---------------- 新建账户 ---------------- */

  async function openCreate() {
    const name = await promptDialog({
      title: '新建账户',
      message: '比如「一食堂饭卡」「建行卡」「微信零钱」。可以先只填名字，余额之后再补。',
      placeholder: '例如：一食堂饭卡',
      okText: '下一步',
      required: true,
      requiredHint: '请先给账户起个名字',
    });
    if (!name) return;

    const type = await pickType();
    if (!type) return;

    const opening = await promptDialog({
      title: '期初余额',
      message: '「开始记这笔账」的时候，这个账户里有多少钱？可以填 0 或留空，之后再对账校准。',
      value: '0',
      placeholder: '例如：100',
      okText: '创建',
    });
    if (opening === null) return;
    const n = Number(opening);
    if (!Number.isFinite(n) || n < 0) { toast('请输入不小于 0 的数字', 'warn'); return; }

    try {
      await AccountService.create({ name, type, opening: n, openingDate: formatDate(new Date()) });
      toast(`已创建「${name}」`, 'success');
      // 刚建好的账户要让人看见 —— 否则「账户明细」默认收起，
      // 用户会觉得「点了创建怎么什么都没出现」（其实只在资产分布里多了一行）。
      accountsCollapsed = false;
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /** 选类型（actionSheet 单选） */
  async function pickType() {
    const act = await actionSheet({
      title: '账户类型',
      actions: ACCOUNT_TYPES.map((t) => {
        const m = getAccountTypeMeta(t);
        return { label: `${m.icon} ${m.label}`, value: t };
      }),
    });
    return act || null;
  }

  /* ---------------- 充值 / 消费 ---------------- */

  async function openEntry(a, kind) {
    const isIn = kind === ACCOUNT_FLOW.IN;
    const meta = a.typeMeta;
    const amount = await promptDialog({
      title: isIn ? `给「${a.name}」充值` : `「${a.name}」消费`,
      message: isIn
        ? '这次充进去多少钱？会加到余额上。'
        : '这次花了多少钱？会从余额里扣掉。刷一次卡就记一次，不用每笔都记。',
      placeholder: '例如：100',
      okText: '下一步',
      required: true,
      requiredHint: '请填写金额',
    });
    if (!amount) return;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) { toast('请输入大于 0 的金额', 'warn'); return; }

    // v1.7.2：充值必须写明来源（不再可跳过）—— 来源是「这笔钱从哪儿来」的凭证，
    // 跳过后记账页只剩一个孤零零的金额，日后对账时分不清是工资、报销还是退款。
    // 消费的备注仍可跳过（刷一次卡就记一次的场景太多，强制填反而添麻烦）。
    //
    // v1.13.5：充值这一步多一个**必选的「关联账户」**（用户 2026-09-23 第 3 条，
    // 第 2 轮改成必选）。
    // 选了别的账户就是**转账**：从那个账户真扣钱转进本账户，两个账户各落一条流水。
    // 选「不关联（钱来自账户之外）」= 普通充值（钱来自工资 / 报销这类体系外的来源）。
    // 两者都行，但**必须主动选一个** —— 不给默认值，用户自己判断钱是哪儿来的。
    // 只能选别的账户 —— 转给自己没意义，还会把余额算成两倍。
    // 归档账户不列（它们已经「不参与」了，不该再往外转钱）。
    const all = await AccountService.list();
    const others = all.filter((x) => x.id !== a.id && !x.archived);
    const res = await promptDialogEx({
      title: isIn ? '这笔钱的来源' : '备注（可跳过）',
      message: isIn
        ? (others.length
          ? '填清楚钱是从哪儿来的，比如「工资」「奖学金」「报销」「退款」。会显示在记账页上。\n如果这笔钱是从你另一个账户转过来的，在下面选那个账户。'
          : '填清楚钱是从哪儿来的，比如「工资」「奖学金」「报销」「退款」。会显示在记账页上。')
        : '这笔钱花在哪？比如「午饭」「打印资料」。',
      placeholder: isIn ? '例如：工资' : '例如：午饭',
      okText: '保存',
      required: isIn,
      requiredHint: '请填写这笔钱的来源，例如「工资」「奖学金」',
      // 只有「充值」才可能转账；消费不做这个（消费的关联入口在记账页那边）
      extra: (isIn && others.length) ? {
        label: '关联账户',
        placeholder: '请选择',
        options: [
          { label: '不关联（钱来自账户之外）', value: '__none' },
          ...others.map((x) => ({
            label: `${x.name}（余额 ¥${x.balance.toFixed(2)}）`,
            value: String(x.id),
          })),
        ],
        // ⚠️ 刻意**不传** `value` —— 不传 = 未选（待办态），传了 = 已选。
        //    这就是「必选」得以成立的关键（见 promptDialogEx 的三态说明）。
      } : null,
      extraRequired: isIn && others.length > 0,
      extraRequiredHint: '请选一下这笔钱从哪儿来：是别的账户转过来的，还是账户之外的',
    });
    if (res === null) return;
    const note = res.text;
    const fromId = (res.extra && res.extra !== '__none') ? Number(res.extra) : null;

    try {
      if (fromId != null) {
        // 转账：本账户 +n（充值），对方账户 -n（转出），两条互相认领
        await AccountService.transfer({
          fromId,
          toId: a.id,
          amount: n,
          date: formatDate(new Date()),
          note: note || '',
        });
        const src = await AccountService.get(fromId);
        toast(`已从「${src ? src.name : '关联账户'}」转入 ${money(n)}`, 'success');
      } else {
        await AccountService.addEntry(a.id, { kind, amount: n, date: formatDate(new Date()), note: note || '' });
        toast(isIn ? `已充值 ${money(n)}` : `已记消费 ${money(n)}`, 'success');
      }
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 设置基准余额 ---------------- */

  async function openBaseline(a) {
    const v = await promptDialog({
      title: '设置当前余额',
      message: `现在「${a.name}」里实际有多少钱？填进去后，之后记的消费会从这里往下扣。`,
      placeholder: '例如：92.30',
      okText: '保存',
      // 留空会被 Number('') 悄悄算成 0 —— 把余额清零可不是用户的本意，必须拦住
      required: true,
      requiredHint: '请填写余额，没有钱就填 0',
    });
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { toast('请输入不小于 0 的数字', 'warn'); return; }
    try {
      // 用「对账快照」的方式记录：把今天抄到的余额作为基准
      await AccountService.checkpoint(a.id, { balance: n, date: formatDate(new Date()), note: '初始化' });
      toast(`余额已设为 ${money(n)}`, 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 对账 ---------------- */

  async function openCheckpoint(a) {
    const v = await promptDialog({
      title: '对账',
      message: `去平台 / 卡机上查一下「${a.name}」现在显示多少钱，抄进来。\n系统会和你记的流水比一比，差额说明有没有漏记或被误扣。`,
      value: String(a.balance),
      placeholder: '例如：92.30',
      okText: '开始对账',
      // 同上：留空会被算成 0，反而报出一个「凭空少了多少钱」的假差额
      required: true,
      requiredHint: '请填写平台上显示的实际金额',
    });
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n)) { toast('请输入数字', 'warn'); return; }

    // 提前算出差额，好在确认框里明确告诉用户结论
    const expected = a.balance;
    const diff = Math.round((expected - n) * 100) / 100;

    const ok = await confirmDialog({
      title: '对账结果',
      message: Math.abs(diff) < 0.005
        ? `完全一致：平台显示 ${money(n)}，你记的也是 ${money(expected)}。\n这本账是准的。`
        : `平台显示 ${money(n)}，你记的流水算下来是 ${money(expected)}。\n`
          + `差额 ${money(Math.abs(diff))}。\n\n`
          + (diff > 0
            ? '平台扣得比你记的多 —— 可能有几笔消费没记账，或者被误扣了。'
            : '你记的比平台扣的多 —— 可能有重复记录，或者有笔充值没记。')
          + '\n\n是否把这笔差额补记为本账户的一笔消费 / 充值，让两边对上？',
      okText: Math.abs(diff) < 0.005 ? '好的' : '补记差额',
      cancelText: Math.abs(diff) < 0.005 ? '关闭' : '只留对账记录',
    });

    try {
      if (ok && Math.abs(diff) >= 0.005) {
        // 补一笔差额流水，把账面调平（这也正是记账的意义）
        await AccountService.addEntry(a.id, {
          kind: diff > 0 ? ACCOUNT_FLOW.OUT : ACCOUNT_FLOW.IN,
          amount: Math.abs(diff),
          date: formatDate(new Date()),
          note: '对账差额补记',
        });
        toast(`已补记差额 ${money(Math.abs(diff))}`, 'success');
      }
      // 无论是否补记，都把快照留下来（以后能看到历史对账记录）
      await AccountService.checkpoint(a.id, {
        balance: n,
        date: formatDate(new Date()),
        note: Math.abs(diff) < 0.005 ? '一致' : `差额 ${money(Math.abs(diff))}`,
      });
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 每月定时扣款（v1.7.0） ---------------- */

  /**
   * 每月扣款设置。
   * 流程：开关 → 金额 → 日期 → 备注，一步步问，避免一次性甩一张表单给用户。
   * 已启用时点进来先问「改设置还是关掉」。
   */
  async function openRecurring(a) {
    if (a.hasRecurring) {
      const act = await actionSheet({
        title: a.recurringLabel,
        actions: [
          { label: '修改设置', value: 'edit' },
          { label: '关闭每月扣款', value: 'off', danger: true },
        ],
      });
      if (act === 'off') {
        try {
          await AccountService.clearRecurring(a.id);
          toast('已关闭每月扣款', 'success');
          render();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (act !== 'edit') return;
    } else {
      const on = await confirmDialog({
        title: '每月按时扣款',
        message: `给「${a.name}」设置一笔固定扣款，比如房租、话费、会员费。\n`
          + '到日子系统会自动从余额里扣掉并留一笔流水，不用你每月手动记一次。\n\n'
          + '注意：设置当天不会立刻扣。若本月扣款日还没到，到这个月那天扣；'
          + '若本月扣款日已经过了，就等下个月那天再扣。',
        okText: '去设置',
        cancelText: '算了',
      });
      if (!on) return;
    }

    const amount = await promptDialog({
      title: '每月扣多少钱',
      message: '固定扣掉的金额。比如房租 1500，就填 1500。',
      value: a.hasRecurring ? String(a.recurring.amount) : '',
      placeholder: '例如：1500',
      okText: '下一步',
      required: true,
      requiredHint: '请填写每月扣款金额',
    });
    if (amount === null) return;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) { toast('请输入大于 0 的金额', 'warn'); return; }

    const dayRaw = await promptDialog({
      title: '每月几号扣',
      message: '填 1 到 28 之间的日期（避开 29–31，因为有的月份没有这几天）。\n'
        + '本月这天还没到 → 本月就扣；已经过了 → 本月不扣，下个月这天再扣。',
      value: String(a.hasRecurring ? a.recurring.day : 1),
      placeholder: '例如：1',
      okText: '下一步',
      required: true,
      requiredHint: '请填写 1–28 之间的日期',
    });
    if (dayRaw === null) return;
    const day = Number(dayRaw);
    if (!Number.isInteger(day) || day < 1 || day > 28) { toast('请输入 1–28 之间的整数', 'warn'); return; }

    const note = await promptDialog({
      title: '备注（可跳过）',
      message: '这笔钱是干什么的？会显示在记账页上，方便日后回看。',
      value: a.hasRecurring ? a.recurring.note : '',
      placeholder: '例如：房租',
      okText: '保存',
    });
    if (note === null) return;

    try {
      await AccountService.setRecurring(a.id, {
        enabled: true, amount: n, day, note: note || '', kind: ACCOUNT_FLOW.OUT,
      });
      // 提示文案要能自证「没有立刻扣」：告诉用户下一次什么时候扣。
      const todayNum = new Date().getDate();
      const firstRun = day < todayNum ? '下个月' : '本月';
      toast(`已设置：${firstRun} ${day} 号扣 ${money(n)}`, 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 全部流水 ---------------- */

  async function openFlows(a) {
    const all = [...a.entries].reverse();
    if (!all.length) { toast('这个账户还没有流水', 'info'); return; }
    const act = await actionSheet({
      title: `${a.name} · 共 ${all.length} 笔`,
      // v1.13.8：原来只取前 30 条，标题却写「共 N 笔」—— 超过 30 笔时
      // 后几笔**永远看不到也删不掉**（用户 2026-10-13 反馈「显示不完全」）。
      // 面板本身现在可滚动（见 utils/dom.js 的 .sheet__list），所以直接全给。
      actions: all.map((e) => ({
        label: `${e.date.slice(5)} ${e.kind === ACCOUNT_FLOW.IN ? '+' : '-'}${e.amount.toFixed(2)}`
          + `${e.note ? `  ${e.note}` : ''}`,
        value: e.id,
      })),
    });
    if (!act) return;
    // 选中某笔 → 询问是否删除
    const target = a.entries.find((e) => e.id === act);
    if (!target) return;
    const ok = await confirmDialog({
      title: '删除这笔流水',
      message: `${target.date} ${target.kind === ACCOUNT_FLOW.IN ? '充值' : '消费'} ${money(target.amount)}`
        + `${target.note ? `（${target.note}）` : ''}\n删除后余额会相应回退。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    await AccountService.removeEntry(a.id, target.id);
    toast('已删除', 'success');
    render();
  }

  /* ---------------- 账户菜单 ---------------- */

  async function openMenu(a) {
    const act = await actionSheet({
      title: a.name,
      actions: [
        { label: '重命名', value: 'rename' },
        { label: '修改期初余额', value: 'opening' },
        { label: a.hasRecurring ? '每月扣款设置' : '设置每月扣款', value: 'recurring' },
        { label: '查看对账历史', value: 'history' },
        { label: a.archived ? '取消归档' : '归档（暂不显示）', value: 'archive' },
        { label: '删除账户', value: 'delete', danger: true },
      ],
    });
    if (!act) return;

    if (act === 'rename') {
      const name = await promptDialog({
        title: '重命名账户',
        value: a.name,
        okText: '保存',
        required: true,
        requiredHint: '账户名不能为空',
      });
      if (!name) return;
      try { await AccountService.rename(a.id, name); toast('已重命名', 'success'); render(); }
      catch (err) { toast(err.message, 'error'); }
    } else if (act === 'recurring') {
      await openRecurring(a);
    } else if (act === 'opening') {
      const v = await promptDialog({
        title: '修改期初余额',
        message: '「开始记账」那一刻这个账户里有多少钱。改完余额会重新计算。',
        value: String(a.opening),
        placeholder: '例如：100',
        okText: '保存',
        required: true,
        requiredHint: '请填写期初余额，没有就填 0',
      });
      if (v === null) return;
      const n = Number(v);
      if (!Number.isFinite(n)) { toast('请输入数字', 'warn'); return; }
      const acc = await AccountService.get(a.id);
      acc.opening = n;
      await AccountService.update(acc);
      toast('期初余额已更新', 'success');
      render();
    } else if (act === 'history') {
      if (!a.checkpoints.length) { toast('还没有对账记录', 'info'); return; }
      await actionSheet({
        title: `${a.name} · 对账历史`,
        actions: [...a.checkpoints].reverse().slice(0, 20).map((c) => ({
          label: `${c.date}  平台显示 ${money(c.balance)}${c.note ? `  ${c.note}` : ''}`,
          value: c.date,
        })),
      });
    } else if (act === 'archive') {
      await AccountService.setArchived(a.id, !a.archived);
      toast(a.archived ? '已取消归档' : '已归档', 'success');
      render();
    } else if (act === 'delete') {
      const ok = await confirmDialog({
        title: '删除账户',
        message: `将删除「${a.name}」及其 ${a.entries.length} 笔账户流水和对账记录。\n`
          + '这些流水镜像到记账页的记录也会一起删除。此操作不可撤销。',
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await AccountService.removeWithLedger(a.id);
      toast('已删除', 'success');
      render();
    }
  }

  /* ---------------- 进入画面 ---------------- */

  render().then(() => {
    // 抽屉深链：action:'create' 直接进新建账户流程
    if (ctx.params?.action === 'create') openCreate();
  });
  return root;
}

export default AccountView;
