# -*- coding: utf-8 -*-
"""
test_ocr_clean.py —— OCR 文本清洗的回归测试

Windows OCR 对中文的原始输出有明显的格式特征（逐字插空格、
丢失/错判全角冒号），清洗函数必须把它们还原成解析器可读的文本。
本测试直接把「典型 OCR 原始输出」喂给清洗函数，校验结果，
从而在不需要图片和 OCR 引擎的情况下保护这段逻辑。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))

from ocr_server import _clean_ocr_line, _clean_ocr_text  # noqa: E402

CASES = [
    # (OCR 原始输出, 期望清洗结果)
    ("时 间 ． 2026年9月18日下午3点", "时间:2026年9月18日下午3点"),
    ("时间：2026年9月18日下午3点", "时间:2026年9月18日下午3点"),
    ("报 告 题 目 图 论 中 的 均 衡 染 色 问 题", "报告题目:图论中的均衡染色问题"),
    ("地点数学学院201报告厅", "地点:数学学院201报告厅"),
    ("地 点 数 学 学 院 201 报 告 厅", "地点:数学学院201报告厅"),
    ("报告题目：组合数学中的若干问题", "报告题目:组合数学中的若干问题"),
    ("会议名称 ． 学院教学工作研讨会", "会议名称:学院教学工作研讨会"),
    ("主讲人：张伟教授", "主讲人:张伟教授"),
    ("欢迎广大师生参加", "欢迎广大师生参加"),
    ("2026 年 9 月 18 日 15:00", "2026年9月18日15:00"),
    ("信息楼 A201", "信息楼A201"),
]

# 多行结构必须保留（换行是字段边界的关键线索）
MULTILINE = (
    "报 告 题 目 图 论 中 的 均 衡 染 色 问 题\n"
    "时 间 ． 2026年9月18日下午3点\n"
    "地 点 数 学 学 院 201 报 告 厅",
    "报告题目:图论中的均衡染色问题\n时间:2026年9月18日下午3点\n地点:数学学院201报告厅",
)

passed = 0
failed = 0
failures = []

print("=" * 60)
print("OCR 文本清洗回归测试")
print("=" * 60)

for raw, expect in CASES:
    got = _clean_ocr_line(raw)
    if got == expect:
        passed += 1
        print(f"  [OK]   {raw!r} -> {got!r}")
    else:
        failed += 1
        failures.append((raw, expect, got))
        print(f"  [FAIL] {raw!r}")
        print(f"         期望 {expect!r}")
        print(f"         实际 {got!r}")

raw, expect = MULTILINE
got = _clean_ocr_text(raw)
if got == expect:
    passed += 1
    print("  [OK]   多行结构保留")
else:
    failed += 1
    failures.append((raw, expect, got))
    print("  [FAIL] 多行结构保留")
    print(f"         期望 {expect!r}")
    print(f"         实际 {got!r}")

print("-" * 60)
if failed == 0:
    print(f"全部通过：{passed} 项测试")
else:
    print(f"失败 {failed} 项 / 共 {passed + failed} 项")

sys.exit(0 if failed == 0 else 1)
