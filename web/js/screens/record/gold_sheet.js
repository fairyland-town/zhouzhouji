/**
 * gold_sheet.js —— 黄金持仓 / 金价管理面板
 *
 * v1.13.2 从 account_view.js 搬出来。原因是账户页上的黄金板块被去掉了
 * （用户要求精简版面），但黄金市值**仍然计入净资产**。
 * 如果连入口一起删掉，用户就再也没法改金价、也没法删持仓 ——
 * 那笔钱会变成一个「看不见、改不动、但一直在参与计算」的幽灵数字。
 * 所以入口挪到「设置 → 黄金持仓」，面板本身抽成独立模块。
 *
 * 调用方通过 onChange 回调决定「改完之后刷新谁」：
 * 账户页传 render，设置页也传 render —— 面板本身不认识任何一个页面。
 */

import { toast, confirmDialog, actionSheet } from '../../utils/dom.js';
import AssetService from '../../services/asset_service.js';
import { money, grams } from '../../utils/money.js';
import { promptDialog } from './checkin_view.js';

/**
 * 打开黄金面板。
 * @param {{ onChange?: () => void }} [opts] 改动落库后的刷新回调
 */
export async function openGoldSheet({ onChange } = {}) {
  const refresh = typeof onChange === 'function' ? onChange : () => {};
  const [list, price] = await Promise.all([AssetService.gold(), AssetService.goldPrice()]);
  const totalGrams = list.reduce((s, x) => s + x.grams, 0);

  const act = await actionSheet({
    title: `黄金 · ${grams(totalGrams)}`,
    message: price > 0
      ? `按当前金价 ¥${price.toFixed(2)}/克 折算约 ${money(totalGrams * price)}。`
      : '还没填金价，填了才能折算市值（不填就不计入净资产，不会凭空多出一个数）。',
    actions: [
      { label: price > 0 ? '修改当前金价' : '填写当前金价', value: '__price' },
      { label: '＋ 添加持仓', value: '__add' },
      ...list.map((x) => ({
        label: `${x.name || '持仓'}  ${grams(x.grams)}`,
        value: x.id,
      })),
    ],
  });
  if (!act) return;

  if (act === '__price') {
    const v = await promptDialog({
      title: '当前金价',
      message: '每克多少元。填 0 表示先不计入净资产。',
      value: price > 0 ? String(price) : '',
      placeholder: '例如：932.81',
      okText: '保存',
      // 🔴 这里留空会被 Number('') 悄悄算成 0 =「不计入净资产」。
      //    用户本来只是想改个金价、手一滑清空了输入框，净资产就会
      //    凭空少掉几万块，而且没有任何提示。想清零请明确填 0。
      required: true,
      requiredHint: '请填写金价，不想计入就填 0',
    });
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { toast('请输入不小于 0 的数字', 'warn'); return; }
    await AssetService.setGoldPrice(n);
    toast(n > 0 ? `金价已设为 ¥${n.toFixed(2)}/克` : '已清除金价', 'success');
    refresh();
    return;
  }

  if (act === '__add') {
    const name = await promptDialog({
      title: '这是什么',
      message: '比如「金条 10g」「金饰」「积存金」。',
      placeholder: '例如：金条',
      okText: '下一步',
    });
    if (name === null) return;
    const g = await promptDialog({
      title: '克重',
      message: '支持三位小数，比如 3.125 克。',
      placeholder: '例如：10',
      okText: '保存',
      required: true,
      requiredHint: '请填写克重',
    });
    if (!g) return;
    const n = Number(g);
    if (!Number.isFinite(n) || n <= 0) { toast('请输入大于 0 的克重', 'warn'); return; }
    try {
      await AssetService.addGold({ name: name || '持仓', grams: n });
      toast(`已添加 ${grams(n)}`, 'success');
      refresh();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const target = list.find((x) => x.id === act);
  if (!target) return;
  const okDel = await confirmDialog({
    title: '删除这笔持仓',
    message: `${target.name || '持仓'} ${grams(target.grams)}。`,
    okText: '删除', danger: true,
  });
  if (!okDel) return;
  await AssetService.removeGold(target.id);
  toast('已删除', 'success');
  refresh();
}
