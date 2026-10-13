# 周周记 —— 项目记忆（索引）

> **本文只留「一句话骨架」与「去哪找」。**
> - 51 条红线的**完整一行要点** → `topics/红线速查.md`（**开工前必读**）
> - 每条红线的**展开原文**（为什么、踩过什么、实测数字）→ `topics/红线全文.md`，按编号搜
> - 版本变更史 → `YYYY-MM-DD.md` 与 `README.md`
>
> ⚠️ `MEMORY.md` 有**注入上限**（实测约 8000 字符）。超了尾部会被**整段截断** ——
> 被截掉的红线等于不存在。所以这里只放骨架；**加红线时先压短已有的，别再堆长句**。

| 要改的东西 | 先读 |
|---|---|
| 🔴 **51 条红线一行要点（完整版）** | `topics/红线速查.md` |
| 数据存储 / 库名 / 版本号同步 | `topics/数据与命名.md` |
| 分类判定 / 解析器 / 正则 / 金额 | `topics/解析器.md` |
| 路由 / 导航 / 记录页四子视图 / 滑动翻页 / 侧滑返回 / 「记一笔」浮层 / 趋势曲线 / 流水一天一组 | `topics/路由与记录页.md` |
| 账户余额 / 对账 / 月扣款 / 记账镜像 / 挂账 / 充值转账 / 转账不算收入 / 净资产·借入借出·报销·黄金 | `topics/账户与对账.md` |
| 备份导出导入 / 安卓 APK / Capacitor / 覆盖安装与重装找回 | `topics/备份与安卓.md` |
| CSS 布局 / flex 链 / 液态玻璃 / 图标 / 视觉层级·行高 | `topics/布局与纪律.md`、`topics/视觉与图标.md` |
| 发布 PWA / 缓存 / 出包 | `topics/发布与PWA.md` |
| 测试脚本 / E2E / 调试手段 / 回归脚本假阳性 | `topics/测试与调试.md` |
| 常用命令完整版（脚本名对照、超时、JAVA_HOME） | `topics/常用命令.md` |

## 🔴 红线骨架（1–51；完整要点 → `topics/红线速查.md`）

1. 零依赖零构建；正则集中 `regex_patterns.js`，禁止写死。
2. 数据全本地零上传；IndexedDB 按 origin 隔离。
3. 库名 `campus_week_calendar` / sw 前缀 `campus-week-` **永不改名**（改名丢数据）。
4. 改 `web/` 后必须升 `package.json` version + `npm run pwa`。
5. 改布局后必须跑 E2E 第 12 组。
6. 文件被对方删除/重组 → 停手报告，不要重建、不要争同一文件。
7. 测试期望值改到第三次不收敛 → 先怀疑模型，写真值表钉死期望。
8. 写 CSS 前核对 `:root` 令牌名（写错只静默失效）。
9. 加原生插件后看 APK 体积（四种 CPU 架构 `.so`）；已限 ARM 两套 → 装不进 x86 模拟器。
10. 通知图标只取 alpha 且放 `drawable-*`；apple-touch-icon 满幅不透明。跑 `verify:icons`。
11. 签名密钥 + 密码丢了 = 永远无法更新；备份在项目外 `D:\desktop\周周记-签名密钥备份\`。
12. 清 `kv` 表用 `DatabaseService.removeSetting(key)`（`_remove()` 把键转 `Number` → `NaN`）。
13. 关浮层 dismiss 必须走各自取消路径，绝不能 `overlay.remove()`（Promise 永不 resolve）。
14. `touch-action` 不继承；只有 touch 事件能 `preventDefault()`。
15. `scroll-behavior: smooth` 下不能 `sleep(固定值)` 再断言滚动位置。
16. 更新不需要卸载（包名 + 签名 + `versionCode` 递增）；只有 debug → release 那次要卸。
17. 卸载删不掉「文档」目录的自动备份；判空用 `DatabaseService.isEmpty()`。
18. UI 文案默认不解释词义；层级靠字号与留白。
19. 版本号只在 `package.json` 写一次，其余由 `npm run pwa` 生成；`verify:pwa` 钉住。
20. 调小两行小字卡片：先看行高（钉 `line-height: 1.25`）再看 padding。
21. 删 UI 元素前 grep 它的 onclick 函数还有没有别的调用点（幽灵数字）。
22. console 错误来源看 `m.location().url`，不要只看 `m.text()`。
23. 算元素在滚动容器里的位置不能用 `offsetTop`。
24. 「默认可见 → 默认隐藏」前先 grep 谁依赖它可见；区分走 UI 创建与直接调 API 播种。
25. `promptDialog` 返回三态（`null` / `''` / 内容）；必填用 `required: true`；数值留空 = 0。
26. 手输日期统一走 `parseDateInput()` + `PATTERNS.DATE_INPUT`；**必须回读校验**（`2026-02-31` 会被静默滚到 3/3）。
27. `toast()` 不许渲染成空 / `undefined` / `[object Object]`；拒绝值不能直接 `String()`。
28. 异步 onclick 抛错必须有人兜；`main.js` 有两个全局兜底，`error` 要过滤资源加载失败。
29. 测全局兜底处理器要用同源内联脚本抛错，不能用 `page.evaluate`（会脱敏 → 假阴性）。
30. 产品方向：功能齐全 > 新手友好；但「说明页」要写清楚。
31. 自定义键盘 `inputmode="none"`，但别把 `<input>` 换成 `div`；按键不能触发整页 `render()`。
32. 「让表单底部可见」不要靠底部 spacer；按 `getBoundingClientRect` 算 `topInRoot`。
33. 加字段后检查 `normalizeXxx()` 白名单（会静默丢）；补 `fromRecord(toRecord())` 往返断言。
34. `LedgerEntry.account_id` = 「从账户页镜像来」；两套字段不对称；删除顺序先撤挂账再删记账。
35. `LedgerEntry.direction` 只认 `'expense'` / `'income'`；`Loan` 那套才是 `'in'` / `'out'`。
36. `money()` 与 `amountShort()` / `signedAmount()` 别混用；短格式有损；符号来自第二个参数。
37. 「记一笔」是 fixed 浮层；`pushOverlay()` 登记、dismiss 走 `cancelForm()`；`openForm` 用 `formSeq` 抢跑。
38. 两道保险的地方要各补「只经过其中一道」的用例；改坏 → 变红 → 改回。
39. 高度尺子用 `dvh` 不用 `vh`；headless 里两者相等 → 渲染断言假绿，只能读 CSS 源码。
40. 曲线贝塞尔控制点必须夹到绘图带内；负向验证种子数据要够极端。
41. `scroll-behavior: smooth` 容器里不要用坐标点击，用 `page.evaluate(() => el.click())`。
42. 升级后手机要刷新两次才看到新版；别把用户引到「升级失败了」。
43. 流水「一天一组」；只有一边有就只报一边；回归断言取数组元素一律用 `?.`。
44. 账户间转账不计入收入；判据 `linkedAccountId`；概览合计用 `totalInExternal`；`dailyBurn()` 同口径。
45. 备份导入重发账户 id → `checkin_logs.checkin_id` / `ledger.accountId` / `accounts.entries[].linkedAccountId` 都要重映射；找不到对方保持原样。
46. 底部 dock 真实占位 94px（含浮起的「＋」）；滚动容器 `padding-bottom` >= `nav-h + 46px`。
47. 「定宽 + 数字」会换行：日期一律 `nowrap` + 不定宽；只按本机字体量行数会假绿。
48. `.sheet` 必须限高 + 只有 `.sheet__list` 滚动；别截断列表却把标题写成「共 N 笔」。
49. 写死日期的 E2E 会「馊」：记账页默认只看本月，播种日期要跟着当前月算。
50. `smooth` 容器「滚到底再量坐标」要轮询 `scrollTop` 稳定；固定 sleep 连着跑会假红。
51. 解析子进程输出先剥 ANSI（`\x1b[0m` 自带数字）；退出码与 grep 都不可信，只认总结行。

## 常用命令（完整版 → `topics/常用命令.md`）

- 服务 `npm run serve`（8080）；测试 `node tests/run_all.mjs`（11 套件）
- 回归 **`npm run verify:all`**（全量 + 真总表，推荐）；单跑 `npm run verify:{week,glass,nav,backup,icons,assets,gestures,pwa,skip,ledgerform,ledgerlist,ledgeracct,transfer,acctdetail}`
- 出包 `npm run pwa` → `npm run android:sync` → `npm run android:apk[:release]`
- 图标 `npm run icons` + **`verify:icons`**；语法自查 `node --check <文件>`

⚠️ 别按 npm 脚本名猜文件名（`verify:nav` → `verify_nav_icon.mjs`…猜错会**静默跳过**）；
`verify:*` 都要先起着 8080；`JAVA_HOME` 必须用**反斜杠**形式。
