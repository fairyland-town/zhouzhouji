# -*- coding: utf-8 -*-
"""
ocr_server.py —— 本机离线 OCR 服务（Windows 系统自带 OCR 引擎）

设计原则（符合项目「离线优先 / 不联网 / 不使用收费 API」）：
  - 使用 Windows.Media.Ocr 系统引擎，图片不离开本机
  - 只做「图片 -> 纯文本」，不做字段解析（解析交给前端 event_parser.js）
  - 零第三方依赖，仅用 Python 标准库 + Windows 运行时（WinRT）

启动：python tools/ocr_server.py
接口：
  GET  /health   健康检查
  POST /ocr      表单字段 image=<图片文件>，返回 {"text": "..."}
"""

import io
import json
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
HOST = "127.0.0.1"          # 仅监听本机，不对外暴露
MAX_BODY = 20 * 1024 * 1024  # 20MB 上传上限

# ---------------------------------------------------------------- WinRT 初始化

_ocr_engine = None
_winrt_error = None


def _init_winrt():
    """惰性初始化 Windows OCR 引擎"""
    global _ocr_engine, _winrt_error
    if _ocr_engine is not None:
        return _ocr_engine
    if _winrt_error is not None:
        raise RuntimeError(_winrt_error)

    try:
        # 必须先初始化 WinRT，否则异步接口会报错
        try:
            from winrt import _winrt  # type: ignore
            _winrt.init_apartment()
        except Exception:
            try:
                import ctypes
                ctypes.windll.combase.RoInitialize(1)  # RO_INIT_MULTITHREADED
            except Exception:
                pass

        from winrt.windows.media.ocr import OcrEngine          # type: ignore
        from winrt.windows.globalization import Language       # type: ignore

        engine = None
        # 优先中文，其次跟随系统
        for tag in ("zh-Hans-CN", "zh-Hans", "zh-CN", "zh"):
            try:
                lang = Language(tag)
                if OcrEngine.is_language_supported(lang):
                    engine = OcrEngine.try_create_from_language(lang)
                    if engine:
                        break
            except Exception:
                continue
        if engine is None:
            engine = OcrEngine.try_create_from_user_profile_languages()
        if engine is None:
            raise RuntimeError(
                "系统未安装可用的 OCR 语言包。请在「设置 → 时间和语言 → 语言」中"
                "为中文添加「光学字符识别」可选功能。"
            )
        _ocr_engine = engine
        return engine
    except ImportError as e:
        _winrt_error = (
            "缺少 winrt 运行库，请先执行：pip install winrt-runtime "
            "winrt-Windows.Media.Ocr winrt-Windows.Globalization "
            "winrt-Windows.Graphics.Imaging winrt-Windows.Storage.Streams"
        )
        raise RuntimeError(_winrt_error) from e


def _clean_ocr_line(line: str) -> str:
    """规整单行 OCR 文本（Windows OCR 对中文会逐字插入空格）"""
    import re
    s = line

    # 中文之间的空格去掉
    s = re.sub(r"(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])", "", s)
    # 中文与数字/字母之间的空格去掉（「201 报告厅」->「201报告厅」）
    s = re.sub(r"(?<=[\u4e00-\u9fa5])\s+(?=[A-Za-z0-9])", "", s)
    s = re.sub(r"(?<=[A-Za-z0-9])\s+(?=[\u4e00-\u9fa5])", "", s)
    # 英文/数字之间保留单个空格
    s = re.sub(r"[ \t]{2,}", " ", s)

    # 全文冒号统一为半角，便于正则匹配
    s = s.replace("：", ":")

    # OCR 常把字段后的分隔符识别成句点/全角句点/间隔号（「时间 ． 2026年…」）
    # 注意 Windows OCR 输出的间隔号可能带空格，故先剥离标签与内容间的杂符
    s = re.sub(
        r"^((?:活动|报告|会议|讲座|宣讲|举办|召开)?"
        r"(?:时间|地点|题目|主题|名称|单位|内容|主讲人|报告人|主持人|主办|承办))"
        r"\s*[.。·、,，:﹒．·]\s*",
        r"\1:", s,
    )

    # OCR 有时完全丢失字段分隔符（「报告题目图论中的…」「地点数学学院201报告厅」），
    # 在明确的字段标签后补插冒号
    s = re.sub(
        r"^((?:活动|报告|会议|讲座|宣讲|举办|召开)?"
        r"(?:时间|地点|题目|主题|名称|单位|内容|主讲人|报告人|主持人|主办|承办))"
        r"(?=[\u4e00-\u9fa5A-Za-z0-9])",
        r"\1:", s,
    )

    # 兜底：标签后残留的孤立间隔符统一去成冒号
    s = re.sub(r"^(时间|地点|题目|主题|名称|单位|内容)\s+[·．﹒]\s+", r"\1:", s)
    return s.strip()


def _clean_ocr_text(raw: str) -> str:
    """按行清洗，保留 OCR 的换行结构（换行是字段边界的重要线索）"""
    lines = [_clean_ocr_line(ln) for ln in raw.split("\n")]
    return "\n".join(ln for ln in lines if ln).strip()


async def _run_ocr(image_bytes: bytes) -> str:
    """在 WinRT 异步管线里执行 OCR"""
    from winrt.windows.storage.streams import (          # type: ignore
        DataWriter, InMemoryRandomAccessStream,
    )
    from winrt.windows.graphics.imaging import BitmapDecoder   # type: ignore

    engine = _init_winrt()

    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(image_bytes)
    await writer.store_async()
    await writer.flush_async()
    stream.seek(0)

    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()

    result = await engine.recognize_async(bitmap)

    lines = []
    for line in result.lines:
        lines.append(line.text)
    return _clean_ocr_text("\n".join(lines))


def recognize(image_bytes: bytes) -> str:
    """同步入口：驱动 WinRT 异步任务"""
    import asyncio

    async def _main():
        return await _run_ocr(image_bytes)

    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(_main())
    finally:
        try:
            loop.close()
        except Exception:
            pass


# ---------------------------------------------------------------- HTTP 处理

class Handler(BaseHTTPRequestHandler):
    server_version = "CampusWeekOCR/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("/health", ""):
            try:
                engine = _init_winrt()
                self._json({
                    "ok": True,
                    "engine": "Windows.Media.Ocr",
                    "language": str(getattr(engine, "recognizer_language", "") or ""),
                    "offline": True,
                })
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 503)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/ocr":
            self._json({"error": "not found"}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                self._json({"error": "请求体为空"}, 400)
                return
            if length > MAX_BODY:
                self._json({"error": "图片过大（上限 20MB）"}, 413)
                return

            body = self.rfile.read(length)
            image_bytes = _extract_image(body, self.headers.get("Content-Type", ""))
            if not image_bytes:
                self._json({"error": "未找到图片数据"}, 400)
                return

            text = recognize(image_bytes)
            self._json({"text": text, "chars": len(text)})
        except Exception as e:
            traceback.print_exc()
            self._json({"error": f"识别失败：{e}"}, 500)

    def log_message(self, fmt, *args):
        sys.stderr.write("[OCR] " + (fmt % args) + "\n")


def _extract_image(body: bytes, content_type: str):
    """从 multipart/form-data 或原始字节中取出图片"""
    if "multipart/form-data" not in content_type:
        return body  # 直接把整个请求体当图片

    marker = b"boundary="
    idx = content_type.find(marker)
    if idx == -1:
        return None
    boundary = content_type[idx + len(marker):].strip().strip('"')
    delim = b"--" + boundary.encode()

    for part in body.split(delim):
        if b"\r\n\r\n" not in part:
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        if b'name="image"' not in head and b"filename=" not in head:
            continue
        return data.rstrip(b"\r\n-")
    return None


def main():
    print("=" * 56)
    print("  周周记 · 本机离线 OCR 服务")
    print("  引擎：Windows.Media.Ocr（系统自带，不联网）")
    print(f"  地址：http://{HOST}:{PORT}")
    print("  按 Ctrl+C 停止")
    print("=" * 56)
    try:
        engine = _init_winrt()
        lang = getattr(engine, "recognizer_language", None)
        print(f"  [OK] OCR 引擎已就绪，识别语言：{lang}")
    except Exception as e:
        print(f"  [!!] OCR 引擎初始化失败：{e}")
        print("       服务仍会启动，但 /ocr 会返回错误。")
    print()

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
