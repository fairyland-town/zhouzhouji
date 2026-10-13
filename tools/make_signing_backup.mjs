// make_signing_backup.mjs —— 把签名密钥 + 密码打包到项目**外面**的一个备份目录
//
// 为什么放在项目外面（D:\desktop\周周记-签名密钥备份）：
//   项目目录将来可能被打包/分享/上传，密钥和密码留在里面就会跟着泄漏。
//   放在旁边一层，既能一眼看见、又不会跟着项目走。
//
// 为什么必须带上密码：备份的意义就是「自包含」。只给 .keystore 不给密码，
//   等于没有备份 —— 密钥库没有密码就是一堆打不开的字节。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = 'D:/desktop/周历记';
const SRC_KEYSTORE = join(PROJECT, 'android', 'zhouzhouji-release.keystore');
const PROPS = join(PROJECT, 'android', 'keystore.properties');
const OUT_DIR = 'D:/desktop/周周记-签名密钥备份';

if (!existsSync(SRC_KEYSTORE)) {
  console.error('找不到密钥库：' + SRC_KEYSTORE);
  process.exit(1);
}
if (!existsSync(PROPS)) {
  console.error('找不到 keystore.properties：' + PROPS);
  process.exit(1);
}

// 从 properties 里取密码（不依赖 shell 转义）
const props = {};
for (const line of readFileSync(PROPS, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
  if (m) props[m[1]] = m[2];
}
if (!props.storePassword) {
  console.error('keystore.properties 里没有 storePassword');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(SRC_KEYSTORE, join(OUT_DIR, 'zhouzhouji-release.keystore'));

const txt = `周周记 —— 正式版签名密钥（务必备份）

════════════════════════════════════════════════════════════
 这个目录里是「周周记」这个应用的身份证。
 丢了它，你就永远无法再给已安装的用户推送更新。
════════════════════════════════════════════════════════════

【为什么要备份】
  Android 靠**签名证书指纹**来识别「这是不是同一个应用」。
  同一个包名（com.zhouzhouji.app）如果换了签名，系统会拒绝覆盖安装，
  只能先卸载 —— 而卸载会清空应用的全部数据。
  换句话说：密钥丢了 = 这个应用从此不能更新，只能换个包名重新开始。

【目录内容】
  · zhouzhouji-release.keystore   —— 密钥库文件（4 KB，必须备份）
  · 密钥信息-必读.txt              —— 本文件（含密码，必须备份）

【密码与指纹】
  密钥库密码：${props.storePassword}
  密钥别名  ：${props.keyAlias}
  别名密码  ：${props.keyPassword}（与密钥库密码相同）

  证书指纹 SHA-1  ：FE:C0:B0:EC:E4:6C:C1:4D:E3:18:11:E6:E9:E9:9F:E2:A8:DA:E8:A1
  证书指纹 SHA-256：A1:0D:B8:D9:4C:97:04:CB:24:58:9E:CF:7E:86:24:9A:6A:B8:6B:A4:CB:AD:73:29:D5:90:CA:94:8F:FA:8A:A6

  密钥算法：4096 位 RSA / SHA384withRSA / PKCS12
  有效期至：2054-02-02

【现在就该做的事】
  1. 把**整个目录**复制到你信得过的地方（网盘 / U 盘 / 密码管理器）。
  2. 确认副本能打开、密码能对上。
  3. 项目里的 android/keystore.properties 和 android/zhouzhouji-release.keystore
     是「工作副本」，将来可能被误删或随项目一起被分享 ——
     备份以本目录为准。

【怎么验证备份是好的】
  在任意装了 JDK 的机器上执行（把 <密码> 换成上面的密钥库密码）：

    keytool -list -v -keystore zhouzhouji-release.keystore -storepass <密码>

  能打印出 SHA-256 指纹并且和上面一致，就说明备份可用。

【生成时间】
  ${new Date().toLocaleString('zh-CN')}
`;

writeFileSync(join(OUT_DIR, '密钥信息-必读.txt'), txt, 'utf8');

console.log('备份目录已就绪：' + OUT_DIR);
console.log('  · zhouzhouji-release.keystore');
console.log('  · 密钥信息-必读.txt（含密码与指纹）');
