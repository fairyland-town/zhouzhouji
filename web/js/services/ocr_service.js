/**
 * ocr_service.js —— OCR 独立封装（03 文档第 12 节）
 *
 * 设计约束：
 *   - OCR 只做「图片 -> 纯文本」，不接触数据库、不做字段解析
 *   - 离线优先：不联网、不上传图片、不调用任何收费 API
 *
 * 两条实现路径（按运行环境自动选择）：
 *   · 安卓壳内  —— 设备端 ML Kit 中文识别（@capacitor-mlkit/text-recognition）
 *                  图片写进应用缓存目录 -> 交给系统识别 -> 用完即删。
 *                  全程不出手机，也不需要网络。
 *   · 桌面浏览器 —— 本机 Windows 系统自带 OCR 引擎（tools/ocr_server.py 桥接）
 *
 * 🔴 为什么手机端不能用「本机 OCR 服务」那条路：
 *   原生壳的 `androidScheme` 是 `https`，去请求 `http://127.0.0.1:8765` 会被
 *   WebView 当**混合内容**直接拦掉；何况手机上也根本没有那台 Windows 服务。
 *   所以手机端必须走原生插件，不能靠改端口解决。
 *
 * 流程：图片 -> OCR -> 文本 -> EventParser -> ConfirmScreen -> 保存
 */

import { isNative, callNative, DIR } from './native_bridge.js';

const DEFAULT_ENDPOINTS = [
  'http://127.0.0.1:8765/ocr',
];

/** 图片 MIME -> 临时文件扩展名。扩展名只影响可读性，识别靠内容嗅探 */
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** 临时文件统一前缀，方便识别与排查 */
const TMP_PREFIX = 'zzj-ocr-';

/** 同一次会话内的序号，避免同一毫秒内多张图撞名 */
let seq = 0;

/** File -> 不带 dataURL 前缀的纯 base64 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export class OCRService {
  constructor() {
    this.endpoints = [...DEFAULT_ENDPOINTS];
    this.available = null;   // null=未探测；'native'=设备端；否则是本地服务 URL
  }

  /** 当前是否走设备端识别 */
  get nativeMode() {
    return isNative();
  }

  /** 探测识别能力是否可用 */
  async check() {
    // 安卓壳：能力随 APK 内置，无需探测
    if (isNative()) {
      this.available = 'native';
      return true;
    }

    for (const url of this.endpoints) {
      try {
        const res = await fetch(url.replace('/ocr', '/health'), {
          method: 'GET',
          signal: AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
        });
        if (res.ok) {
          this.available = url;
          return true;
        }
      } catch { /* 继续尝试下一个 */ }
    }
    this.available = null;
    return false;
  }

  /**
   * 识别图片
   * @param {File|Blob} file
   * @returns {Promise<string>} 纯文本
   */
  async recognize(file) {
    if (!file) throw new Error('没有可识别的图片');

    // 安卓壳：设备端识别
    if (isNative()) {
      return this._recognizeViaDevice(file);
    }

    // 桌面：优先使用本地离线服务
    const url = this.available || (await this.check() ? this.available : null);
    if (url) {
      return this._recognizeViaLocal(url, file);
    }

    // 降级：提示用户改用系统/微信的「提取文字」
    throw new Error('未检测到本机 OCR 服务');
  }

  /**
   * 设备端识别（安卓壳）。
   *
   * 为什么绕一圈写文件：ML Kit 插件的 `processImage` 只收**文件路径**，
   * 而 WebView 里的 `<input type="file">` 给到的是一个没有真实路径的 Blob。
   * 所以先把图写进应用缓存目录拿到 `file://` 路径，识别完立刻删掉。
   */
  async _recognizeViaDevice(file) {
    const base64 = await fileToBase64(file);
    const ext = EXT_BY_TYPE[String(file.type || '').toLowerCase()] || 'png';
    const name = `${TMP_PREFIX}${Date.now().toString(36)}-${(seq++).toString(36)}.${ext}`;

    let written = false;
    try {
      const saved = await callNative('Filesystem', 'writeFile', {
        path: name,
        data: base64,
        directory: DIR.CACHE,
      });
      const uri = saved && saved.uri;
      if (!uri) throw new Error('无法把图片写入临时目录');
      written = true;

      const res = await callNative('TextRecognition', 'processImage', {
        path: uri,
        script: 'CHINESE',   // 校园通知以简体中文为主，中文模型同时能认拉丁字母与数字
      });
      if (!res) throw new Error('设备端识别能力不可用');
      return typeof res.text === 'string' ? res.text : '';
    } catch (err) {
      // 原生插件的原始报错形如 `[TextRecognition.processImage] image could not be loaded.`
      // —— 英文、带方法名，直接给用户看毫无意义。这里换成中文原因，细节留在控制台。
      console.warn('[ocr_service] 设备端识别失败：', err && err.message);
      throw new Error(this._explainNativeError(err && err.message));
    } finally {
      // 临时图必须删掉：既避免缓存堆积，也不让通知截图留在磁盘上
      if (written) {
        callNative('Filesystem', 'deleteFile', { path: name, directory: DIR.CACHE })
          .catch(() => { /* 删不掉不影响识别结果，交给系统回收缓存 */ });
      }
    }
  }

  /** 把插件的英文报错翻译成用户能看懂的原因 */
  _explainNativeError(raw) {
    const s = String(raw || '');
    if (/could not be loaded|decode|bitmap/i.test(s)) return '这张图片读不出来，可能格式不支持';
    if (/permission|denied/i.test(s)) return '没有读取图片的权限';
    if (/no space|ENOSPC/i.test(s)) return '手机存储空间不足';
    if (/canceled/i.test(s)) return '识别被中断了';
    if (/not implemented|not available/i.test(s)) return '这台设备不支持设备端识别';
    return '设备端识别出错';
  }

  async _recognizeViaLocal(url, file) {
    const form = new FormData();
    form.append('image', file, file.name || 'screenshot.png');

    let res;
    try {
      res = await fetch(url, { method: 'POST', body: form });
    } catch (e) {
      throw new Error('无法连接本机 OCR 服务');
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`OCR 服务返回错误 ${res.status}${txt ? '：' + txt.slice(0, 80) : ''}`);
    }
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('OCR 服务返回内容无法解析');
    if (data.error) throw new Error(data.error);
    return typeof data.text === 'string' ? data.text : (data.result || '');
  }

  /** 设置页标题：当前用的是哪套识别 */
  get engineTitle() {
    if (isNative()) return '设备端识别已就绪';
    return this.available ? '本机离线 OCR 已就绪' : '本机离线 OCR 未启动';
  }

  /** 供 UI 显示的能力说明 */
  get supportHint() {
    if (isNative()) {
      return '使用应用内置的离线识别引擎，图片不离开手机、不需要联网';
    }
    return this.available
      ? '已连接本机离线 OCR 服务'
      : '未连接 OCR 服务。可先运行 tools/启动OCR服务.bat，或使用微信/系统相册的「提取文字」功能后改用「粘贴文字」。';
  }

  /** 识别失败时给用户的下一步建议 */
  get failureHint() {
    if (isNative()) {
      return '请换一张更清晰的截图重试，或直接使用「粘贴文字」。';
    }
    return '请先双击运行 tools/启动OCR服务.bat，或改用「粘贴文字」。';
  }
}

export const ocrService = new OCRService();
