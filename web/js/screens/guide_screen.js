/**
 * guide_screen.js —— 使用说明与输入格式提示（v1.5.0）
 *
 * 定位（用户原话）：
 *   「在设置里面生成一份简单明了的使用说明和提示警告，
 *     主要就是本软件的一些输入格式等问题，
 *     而不是教别人一眼就知道该怎么使用的那些功能」
 *
 * 所以这份说明不写「点这里、再点那里」的操作教学 ——
 * 只讲三件事：
 *   ① 输入格式：什么写法能被正确识别，什么写法会踩坑
 *   ② 已知陷阱：型号当价格、四位数当年份、OCR 行序……
 *   ③ 数据安全警告：本地存储会被清、备份的意义
 *
 * 内容全部用「错误示例 ❌ / 正确示例 ✅」对照，扫一眼就懂。
 */

import { h, mount } from '../utils/dom.js';
import { Icons } from '../widgets/icons.js';
import { PageHeader } from '../widgets/page_header.js';

/* ---------------- 内容数据（改文案只动这里） ---------------- */

const SECTIONS = [
  {
    id: 'event',
    icon: 'calendar',
    title: '活动通知：这样写才能读全',
    intro: '本软件用「正则 + 规则」在本地识别文字，不联网、不调用大模型。'
      + '所以字段写得越规范，识别越准。',
    rows: [
      {
        label: '时间', good: '9月20日 14:30 / 2026-09-20 14:30',
        bad: '下周三下午 / 明天上午（相对时间无法定位到具体日期）',
      },
      {
        label: '地点', good: '信息楼A201 / 数学学院201报告厅',
        bad: '另行通知 / 待定（会被标为「未识别」，需手动补）',
      },
      {
        label: '学术活动', good: '标题写会议名或报告题目，报告人单独写「报告人：张三」',
        bad: '把报告人和题目写成一整句（报告人可能被漏掉）',
      },
      {
        label: '就业类', good: '写清公司名 + 宣讲/招聘，如「华为2026校招宣讲会」',
        bad: '只写「宣讲会」（识别不出企业名）',
      },
    ],
    warn: '识别结果一定会进「确认页」，所有字段都能改。识别不准时别删掉重打，直接在确认页改更快。',
  },
  {
    id: 'ledger',
    icon: 'wallet',
    title: '记账金额：为什么有时读不出价格',
    intro: '金额识别最容易出错的地方是「把商品型号当成了价格」。'
      + '软件已经内置了排除规则，但你也要知道边界在哪。',
    rows: [
      {
        label: '价格写法', good: '午饭100 / 打车 28 / 花了我 899 元',
        bad: '整数价格夹在长句中（可能被当成年份或数量）',
      },
      {
        label: '型号陷阱', good: '买显示器 g27 花了我 899 元 → 取 899',
        bad: '买显示器g27 → 认不出价格（g27 是型号，不是 27 元）',
      },
      {
        label: '带货币符号', good: '￥32.50 / $19.9 / ¥1,280.00',
        bad: '价格连在商品名后无空格（易与型号混淆）',
      },
      {
        label: '多行截图', good: '整段粘贴，每行一笔信息',
        bad: '只粘一行（可能丢掉真正的价格行）',
      },
    ],
    notes: [
      '识别不出金额时**宁可留空也不猜**——留空会提示你手动补，猜错会直接算进你的账。',
      '粘贴窗是多行的，支持 Ctrl / Cmd + Enter 提交，直接回车是换行。',
      '四位数会被判断是不是年份（2026 年 / 第 12 届），五位以上会被当成卡号，都不会作为金额。',
    ],
  },
  {
    id: 'account',
    icon: 'creditCard',
    title: '账户对账：差额是怎么来的',
    intro: '这个功能的目的是——不把「我还剩多少钱」完全交给第三方平台，'
      + '自己手里也留一本账，才能发现钱被误扣了。',
    steps: [
      ['① 建账户', '填期初余额（此刻卡里实际有多少钱）。这一步是所有计算的基准，一定要填准。'],
      ['② 记账', '刷一次卡记一次，不用每笔都记。充值和消费分开记，金额填正数。'
        + '充值时会要求填「这笔钱的来源」（比如工资、奖学金、报销、退款），这一项不能跳过——'
        + '日后对账时才知道每一笔钱是从哪儿来的。'],
      ['③ 对账', '去平台 / 卡机上抄下现在显示的余额填进来。'],
      ['④ 看差额', '平台显示的 vs 你按流水算出来的，差多少会标出来：'
        + '平台扣得多 → 可能有没记的消费或被误扣；你记得多 → 可能重复记了。'],
    ],
    warn: '对账时可以把差额「补记」成一笔流水来调平账面。'
      + '建议先弄清差额来源再补记，否则等于把漏洞盖住了。',
    more: [
      ['日期怎么写都行', '借出的「约定哪天还」、定期的「到期日」、待办的「截止日期」，'
        + '下面这几种写法都认：2026-10-01 / 2026.10.1 / 2026/10/1 / 2026年10月1日，'
        + '月和日不补零也没关系，存进去时会自动统一成 2026-10-01。'
        + '但「下周三」「月底」这类说法认不出来，会提示你重填。'],
      ['哪些能跳过', '标注「可跳过」的字段（约定还款日、年利率、到期日、备注），'
        + '直接留空点保存就行，不会影响这笔记录存进去。'
        + '没标「可跳过」的是必填项，留空会在弹窗里就地提示，不会悄悄存个 0。'],
      ['账户充值会自动进记账页', '在账户里**充值**，记账页会同步生成一条「账户充值」的流水，'
        + '备注里带你填的内容和账户名，所以记账页看到的是你全部的钱的进出。'
        + '账户里的「消费」不会再镜像一份 —— 日常消费本来就在记账页记，'
        + '两边都记等于同一笔钱算两遍。'
        + '这类充值流水在记账页不能直接改删，要回账户页操作，这样两边才对得上。'],
      ['记账时从账户扣钱', '「记一笔」右下角的「账户」一格可以选一个账户：'
        + '选了就真从那个账户的余额里扣掉，并计进它的「累计消耗」；'
        + '记账页这边仍然只有这一笔，不会重复算。不选就是普通记账，不动任何账户。'
        + '改金额 / 换账户 / 删掉这笔，账户上对应的流水都会跟着一起变。'],
      ['每月按时扣款', '在账户卡的「定时」按钮，或在右上角「⋮」菜单里进入。'
        + '设置好金额和每月几号（1–28，避开没有 31 号的月份），到日子会自动从余额里扣掉，'
        + '并同步记进记账页。打开 App 时会补齐所有错过的月份，但不会倒扣设置之前的月份。'
        + '不想要了随时可以在同一入口关掉。'],
    ],
  },
  {
    id: 'todo',
    icon: 'record',
    title: '待办与打卡',
    rows: [
      {
        label: '待办截止日', good: '2026-09-20 / 2026.9.20 / 2026/9/20 都认',
        bad: '「下周」「尽快」——不会算逾期，也不会排序到前面',
      },
      {
        label: '打卡', good: '当天打卡后可点月历补打 / 取消',
        bad: '未来日期不能打卡（还没到，打了也没意义）',
      },
    ],
  },
  {
    id: 'ocr',
    icon: 'image',
    title: '图片识别：依赖本机 OCR',
    intro: '图片识别走的是 Windows 系统自带的离线 OCR 引擎，'
      + '图片不会离开你的电脑，也不产生任何费用。',
    warn: '如果提示「OCR 未启动」，需要先在电脑上运行 tools/启动OCR服务.bat。'
      + '手机上使用时图片识别不可用，请改用「手动输入」或「粘贴文字」。',
  },
  {
    id: 'backup',
    icon: 'database',
    title: '数据安全：请务必看一眼',
    intro: '所有数据只存在这台设备的浏览器里（IndexedDB），不上传、不联网。'
      + '这是隐私优势，但也意味着存在丢失风险。',
    warnings: [
      '清理浏览器缓存 / 卸载浏览器 / 使用「无痕模式」，都会**永久删除**数据且无法恢复。',
      '换设备、刷系统前，一定先到「设置 → 导出 JSON 备份」。',
      '建议每月导出一次，把 JSON 文件放到网盘或邮箱里。',
      '卸载本 App（手机上）同样会清除数据 —— 卸载前先导出。',
      '导入备份是「合并」模式，不会覆盖已有记录。',
    ],
  },
];

/* ---------------- 视图 ---------------- */

export function GuideScreen(ctx) {
  const el = h('div', { class: 'screen screen--guide' });

  function render() {
    const header = PageHeader({
      title: '使用说明',
      sub: '输入格式 · 识别陷阱 · 数据安全',
      onBack: () => ctx.back(),
    });

    const body = h('div', { class: 'app-body' });

    /* 顶部导语 */
    body.appendChild(h('div', { class: 'guide-lead' }, [
      h('div', { class: 'guide-lead__title', text: '这份说明只讲「容易踩坑的地方」' }),
      h('div', {
        class: 'guide-lead__text',
        text: '基础操作看界面就会，这里不重复。以下内容按主题分组，'
          + '标 ✅ 的是能正常识别的写法，标 ❌ 的是会出问题的写法。',
      }),
    ]));

    /* 目录（点击跳转） */
    const toc = h('div', { class: 'guide-toc' });
    SECTIONS.forEach((s) => {
      toc.appendChild(h('button', {
        class: 'guide-toc__item',
        onclick: () => {
          const target = document.getElementById(`guide-${s.id}`);
          if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      }, [
        h('span', { class: 'guide-toc__icon', html: Icons[s.icon] || Icons.info }),
        h('span', { class: 'guide-toc__label', text: s.title.split('：')[0] }),
      ]));
    });
    body.appendChild(toc);

    /* 各主题 */
    SECTIONS.forEach((s) => {
      const card = h('div', { class: 'guide-card', id: `guide-${s.id}` }, [
        h('div', { class: 'guide-card__head' }, [
          h('span', { class: 'guide-card__icon', html: Icons[s.icon] || Icons.info }),
          h('span', { class: 'guide-card__title', text: s.title }),
        ]),
      ]);

      if (s.intro) {
        card.appendChild(h('div', { class: 'guide-card__intro', text: s.intro }));
      }

      /* 对照表：✅ 能识别 / ❌ 会踩坑 */
      if (s.rows) {
        const rows = h('div', { class: 'guide-rows' });
        s.rows.forEach((r) => {
          rows.appendChild(h('div', { class: 'guide-row' }, [
            h('div', { class: 'guide-row__label', text: r.label }),
            h('div', { class: 'guide-row__good' }, [
              h('span', { class: 'guide-row__mark', text: '✅' }),
              h('span', { text: r.good }),
            ]),
            h('div', { class: 'guide-row__bad' }, [
              h('span', { class: 'guide-row__mark', text: '❌' }),
              h('span', { text: r.bad }),
            ]),
          ]));
        });
        card.appendChild(rows);
      }

      /* 编号步骤 */
      if (s.steps) {
        const steps = h('div', { class: 'guide-steps' });
        s.steps.forEach(([t, d]) => {
          steps.appendChild(h('div', { class: 'guide-step' }, [
            h('div', { class: 'guide-step__title', text: t }),
            h('div', { class: 'guide-step__desc', text: d }),
          ]));
        });
        card.appendChild(steps);
      }

      /* 补充要点 */
      if (s.notes) {
        const notes = h('div', { class: 'guide-notes' });
        s.notes.forEach((n) => notes.appendChild(h('div', { class: 'guide-note', text: n })));
        card.appendChild(notes);
      }

      /* 补充说明（带小标题的两栏块，v1.7.0 用于「账户」章节讲流水同步与月扣款） */
      if (s.more) {
        const more = h('div', { class: 'guide-more' });
        s.more.forEach(([t, d]) => {
          more.appendChild(h('div', { class: 'guide-more__item' }, [
            h('div', { class: 'guide-more__title', text: t }),
            h('div', { class: 'guide-more__desc', text: d }),
          ]));
        });
        card.appendChild(more);
      }

      /* 单条警告 */
      if (s.warn) {
        card.appendChild(h('div', { class: 'guide-warn' }, [
          h('span', { class: 'guide-warn__icon', html: Icons.warn }),
          h('span', { class: 'guide-warn__text', text: s.warn }),
        ]));
      }

      /* 多条警告（数据安全） */
      if (s.warnings) {
        const box = h('div', { class: 'guide-danger' });
        s.warnings.forEach((w) => {
          box.appendChild(h('div', { class: 'guide-danger__item' }, [
            h('span', { class: 'guide-danger__dot', html: Icons.warn }),
            h('span', { text: w }),
          ]));
        });
        card.appendChild(box);
      }

      body.appendChild(card);
    });

    /* 页脚 */
    body.appendChild(h('div', { class: 'guide-foot' }, [
      h('div', { class: 'guide-foot__line', text: '识别规则全部在本机运行，不联网、不调用任何收费服务。' }),
      h('div', { class: 'guide-foot__line', text: '识别结果永远需要人工确认 —— 这一步不能省。' }),
    ]));

    mount(el, [header, body]);
  }

  render();
  return el;
}

export default GuideScreen;
