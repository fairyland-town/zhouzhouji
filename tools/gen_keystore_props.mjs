// gen_keystore_props.mjs —— 生成正式版签名所需的随机密码与 android/keystore.properties
//
// 为什么要用脚本而不是手写：密码必须随机且足够长，手敲容易偷懒。
// 字母表**刻意排除** `\ : = # !` 与空格 —— 它们在 Java .properties 里是
// 转义符/分隔符/注释符，会让 Gradle 读出来跟实际不一样（经典坑）。
import { randomInt } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:/desktop/周历记';
const PROPS = join(ROOT, 'android', 'keystore.properties');

if (existsSync(PROPS)) {
  console.log('已存在 android/keystore.properties，未覆盖。');
  console.log('要重新生成请先手动删除它（注意：旧密钥库对应的应用将无法再更新）。');
  process.exit(0);
}

// 安全字符集：大小写字母 + 数字 + 少量安全符号
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~.';
const LEN = 32;
const pick = () => ALPHABET[randomInt(ALPHABET.length)];

// 保证四类字符都至少出现一次（有些策略会校验复杂度）
let chars;
do {
  chars = Array.from({ length: LEN }, pick);
} while (
  !/[A-Z]/.test(chars.join('')) ||
  !/[a-z]/.test(chars.join('')) ||
  !/[0-9]/.test(chars.join(''))
);

const password = chars.join('');

const content = `# 周周记 正式版签名配置（v1.12.0 起）
#
# 🔴 这个文件里的密码 + 同目录的 zhouzhouji-release.keystore 一起构成
#    应用的「身份证」。两个都丢了，就**永远无法再更新这个应用** ——
#    只能换个包名重新发布，老用户收不到任何更新。
#    请立刻把两者一起复制到别处保存（网盘 / U 盘 / 密码管理器）。
#
# 本文件不应进入任何版本库或分享给他人。

storeFile=zhouzhouji-release.keystore
storePassword=${password}
keyAlias=zhouzhouji
keyPassword=${password}
`;

writeFileSync(PROPS, content, 'utf8');
console.log('已写入 android/keystore.properties');
console.log('密码长度：' + password.length);
console.log('PASSWORD=' + password);
