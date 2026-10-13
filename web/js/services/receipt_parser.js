/**
 * receipt_parser.js —— 从支付截图 OCR 文本 / 粘贴文字中提取记账字段（v1.3.0）
 *
 * 纯规则解析，离线可用，不调用任何在线服务。
 *
 * 覆盖两类常见输入：
 *   1) 微信 / 支付宝 支付截图 OCR 结果，如：
 *        「微信支付」「付款成功」「-12.50」「收款方 瑞幸咖啡」「2026-09-15 14:32」
 *   2) 手动粘贴的一句话，如：
 *        「午饭 12.5 元」「打车 28」「9月14日 奶茶 15」
 *
 * 设计原则（沿用活动解析器的经验）：
 *   - 金额、方向、日期、商户各自独立解析，互不干扰
 *   - 方向判定优先于金额，因为「余额」「优惠」里也有数字，容易误伤
 *   - 金额候选先按「与收付关键词同行」优先，再退化为全文最大值
 */

import { formatDate } from '../utils/date_utils.js';

/**
 * 用于置信度判定的方向特征词（parseDirection 内部按短语/关键词两级处理）
 */
const DIRECTION_HINTS = [
  '支付成功', '付款成功', '已支付', '已付款', '扣款', '付款给', '转账给',
  '收款成功', '已收款', '收到转账', '退款', '到账', '收入', '支出', '收款',
];

/** 需要排除的「含数字但不是金额」的行 */
const NOISE_LINES = [
  /余额/, /优惠/, /立减/, /折扣/, /积分/, /卡号/, /尾号/, /订单号/, /交易单号/, /流水号/,
  /服务费说明/, /客服/, /热线/, /手机号/, /验证码/, /第\s*\d+\s*[条笔]/,
  // v1.4.1：银行卡 / 实名 / 券码 这类纯编号行，数字都不可能是金额
  /银行/, /储蓄卡|信用卡|借记卡|贷记卡/, /持卡人|开户行/, /身份证/, /商户单号/, /券码|券号|核销码/,
];

/**
 * 日期/时间行本身就是噪音。
 * 不加这条的话，「2026-09-15 14:32」会被当成金额 2026 取走最大值，
 * 这是实际截图里最容易踩的坑。
 */
const NOISE_VALUE = /(\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2})|(\d{1,2}:\d{2})/;

/** 商户 / 收款方关键词（带标签前缀的写法，最可靠） */
const MERCHANT_KEYS = [
  '收款方', '收款人', '付款方', '商户名称', '商户全称', '商户', '对方', '商家', '转入方',
  '交易对方', '交易对象', '支付对象', '付款对象', '店铺名称', '店铺', '门店名称', '商户简称',
];

/** 商户名里常见的噪音后缀 */
const MERCHANT_NOISE = /(有限公司|有限责任公司|股份|科技|商贸|网络|门店|分店|旗舰店)$/;

/**
 * 支付 App / 平台自身的名字。
 * 这类词出现在截图里是「这是哪个 App」，不是「这笔钱花在哪儿」，
 * 不能当备注 —— 否则每笔账的备注都会变成「微信支付」「支付宝」。
 */
const APP_NAMES = [
  '微信支付', '微信', '支付宝', 'Alipay', '云闪付', '银联', '美团支付', '京东支付',
  '付款码', '扫一扫', '零钱通', '余额宝', '花呗', '银行卡', '信用卡', '储蓄卡',
];

/**
 * 支付流程状态词：描述「这笔交易成没成」，不描述「买了什么」。
 */
const STATUS_WORDS = [
  '支付成功', '付款成功', '交易成功', '支付完成', '付款完成', '交易完成', '交易关闭',
  '已支付', '已付款', '已收款', '收款成功', '收到转账', '退款成功', '退款', '到账',
  '待支付', '待付款', '正在支付', '支付中', '订单已完成', '订单已取消', '已完成',
  '支付方式', '付款方式', '交易方式', '订单号', '交易单号', '商户单号', '流水号',
  '交易时间', '付款时间', '支付时间', '下单时间', '创建时间', '订单时间',
];

/** 备注里要剔除的字段标签（它们只是标签，后面的值才是有用信息） */
const NOTE_LABEL_NOISE = /^(订单备注|备注|说明|附言|商品说明|商品名称|交易说明)\s*[:：]?\s*/;

/** 「记一笔」一句话里常见的时间前缀，属于噪音不是用途 */
const NOTE_TIME_NOISE = /^(今天|昨天|前天|今早|今晚|早上|上午|中午|下午|晚上|凌晨|刚刚)\s*/;

/** 判断某行是否含消费场景特征词（用于优选最像商户名的那一行） */
const MERCHANT_HINTS = [
  /餐|饭|外卖|奶茶|咖啡|食堂|早点|早餐|午餐|晚餐|夜宵|烧烤|火锅|烤肉|小吃|面馆|米线|瑞幸|星巴克|麦当劳|肯德基|必胜客|汉堡|披萨/,
  /地铁|公交|打车|出租|滴滴|车费|高铁|火车|机票|加油|单车/,
  /书|资料|打印|文具|课程|培训|考试|报名|学费|网课/,
  /超市|百货|理发|洗护|快递|水费|电费|便利店|药店/,
  /电影|游戏|唱歌|ktv|会员|娱乐|门票|演出|健身/,
  /药|医院|挂号|体检|诊所|牙科/,
  /店|馆|超市|广场|中心|大厦|学院|大学|公司|银行|酒店|餐厅|酒楼|茶楼/,
];

/**
 * 从一句自然语言里剥掉金额、日期、方向词，剩下的就是「这笔钱干什么用了」。
 * 例：
 *   「午饭 12.5 元」        → 午饭
 *   「打车 28」             → 打车
 *   「9月15日 食堂午饭 15元」 → 食堂午饭
 *   「支出 35 元 买书」      → 买书
 * 返回空串表示这句话里没有天然的用途描述。
 */
function extractPhrase(text) {
  let s = String(text || '');

  // ① 去掉带货币符号/单位的金额
  s = s.replace(/[¥￥]\s*\d{1,9}(?:[.,]\d{1,2})?/g, ' ');
  s = s.replace(/\d{1,9}(?:[.,]\d{1,2})?\s*(?:元|块|块钱|角|毛)/g, ' ');
  // ② 去掉日期 / 时间
  s = s.replace(/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*[日号]?/g, ' ');
  s = s.replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, ' ');
  s = s.replace(/\d{1,2}\s*[:：]\s*\d{1,2}(?::\d{1,2})?/g, ' ');
  s = s.replace(/\d{1,2}\s*[-/]\s*\d{1,2}(?!\d)/g, ' ');
  // ③ 去掉方向 / 状态 / 支付动作词
  s = s.replace(/支出|收入|消费|花费|花了|付了|付给|付款|收款|支付|到账|转账|充值/g, ' ');
  // ④ 去掉时间前缀与「的」结尾
  s = s.replace(NOTE_TIME_NOISE, ' ');
  // ⑤ 去掉剩下的裸数字（没有单位的金额候选）
  s = s.replace(/(?<![A-Za-z0-9])\d+(?:[.,]\d{1,2})?(?![A-Za-z0-9])/g, ' ');
  // ⑥ 去掉分隔标点
  s = s.replace(/[，,。；;、:：!！?？~～\-—–()（）[\]【】"“”]/g, ' ');
  // ⑦ 去掉支付 App 名与状态词（可能在剥标点后才暴露出来）。
  //    注意：「支付成功」若只删掉「支付」会残留孤立的「成功」，
  //    所以整串状态短语要先删，再删单词。
  for (const w of STATUS_WORDS) s = s.split(w).join(' ');
  for (const w of APP_NAMES) s = s.split(w).join(' ');
  // ⑧ 清掉剥词后残留的孤立状态字（成功 / 完成 / 失败 / 中 / 已…）
  s = s.replace(/成功|完成|失败|关闭|取消|进行中|\b中\b|已|待/g, ' ');
  s = s.replace(NOTE_LABEL_NOISE, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** 备注是否只是「状态/动作」的残渣，没有实际描述力 */
const NOTE_RESIDUE = /^(成功|完成|失败|中|已|待|元|块|钱|款|账)$/;

function lines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 是否是需要忽略的噪音行 */
function isNoise(line) {
  if (line.length > 40) return true;
  // 纯日期 / 时间行不算金额来源
  if (NOISE_VALUE.test(line) && !/[¥￥]|元/.test(line)) return true;
  return NOISE_LINES.some((re) => re.test(line));
}

/* ================================================================
   金额候选提取 —— v1.4.1 重写
   ================================================================

   旧实现有两个致命问题（用户实际踩到的）：

   ① 型号/编号被当成价格
      「买显示器g27」里 g27 的 27、「买iPhone15」里的 15，
      都被通用数字正则吃成了金额候选，于是「价格」显示成型号。

   ② 谁先出现就用谁（并且取全局最大值）
      截图 OCR 出来的行序是随机的，早餐那笔的「3.5」可能排在正餐
      「100」前面，取最大值又撞上大额数字，于是金额串到别人头上。

   新规则：
     · 数字不能紧贴拉丁字母（左侧）—— 甩掉 g27 / iPhone15 / A4
       （型号在数字左边，所以只锁左边即可，不会误伤带单位的「25GB」价位写法）
     · 数字不能带千分位分组或长度 ≥ 7 —— 甩掉卡号 / 订单号
     · 数字若是 4 位且紧贴「年 / 月 / 日 / 期 / 届」这类中文单位 —— 甩掉年份（2026年）
     · 中文数量词（3个 / 2杯 / 1份 / 5次…）是计数不是金额 —— 整段跳过
     · 日期 / 时间通篇先挖掉，避免「9月15日」拆出 9、15
     · 金额一般带货币记号或小数点；OCR 把「0.65」误认成「065」时，
       允许它是个整数行独立候选。
*/

/** 货币书写标记：出现即认为这一行「在说钱」 */
const MONEY_MARK = /[¥￥$]|\d\s*元|元\s*\d|块钱|块\s*钱|人民币|RMB|CNY/i;

/** 中文数量词单位：数字后面跟这些字，是「几个」而不是「多少钱」 */
const CN_COUNT_UNIT = '个位件只杯份碗瓶盒袋张本台条根双套次回遍顿串包颗粒支把顶斤两克升步人天年月日周号';

/** 前一位是拉丁字母 → 这是型号/编号的一部分，不是金额 */
function precededByLatin(s, i) {
  return i > 0 && /[A-Za-z]/.test(s[i - 1]);
}

/** 前一段是不是数字（用于识别千分位分组 / 粘连的长数字） */
function precededByDigitChar(s, i) {
  return i > 0 && /[\d.,]/.test(s[i - 1]);
}

/**
 * 判断一个数字记号是否「像金额」。
 * @param {string} num  数字文本，如 "12.50"
 * @param {string} s    它所在的整行
 * @param {number} i    在整行中的下标
 * @returns {boolean} 是否保留为金额候选
 */
function isAmountLike(num, s, i) {
  // 型号后缀：g27 / iPhone15 / A4 / i5
  if (precededByLatin(s, i)) return false;
  // 千分位分组（6222,0212）或粘连长数字（卡号 / 订单号）
  if (precededByDigitChar(s, i)) return false;
  const intLen = num.split('.')[0].replace(/,/g, '').length;
  if (intLen >= 7) return false;
  // 4 位纯整数紧贴「年 / 届 / 期」等 → 年份或编号
  if (/^\d{4}$/.test(num) && /^[年月日期届]/.test(s.slice(i + num.length))) return false;

  const before = s[i - 1] ?? '';
  const afterLen = num.length;
  const after = s.slice(i + afterLen);

  // 中文数量词：1份 / 3杯 / 2次 —— 是计数不是金额
  if (/^[个位件只杯份碗瓶盒袋张本台条根双套次回遍顿串包颗粒支把顶斤两克升步人天年月日周号]/.test(after)) {
    return false;
  }
  // 货币记号：¥ 在左，元 / 块 在右
  if (/[¥￥$]/.test(before)) return true;
  if (/[.,]\d{1,2}/.test(num)) return true;                 // 有小数位，最像价格
  if (/^\s*(?:元|块钱|块|人民币|RMB|CNY)/i.test(after)) return true; // 12.5元 / 12 块
  if (/^\s*[¥￥$]/.test(after)) return true;               // 12.50¥
  // 无任何货币记号的裸整数：只有在它独占整行（OCR 常见）才算，
  // 混在文字里的（「午饭100」「买书45」）留给 trailingPriceOnLine 按行尾约定处理，
  // 这样既不会把「买显示器g27」的型号当钱，也不会把「午饭100」漏掉。
  if (s.trim() === num) return true;
  return false;
}

/**
 * 逐行收集金额候选。
 * @returns {{value:number, strong:boolean, line:string, index:number}[]}
 *   strong=true 表示这行带货币记号（OCR 常见的「065」这种纯数字行只会是 weak）
 */
function collectAmounts(text) {
  const out = [];
  lines(text).forEach((raw, li) => {
    if (isNoise(raw)) return;
    // 先把日期 / 时间挖掉，免得「9月15日」被拆成 9 与 15
    const s = raw
      .replace(/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*[日号]?/g, ' ')
      .replace(/\d{1,2}\s*[:：]\s*\d{1,2}(?::\d{1,2})?/g, ' ')
      .replace(/\d{1,2}\s*[-/]\s*\d{1,2}(?!\d)/g, ' ');

    const strongLine = MONEY_MARK.test(s);
    for (const m of s.matchAll(/\d{1,9}(?:[.,]\d{1,2})?/g)) {
      const num = m[0].replace(/,/g, '');
      if (!isAmountLike(num, s, m.index)) continue;
      const n = Number(num);
      if (!Number.isFinite(n) || n <= 0 || n >= 1000000) continue;
      out.push({
        value: Math.round(n * 100) / 100,
        strong: strongLine,
        line: raw,
        index: li,
      });
    }
  });
  return out;
}

/** 金额关键词：和数字同行时几乎是明示（"实付 88.00"） */
const AMOUNT_KEYS = /(实付|应付|合计|总计|小计|金额|付款|支付|收款|收入|支出|消费|花费)/;

/**
 * 一句话记账（「午饭100」「打车 28」）的行级识别。
 *
 * 这类输入没有任何货币记号，全文没有第二行可供对照，
 * 所以只能用位置约定：**行尾**那个孤立数字就是价格。
 *
 * 注意这里不能用 isAmountLike 过滤 —— 它的定位是「有货币记号的强候选」，
 * 会把「午饭100」的 100 也滤掉。这里只需要排除「明显不是价格的数字」：
 * 型号（g27）、卡号（6222 0212）、年份（2026年）、中文量词（3杯）。
 *
 * @returns {number} 认出来的金额；没有明显价格时返回 0
 */
function trailingPriceOnLine(line) {
  const s = String(line || '').trim();
  if (!s) return 0;

  // 找「像价格」的数字：排除型号 / 卡号 / 年份 / 中文量词
  const nums = [];
  for (const m of s.matchAll(/\d{1,9}(?:[.,]\d{1,2})?/g)) {
    const num = m[0];
    const i = m.index;
    // 型号：左边紧贴拉丁字母（g27 / iPhone15）
    if (i > 0 && /[A-Za-z]/.test(s[i - 1])) continue;
    // 卡号 / 订单号：千分位分组或超长
    if (i > 0 && /[\d.,]/.test(s[i - 1])) continue;
    if (num.split('.')[0].replace(/,/g, '').length >= 7) continue;
    const after = s.slice(i + num.length);
    // 年份 / 编号：4 位整数紧跟「年 / 届 / 期 / 月 / 日 / 号」
    if (/^\d{4}$/.test(num) && /^[年月日期届号]/.test(after)) continue;
    // 中文量词：3杯 / 2份 / 5次 —— 是计数不是金额
    if (/^[个位件只杯份碗瓶盒袋张本台条根双套次回遍顿串包颗粒支把顶斤两克升步人天周]/.test(after)) continue;
    nums.push({ num, index: i });
  }
  if (nums.length !== 1) return 0;
  const { num, index } = nums[0];
  const tail = s.slice(index + num.length);
  if (!/^\s*[。.!！?？~～]*$/.test(tail)) return 0;

  const n = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n >= 1000000) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * 解析金额。
 *
 * 优先级（每一步都只用「像金额」的候选，见 collectAmounts）：
 *   ① 与「实付/金额/合计」同行 —— 明示，直接取该行数值
 *   ② 带货币记号的候选 —— 取「带记号候选的最大值」，位置无关
 *   ③ 带正负号、独占一行的数字（支付截图主流形态）
 *   ④ 一句话里的行尾数字（「午饭100」「打车 28」）
 *   ⑤ 纯数字独占一行（OCR 把 0.65 认成 065 时的补救）
 *   ⑥ 兜底：全文（已过滤型号）最大值
 *
 * 关键设计：①→② 是「位置无关」的，所以 OCR 把哪一行排在前面都不影响结果；
 * 这就是用户反馈的「早餐金额显示在前面」的根治办法。
 * 而「买显示器g27」这类只有型号没有价格的输入，宁可返回 0 让用户手填，
 * 也绝不把型号当价格。
 */
export function parseAmount(text) {
  const src = String(text || '');
  if (!src.trim()) return 0;

  const toNum = (s) => {
    const n = Number(String(s).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const clean = (arr) => arr.filter((v) => v > 0 && v < 1000000);

  const rawLines = lines(src);
  const cands = collectAmounts(src);

  // ① 金额关键词所在行：该行如果有金额候选，取本行最大值
  const keyLineIdx = new Set();
  rawLines.forEach((l, i) => { if (!isNoise(l) && AMOUNT_KEYS.test(l)) keyLineIdx.add(i); });
  if (keyLineIdx.size) {
    const onKeyLines = cands.filter((c) => keyLineIdx.has(c.index)).map((c) => c.value);
    if (onKeyLines.length) return Math.max(...onKeyLines);
  }

  // ② 带 ¥ / ￥ / 元 标记的候选：取最大，与行序无关
  const marked = clean(cands.filter((c) => c.strong).map((c) => c.value));
  if (marked.length) return Math.max(...marked);

  // ③ 带正负号、独占一行的数字
  const signed = clean([...src.matchAll(/(?:^|\n)\s*([+-]\s*\d{1,9}(?:\.\d{1,2})?)\s*(?:\n|$)/g)]
    .map((m) => toNum(m[1])));
  if (signed.length) return Math.max(...signed);

  // ④ 一句话：行尾数字即价格（「午饭100」「打车 28」）
  const phrased = [];
  for (const l of rawLines) {
    if (isNoise(l)) continue;
    const v = trailingPriceOnLine(l);
    if (v > 0) phrased.push(v);
  }
  if (phrased.length) return Math.max(...phrased);

  // ⑤ 纯数字独占一行（OCR 丢了小数点：「0.65」→「065」）
  const bare = clean(cands.filter((c) => c.line.trim() === String(c.value)).map((c) => c.value));
  if (bare.length) return Math.max(...bare);

  // ⑥ 兜底
  const all = clean(cands.map((c) => c.value));
  return all.length ? Math.max(...all) : 0;
}

/**
 * 解析收 / 支方向，默认支出（记账场景里支出占绝大多数）。
 * 关键修正：不能直接比全文 indexOf —— 支付宝的 App 名「支付宝」里就含「支付」，
 * 会让收款截图被误判为支出。所以先按「完整短语」匹配，只有找不到短语时才退到单字关键词。
 */
export function parseDirection(text) {
  const src = String(text || '');

  const firstIdx = (words) => Math.min(...words.map((w) => {
    const i = src.indexOf(w);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  }));

  // 强特征短语：出现即定方向，几乎不会误伤
  const expPhrase = firstIdx(['支付成功', '付款成功', '已支付', '已付款', '付款给', '转账给', '扣款']);
  const incPhrase = firstIdx(['收款成功', '已收款', '收到转账', '收款方', '退款', '到账']);
  if (incPhrase !== Number.POSITIVE_INFINITY || expPhrase !== Number.POSITIVE_INFINITY) {
    return incPhrase <= expPhrase ? 'income' : 'expense';
  }

  // 弱特征关键词兜底
  const expIdx = firstIdx(['支出', '消费', '支付', '付款']);
  const incIdx = firstIdx(['收入', '收款', '转入', '红包']);
  if (expIdx === Number.POSITIVE_INFINITY && incIdx === Number.POSITIVE_INFINITY) return 'expense';
  return incIdx < expIdx ? 'income' : 'expense';
}

/**
 * 是否为「无描述力的」文本（App 名、状态词、纯数字等），
 * 用于拒绝把「微信支付」这种 App 名当成备注。
 */
function isMeaninglessNote(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  // 去掉 App 名 / 状态词后什么都不剩 → 没意义
  const stripped = extractPhrase(t);
  if (!stripped) return true;
  // 只剩「成功」「完成」这类状态残渣
  if (NOTE_RESIDUE.test(stripped)) return true;
  // 剩下的全是支付平台自身名字
  if (APP_NAMES.some((w) => t === w || stripped === w)) return true;
  if (STATUS_WORDS.some((w) => t === w)) return true;
  return false;
}

/** 解析商户 / 收款方（带标签的写法） */
export function parseMerchant(text) {
  const src = String(text || '');
  for (const l of lines(src)) {
    for (const k of MERCHANT_KEYS) {
      const i = l.indexOf(k);
      if (i >= 0) {
        const v = l.slice(i + k.length).replace(/^[：:]\s*/, '').trim();
        if (v) return v.replace(MERCHANT_NOISE, '').trim() || v;
      }
    }
  }
  return '';
}

/**
 * 独立成行的商户名。
 *
 * 支付宝 / 美团的账单详情页常常把店铺名单独放一行，前面没有「收款方」这类标签：
 *   「支付成功」「¥28.00」「2026-09-15」「星际烤肉店」「订单号 …」
 * 这种情况下 parseMerchant 抓不到，之前备注就整条空掉。
 *
 * 判定思路：逐行排除掉「金额行 / 日期行 / App 名 / 状态词 / 标签行」，
 * 剩下的含有实体特征（中文、企业后缀、或含分类关键词）的行就是商户名。
 */
function parseMerchantLine(text, knownCategory = '') {
  const src = String(text || '');
  for (const l of lines(src)) {
    const t = l.trim();
    if (!t) continue;
    // 不能是金额 / 日期 / 时间行
    if (/[¥￥]|\d\s*元|^\s*[+-]?\s*\d{1,9}(?:[.,]\d{1,2})?\s*$/.test(t)) continue;
    if (NOISE_VALUE.test(t)) continue;
    if (isNoise(t)) continue;
    // 不能是「标签：值」形式的行（时间/订单号/支付方式…）
    if (/^[^：:]{1,8}\s*[:：]/.test(t)) continue;
    // 不能是 App 名或状态词
    if (APP_NAMES.some((w) => t.includes(w))) continue;
    if (STATUS_WORDS.some((w) => t.includes(w))) continue;
    // 长度合理，且要有中文（商户名几乎都含中文）
    if (t.length < 2 || t.length > 30) continue;
    if (!/[\u4e00-\u9fa5]/.test(t)) continue;
    // 排除「欢迎光临」这类客套话
    if (/^(欢迎|感谢|谢谢|恭喜|温馨提示|客服|如有疑问)/.test(t)) continue;

    // 命中分类关键词的（如「星际烤肉店」里的「烤肉」）优先
    if (knownCategory && knownCategory !== 'other_ex'
      && knownCategory !== 'other_in'
      && MERCHANT_HINTS.some((re) => re.test(t))) {
      return t.replace(MERCHANT_NOISE, '').trim() || t;
    }
  }
  // 次选：任意一条看起来像店名的行
  for (const l of lines(src)) {
    const t = l.trim();
    if (!t || t.length < 2 || t.length > 30) continue;
    if (!/[\u4e00-\u9fa5]/.test(t)) continue;
    if (NOISE_VALUE.test(t) || isNoise(t)) continue;
    if (/[¥￥]|\d\s*元/.test(t)) continue;
    if (/^[^：:]{1,8}\s*[:：]/.test(t)) continue;
    if (APP_NAMES.some((w) => t.includes(w)) || STATUS_WORDS.some((w) => t.includes(w))) continue;
    if (/^(欢迎|感谢|谢谢|恭喜|温馨提示|客服|如有疑问)/.test(t)) continue;
    // 含数字的行多半是单号 / 金额，不要
    if (/\d/.test(t)) continue;
    return t.replace(MERCHANT_NOISE, '').trim() || t;
  }
  return '';
}

/**
 * 解析备注（这笔钱干什么用了）。
 *
 * 三级策略：
 *   ① 带「收款方 / 商家」标签 → 直接取标签后的值（最准）
 *   ② 独立成行的商户名（支付宝 / 美团风格）
 *   ③ 一句话里剥掉金额/日期/方向词后剩下的短语（「午饭 12.5 元」→「午饭」）
 */
export function parseNote(text, category = '') {
  const src = String(text || '');

  const byLabel = parseMerchant(src);
  if (byLabel && !isMeaninglessNote(byLabel)) return byLabel;

  const byLine = parseMerchantLine(src, category);
  if (byLine && !isMeaninglessNote(byLine)) return byLine;

  // 一句话：逐行试，取第一个有意义的短语
  for (const l of lines(src)) {
    const phrase = extractPhrase(l);
    if (phrase.length >= 2 && phrase.length <= 20
      && /[\u4e00-\u9fa5]/.test(phrase) && !isMeaninglessNote(phrase)) {
      return phrase;
    }
  }
  return '';
}

/**
 * 解析日期。
 * 支持 2026-09-15 / 2026/9/15 / 9月15日 / 09-15，缺年份时补当年。
 * 没有任何日期线索时返回今天。
 */
export function parseDate(text, today = new Date()) {
  const src = String(text || '');

  let m = src.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (m) return formatDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  m = src.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return formatDate(new Date(today.getFullYear(), Number(m[1]) - 1, Number(m[2])));

  m = src.match(/(?:^|\s)(\d{1,2})\s*[-/]\s*(\d{1,2})(?:\s|$)/);
  if (m) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return formatDate(new Date(today.getFullYear(), mm - 1, dd));
    }
  }
  return formatDate(today);
}

/** 根据商户名 / 全文猜分类 */
export function parseCategory(text, direction = 'expense') {
  const s = String(text || '');
  const rules = direction === 'income'
    ? [
      [/生活费|家用|家里打|爸妈|转账给我/, 'allowance'],
      [/兼职|家教|实习工资|工资|日结/, 'parttime'],
      [/奖学金|助学金|补助|补贴/, 'scholarship'],
    ]
    : [
      [/餐|饭|外卖|奶茶|咖啡|食堂|早点|早餐|午餐|晚餐|夜宵|烧烤|火锅|烤肉|小吃|面馆|米线|瑞幸|星巴克|麦当劳|肯德基|必胜客|汉堡|披萨/, 'meal'],
      [/地铁|公交|打车|出租|滴滴|车费|高铁|火车|机票|加油|共享单车|单车/, 'transport'],
      [/书|资料|打印|文具|课程|培训|考试|报名|学费|网课/, 'study'],
      [/纸巾|洗衣|日用|超市|百货|理发|洗护|快递|宿管|水费|电费/, 'daily'],
      [/电影|游戏|唱歌|ktv|会员|娱乐|门票|演出|健身/, 'entertain'],
      [/药|医院|挂号|体检|诊所|牙科/, 'medical'],
      [/房租|住宿|宿舍|公寓|水电|物业/, 'housing'],
    ];
  for (const [re, id] of rules) if (re.test(s)) return id;
  return direction === 'income' ? 'other_in' : 'other_ex';
}

/**
 * 主入口：把一段文本解析成一条记账草稿
 * @returns {{amount:number, direction:string, category:string, note:string, date:string, confidence:number}}
 *          confidence 0~1，用于 UI 提示用户核对
 */
export function parseReceipt(text, today = new Date()) {
  const src = String(text || '');
  const amount = parseAmount(src);
  const direction = parseDirection(src);
  const date = parseDate(src, today);
  // 先定分类（分类依赖商户名 + 全文），再据分类优选商户行，最后定备注
  const category = parseCategory(`${parseMerchant(src)}\n${src}`, direction);
  const note = parseNote(src, category);

  // 置信度：能拿到金额是基本盘，有备注/明确方向再加分
  let confidence = 0;
  if (amount > 0) confidence += 0.5;
  if (note) confidence += 0.25;
  if (DIRECTION_HINTS.some((w) => src.includes(w))) confidence += 0.15;
  if (/[¥￥]|\d\s*元/.test(src)) confidence += 0.1;

  return {
    amount,
    direction,
    category,
    note,
    date,
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
  };
}

export default {
  parseReceipt, parseAmount, parseDirection, parseMerchant, parseNote, parseDate, parseCategory,
};
