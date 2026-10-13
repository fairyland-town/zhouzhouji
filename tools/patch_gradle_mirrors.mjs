#!/usr/bin/env node
/**
 * 给 Capacitor 生成的 Gradle 工程重新打上「仓库镜像」补丁。
 *
 * 为什么需要这个脚本
 * ------------------
 * Capacitor 模板里用的是 `google()`，它会解析到 **maven.google.com**，
 * 该域名在本机网络下不可达（超时）。实测 `https://dl.google.com/dl/android/maven2`
 * 是同一份内容的直连地址、可正常访问，所以替换成它 + 阿里云镜像兜底。
 *
 * 但 `npx cap sync android`（以及 `npx cap add android`）会**重新生成**
 * `android/capacitor-cordova-android-plugins/build.gradle`，把补丁冲掉。
 * 因此每次 sync 之后都要重打一次 —— 本脚本已挂进 `npm run android:sync`。
 *
 * 用法
 * ----
 *   node tools/patch_gradle_mirrors.mjs
 *
 * 幂等：已经没有裸 `google()` 时什么都不做。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 需要打补丁的 gradle 文件（相对项目根） */
const TARGETS = [
  'android/build.gradle',
  'android/capacitor-cordova-android-plugins/build.gradle',
];

/**
 * 用来取代 `google()` 的仓库列表。
 * 第一条是 google 官方 maven 的直连地址（与 maven.google.com 同内容），
 * 后两条是阿里云镜像兜底。
 */
const MIRRORS = [
  "maven { url 'https://dl.google.com/dl/android/maven2' }",
  "maven { url 'https://maven.aliyun.com/repository/google' }",
  "maven { url 'https://maven.aliyun.com/repository/public' }",
];

let total = 0;
let touched = 0;

for (const rel of TARGETS) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    console.log(`跳过（文件不存在）：${rel}`);
    continue;
  }

  const src = readFileSync(file, 'utf8');
  let hits = 0;

  // 逐行替换，保留原有的缩进 —— 直接字符串替换会把 buildscript 与
  // repositories 两处的缩进弄混。
  const out = src
    .split('\n')
    .map((line) => {
      const m = /^(\s*)google\(\)\s*$/.exec(line);
      if (!m) return line;
      hits += 1;
      return MIRRORS.map((mirror) => m[1] + mirror).join('\n');
    })
    .join('\n');

  if (hits === 0) {
    console.log(`已是最新：${rel}`);
    continue;
  }

  writeFileSync(file, out, 'utf8');
  console.log(`已打补丁：${rel} —— 替换 ${hits} 处 google()`);
  total += hits;
  touched += 1;
}

console.log('');
if (total === 0) {
  console.log('无需改动：所有 Gradle 文件都已是镜像配置。');
} else {
  console.log(`完成：${touched} 个文件、共 ${total} 处。`);
}
