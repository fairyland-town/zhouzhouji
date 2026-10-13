/**
 * settings_screen.js —— 设置：数据备份 / 提醒 / 关于
 */
import { h, mount, toast, confirmDialog, actionSheet } from '../utils/dom.js';
import { Icons } from '../widgets/icons.js';
import { PageHeader } from '../widgets/page_header.js';
import { reminderService, LEAD_MINUTES } from '../services/reminder_service.js';
import { ocrService } from '../services/ocr_service.js';
import { isNative } from '../services/native_bridge.js';
import { backupNow, shareBackup, backupStatus } from '../services/backup_service.js';
import AssetService from '../services/asset_service.js';
import { openGoldSheet } from './record/gold_sheet.js';
import { grams } from '../utils/money.js';
import { formatDateTime } from '../utils/date_utils.js';
// 🔴 版本号不在这里手写。它由 tools/build_pwa.mjs 从 package.json 生成到
//    js/version.js —— 用户判断「这次更新装上了没有」看的就是这一行，
//    手写一份迟早会与 package.json 对不上，然后开始骗人。
import { APP_VERSION_TAG } from '../version.js';

/** 备份里各 store 的中文名，用于导入结果提示 */
const STORE_LABELS = {
  events: '活动',
  checkins: '打卡项',
  checkin_logs: '打卡记录',
  ledger: '记账',
  todos: '待办',
  accounts: '账户',
  kv: '设置',
};

/** Capacitor 目录枚举 → 用户能看懂的说法 */
const DIR_LABELS = {
  DOCUMENTS: '手机「文档 / Documents」目录',
  EXTERNAL_STORAGE: '手机外部存储',
  DATA: '应用私有目录',
};

export function SettingsScreen(ctx) {
  const el = h('div', { class: 'screen screen--settings' });

  async function render() {
    const count = await ctx.db.count();

    const header = PageHeader({
      title: '设置',
      sub: '数据、提醒与关于',
      onBack: () => ctx.back(),
    });

    const body = h('div', { class: 'app-body' });

    /* ---------- 使用说明 ---------- */
    body.appendChild(h('div', { class: 'section-title', text: '帮助' }));
    body.appendChild(h('div', { class: 'list-card' }, [
      h('button', {
        class: 'list-item',
        dataset: { action: 'guide' },
        onclick: () => ctx.go('guide'),
      }, [
        h('span', { class: 'list-item__icon', html: Icons.book }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: '使用说明与输入格式' }),
          h('span', {
            class: 'list-item__desc',
            text: '哪些写法能被正确识别、哪些会踩坑，以及数据安全警告',
          }),
        ]),
        h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
      ]),
    ]));

    /* ---------- 数据统计 ---------- */
    body.appendChild(h('div', { class: 'section-title', text: '本地数据' }));
    body.appendChild(h('div', { class: 'list-card' }, [
      h('div', { class: 'list-item', style: { cursor: 'default' } }, [
        h('span', { class: 'list-item__icon', html: Icons.database }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: `已保存 ${count} 个活动` }),
          h('span', { class: 'list-item__desc', text: '数据保存在本机浏览器（IndexedDB），不上传、不联网' }),
        ]),
      ]),
    ]));

    /* ---------- 导入导出 ---------- */
    body.appendChild(h('div', { class: 'section-title', text: '备份与迁移' }));
    const fileInput = h('input', {
      type: 'file', accept: '.json,application/json', style: { display: 'none' },
      onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const text = await f.text();

          // v1.11.0：导入前先让用户选「合并」还是「替换」。
          // 合并 = 保留现有数据追加；替换 = 清空后完全还原。
          // 之所以要选：合并导入同一份文件两次会产生重复记录，
          // 而换机恢复时用户其实想要的是「替换」。
          const mode = await actionSheet({
            title: '怎么导入这份备份？',
            message: '合并：保留本机现有数据，把备份内容追加进来。\n'
              + '替换：清空本机全部数据，完全还原成备份的样子（推荐换机时用）。',
            actions: [
              { label: '合并导入（保留现有数据）', value: 'merge' },
              { label: '替换（清空后还原）', value: 'replace', danger: true },
            ],
          });
          if (!mode) { e.target.value = ''; return; }

          const res = await ctx.db.importJSON(text, { merge: mode === 'merge' });
          const parts = Object.entries(res.counts)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${STORE_LABELS[k] || k} ${n}`);
          const skipNote = res.skipped ? `，跳过 ${res.skipped} 条` : '';
          toast(
            parts.length ? `已导入 ${res.total} 条：${parts.join('、')}${skipNote}` : '备份里没有可导入的数据',
            parts.length ? 'success' : 'warn',
          );
          render();
        } catch (err) {
          toast('导入失败：' + err.message, 'error');
        }
        e.target.value = '';
      },
    });

    body.appendChild(h('div', { class: 'list-card' }, [
      h('button', { class: 'list-item', onclick: exportData }, [
        h('span', { class: 'list-item__icon', html: Icons.download }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: '导出 JSON 备份' }),
          h('span', { class: 'list-item__desc', text: '导出活动、打卡、记账、待办、账户等全部数据为一个 JSON 文件，可用于换设备或防止清缓存丢失' }),
        ]),
        h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
      ]),
      h('button', { class: 'list-item', onclick: () => fileInput.click() }, [
        h('span', { class: 'list-item__icon', html: Icons.upload }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: '从 JSON 导入' }),
          h('span', { class: 'list-item__desc', text: '从备份文件恢复数据，可选择「合并」或「清空后替换」' }),
        ]),
        h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
      ]),
      h('button', { class: 'list-item', onclick: () => copyText(ctx) }, [
        h('span', { class: 'list-item__icon', html: Icons.info }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: '复制全部活动为纯文本' }),
          h('span', { class: 'list-item__desc', text: '可直接粘贴到微信群或备忘录' }),
        ]),
        h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
      ]),
      fileInput,
    ]));

    /* ---------- v1.11.0 安卓自动备份（仅原生壳内出现） ----------
       网页版不显示这块：浏览器里没有文件系统权限，走上面的「导出 JSON」即可。 */
    if (isNative()) {
      const st = await backupStatus(ctx.db);
      const sizeTxt = st.lastSize ? `${Math.max(1, Math.round(st.lastSize / 1024))} KB` : '—';
      const dirTxt = DIR_LABELS[st.dir] || st.dir || '（尚未确定）';

      body.appendChild(h('div', { class: 'section-title', text: '自动备份到手机' }));
      body.appendChild(h('div', { class: 'list-card' }, [
        h('div', { class: 'list-item', style: { cursor: 'default' } }, [
          h('span', { class: 'list-item__icon', html: Icons.database }),
          h('span', { class: 'list-item__main' }, [
            h('span', {
              class: 'list-item__title',
              text: st.lastAt ? `上次备份：${st.lastAt}` : '还没有备份过',
            }),
            h('span', {
              class: 'list-item__desc',
              text: `位置：${dirTxt} · ${sizeTxt} · 数据改动后自动写入，切到后台时再备份一次`,
            }),
          ]),
        ]),
        h('button', { class: 'list-item', onclick: runBackup }, [
          h('span', { class: 'list-item__icon', html: Icons.check }),
          h('span', { class: 'list-item__main' }, [
            h('span', { class: 'list-item__title', text: '立即备份一次' }),
          ]),
          h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
        ]),
        h('button', { class: 'list-item', onclick: runShare }, [
          h('span', { class: 'list-item__icon', html: Icons.upload }),
          h('span', { class: 'list-item__main' }, [
            h('span', { class: 'list-item__title', text: '分享备份文件' }),
            h('span', { class: 'list-item__desc', text: '存到网盘或发给自己，用于换手机' }),
          ]),
          h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
        ]),
      ]));
    }

    /* ---------- 提醒 ---------- */
    body.appendChild(h('div', { class: 'section-title', text: '本地提醒' }));

    // 手机壳内走系统闹钟，浏览器里走页面内轮询 —— 两者的能力差别要如实写出来，
    // 否则用户会以为「开了提醒就一定响」。
    const nativeReminder = reminderService.supported && typeof Notification === 'undefined';
    const pendingN = reminderService.enabled ? await reminderService.pendingCount() : 0;

    let reminderDesc;
    if (!reminderService.supported) {
      reminderDesc = '当前浏览器不支持系统通知';
    } else if (!reminderService.enabled) {
      reminderDesc = nativeReminder
        ? `关闭中。开启后由系统闹钟提醒，关掉应用也会响（提前 ${LEAD_MINUTES} 分钟）`
        : '关闭中。开启后活动开始前会提醒你';
    } else if (nativeReminder) {
      reminderDesc = pendingN > 0
        ? `已开启：提前 ${LEAD_MINUTES} 分钟，已登记 ${pendingN} 条系统闹钟`
        : `已开启：提前 ${LEAD_MINUTES} 分钟。当前没有待提醒的活动`;
    } else {
      reminderDesc = `已开启：活动开始前 ${LEAD_MINUTES} 分钟提醒（需保持本页面打开）`;
    }

    body.appendChild(h('div', { class: 'list-card' }, [
      h('button', {
        class: 'list-item',
        onclick: async () => {
          if (!reminderService.supported) { toast('当前浏览器不支持系统通知', 'warn'); return; }
          if (reminderService.enabled) {
            await reminderService.disable();
            toast('已关闭提醒', 'success');
          } else {
            const ok = await reminderService.enable();
            if (ok) { toast('已开启提醒', 'success'); ctx.startReminders(); }
            else toast('通知权限被拒绝，请在系统设置里允许「周周记」发送通知', 'warn');
          }
          render();
        },
      }, [
        h('span', { class: `list-item__icon${reminderService.enabled ? '' : ' list-item__icon--warn'}`, html: Icons.bell }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: reminderService.enabled ? '提醒已开启' : '提醒已关闭' }),
          h('span', { class: 'list-item__desc', text: reminderDesc }),
        ]),
        h('span', {
          class: 'field-status ' + (reminderService.enabled ? 'field-status--ok' : 'field-status--miss'),
          text: reminderService.enabled ? '开' : '关',
        }),
      ]),
    ]));

    /* ---------- OCR ---------- */
    body.appendChild(h('div', { class: 'section-title', text: '图片识别（OCR）' }));
    const ocrOk = await ocrService.check();
    const ocrDesc = ocrOk
      ? ocrService.supportHint
      : (ocrService.nativeMode
        ? '设备端识别不可用，请改用「粘贴文字」'
        : '双击运行 tools/启动OCR服务.bat 后点击此处重新检测');
    body.appendChild(h('div', { class: 'list-card' }, [
      h('button', {
        class: 'list-item',
        onclick: async () => { await ocrService.check(); render(); },
      }, [
        h('span', { class: `list-item__icon${ocrOk ? '' : ' list-item__icon--warn'}`, html: Icons.image }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: ocrService.engineTitle }),
          h('span', { class: 'list-item__desc', text: ocrDesc }),
        ]),
        h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
      ]),
    ]));

    /* ---------- 危险操作 ---------- */
    body.appendChild(h('div', { class: 'section-title', text: '其他' }));

    /* v1.13.2：黄金入口从账户页搬到这里。
       账户页为了精简去掉了金价板块，但黄金市值**仍然计入净资产** ——
       入口要是跟着一起消失，那笔钱就成了「看不见、改不动、但一直在算」的
       幽灵数字。所以留一行在这里，只占一行，不占版面。 */
    const [goldList, goldPrice] = await Promise.all([AssetService.gold(), AssetService.goldPrice()]);
    const goldTotal = goldList.reduce((s, x) => s + x.grams, 0);
    const goldDesc = goldTotal > 0
      ? `持仓 ${grams(goldTotal)} · ${goldPrice > 0 ? `金价 ¥${goldPrice.toFixed(2)}/克` : '未填金价'}`
      : '还没有登记持仓';

    body.appendChild(h('div', { class: 'list-card' }, [
      h('button', {
        class: 'list-item',
        dataset: { action: 'gold' },
        onclick: () => openGoldSheet({ onChange: render }),
      }, [
        h('span', { class: 'list-item__icon', html: Icons.coins }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: '黄金持仓' }),
          h('span', { class: 'list-item__desc', text: goldDesc }),
        ]),
        h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
      ]),
      h('button', { class: 'list-item', onclick: () => loadDemo(ctx) }, [
        h('span', { class: 'list-item__icon', html: Icons.plus }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: '载入示例活动' }),
          h('span', { class: 'list-item__desc', text: '按 02 文档示例添加几条数据，便于快速体验' }),
        ]),
        h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
      ]),
      h('button', {
        class: 'list-item',
        dataset: { action: 'clear-data' },
        onclick: () => openClearData(render),
      }, [
        h('span', { class: 'list-item__icon list-item__icon--danger', html: Icons.trash }),
        h('span', { class: 'list-item__main' }, [
          h('span', { class: 'list-item__title', text: '清空数据' }),
          h('span', {
            class: 'list-item__desc',
            text: '按类别删除：活动 / 打卡 / 待办 / 记账 / 账户。选择后还会再确认一次，操作不可撤销',
          }),
        ]),
        h('span', { class: 'list-item__chev', html: Icons.chevronRightSm }),
      ]),
    ]));

    /* ---------- 关于 ---------- */
    body.appendChild(h('div', { class: 'section-title', text: '关于' }));
    body.appendChild(h('div', { class: 'list-card', style: { padding: '13px' } }, [
      h('div', { style: { fontSize: '13.5px', fontWeight: '600' }, text: '周周记' }),
      h('div', { style: { fontSize: '12px', color: 'var(--c-text-3)', marginTop: '4px', lineHeight: '1.7' } }, [
        h('div', { text: `版本 ${APP_VERSION_TAG}`, dataset: { field: 'app-version' } }),
        h('div', { text: '校园活动周历 · 计划 / 记录 / 打卡 / 管理' }),
        h('div', { text: '纯本地运行 · 不联网 · 不调用任何收费 API' }),
        h('div', { text: '识别规则：正则 + 规则引擎，识别后必须人工确认' }),
      ]),
    ]));

    mount(el, [header, body]);
  }

  /** 手动触发一次备份（仅安卓壳内可用，网页版提示改用导出） */
  async function runBackup() {
    try {
      const r = await backupNow(ctx.db);
      if (r.skipped) { toast('网页版没有自动备份，请用上面的「导出 JSON 备份」', 'warn'); return; }
      const kb = Math.max(1, Math.round(r.bytes / 1024));
      toast(`已备份（${kb} KB）到${DIR_LABELS[r.dir] || r.dir}`, 'success');
      render();
    } catch (err) {
      toast('备份失败：' + err.message, 'error');
    }
  }

  /** 把备份文件交给系统分享面板 —— 这是「数据出手机」的可靠通道 */
  async function runShare() {
    try {
      const r = await shareBackup(ctx.db);
      if (r.skipped) { toast('网页版请用上面的「导出 JSON 备份」', 'warn'); return; }
      toast('已打开分享面板', 'success');
    } catch (err) {
      toast('分享失败：' + err.message, 'error');
    }
  }

  async function exportData() {
    try {
      const json = await ctx.db.exportJSON();
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = h('a', {
        href: url,
        download: `周周记备份_${formatDateTime(new Date()).replace(/[: ]/g, '-')}.json`,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast('备份文件已导出', 'success');
    } catch (err) {
      toast('导出失败：' + err.message, 'error');
    }
  }

  async function copyText(ctx) {
    try {
      const all = await ctx.db.getAll();
      if (!all.length) { toast('暂无活动可复制', 'warn'); return; }
      const lines = all.map((e) => `${e.dateString} ${e.timeString}  ${e.title}  @${e.location}`);
      const text = lines.join('\n');
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${all.length} 条活动`, 'success');
    } catch {
      toast('复制失败，请手动导出 JSON', 'error');
    }
  }

  async function loadDemo(ctx) {
    const today = new Date();
    const mk = (offset, time, title, location) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      const [hh, mm] = time.split(':');
      d.setHours(Number(hh), Number(mm), 0, 0);
      return {
        title, location,
        startTime: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${time}`,
        rawText: '',
      };
    };
    const demo = [
      mk(0, '14:30', '人工智能专题讲座', '信息楼A201'),
      mk(1, '19:00', '研究生就业宣讲', '社科楼报告厅'),
      mk(2, '15:00', '图论中的均衡染色问题', '数学学院201报告厅'),
      mk(3, '09:30', '国家自然科学基金申报辅导会', '行政楼会议室'),
      mk(-3, '10:00', '新生入学教育大会', '大学生活动中心'),
    ];
    let n = 0;
    for (const d of demo) {
      try { await ctx.db.add(d); n++; } catch { /* 跳过非法项 */ }
    }
    toast(`已载入 ${n} 条示例活动`, 'success');
    render();
  }

  /**
   * 「清空数据」—— 两步确认（v1.12.0）。
   *
   *   ① actionSheet 选类别，每项带上当前条数，让用户知道要删掉多少；
   *   ② confirmDialog 再确认一次，把后果写清楚。
   *
   * 为什么要两步：清空不可撤销，而 actionSheet 里点一下太轻、太容易误触。
   * 先选再确认，才有「这是危险操作」的手感。
   */
  async function openClearData(rerender) {
    const cats = ctx.db.clearCategories();

    // 先数一遍各类别的条数：既用于展示，也用来把「暂无数据」的项直接过滤掉，
    // 免得用户点了一个什么都没有的类别、还要走一遍确认弹窗。
    const rows = [];
    for (const c of cats) {
      const { total } = await ctx.db.countCategory(c.key);
      rows.push({ ...c, total });
    }
    const usable = rows.filter((r) => r.total > 0);
    if (!usable.length) {
      toast('本机还没有可清空的数据', 'warn');
      return;
    }

    const pick = await actionSheet({
      title: '清空哪一类数据？',
      message: '只会删除你选中的那一类，其他数据保留。\n删除后无法撤销，建议先导出 JSON 备份。',
      actions: usable.map((r) => ({
        label: `${r.label}（${r.total} 条）`,
        value: r.key,
        danger: true,
      })),
    });
    if (!pick) return;

    const cat = rows.find((r) => r.key === pick);
    const extra = cat.key === 'accounts'
      ? '\n\n注意：记账页里由账户充值镜像出来的流水会一并删除。'
      : '';

    const ok = await confirmDialog({
      title: `确认清空${cat.label}？`,
      message: `将永久删除${cat.desc}，共 ${cat.total} 条记录，且无法撤销。${extra}`,
      okText: `确认清空${cat.label}`,
      danger: true,
    });
    if (!ok) return;

    try {
      const n = await ctx.db.clearCategory(cat.key);
      toast(`已清空${cat.label}（${n} 条）`, 'success');
    } catch (err) {
      toast('清空失败：' + err.message, 'error');
    }
    rerender();
  }

  render();
  return el;
}
