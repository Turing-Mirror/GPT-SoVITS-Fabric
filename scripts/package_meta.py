# -*- coding: utf-8 -*-
"""安装包身份 —— `package_meta.json`。

薄包只有一种：**通用包**。变体（nvidia / cpu）不在安装包里定，
而是首启补全时按显卡挑，`provision::write_package_meta` 装完运行时才写。
所以这个脚本平时写的是一份 `variant: ""` 的通用身份 —— 壳侧
`read_package_meta_variant` 明确把空串读成「还没选」，不是一个叫 ""
的变体（provision.rs:298）。

RVC 那份同名脚本有四个变体（nvidia / amd / intel / cpu），因为官方 RVC
的 A 卡路径是**另一套环境**（torch-directml + onnxruntime-directml，
启动还要 `--dml`），必须在打包时就分开。GPT-SoVITS 上游没有 DirectML
路径，DECISIONS D3 也把变体收敛成 nvidia + cpu 两个，两者共用同一个薄包，
所以这里不做多包。

用法::

    python scripts/package_meta.py                 # 写通用包身份
    python scripts/package_meta.py --variant cpu   # 预置变体（内测直发用）
    python scripts/package_meta.py --print         # 只打印，不写
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
META_NAME = "package_meta.json"

#: 与 `catalog::normalize_variant` 一致：只认这两个，其余一律折到 cpu。
VARIANTS: dict[str, dict[str, Any]] = {
    "": {
        "variant": "",
        "label": "",
        "accel_default": "",
        "summary": "通用薄包：首启按显卡挑 Runtime 变体",
    },
    "nvidia": {
        "variant": "nvidia",
        "label": "NVIDIA CUDA",
        "accel_default": "cuda",
        "summary": "N 卡路径：CUDA 版 Runtime",
    },
    "cpu": {
        "variant": "cpu",
        "label": "CPU",
        "accel_default": "cpu",
        "summary": "CPU 路径：能跑合成，训练不可行（几百小时）",
    },
}


def shell_version() -> str:
    conf = json.loads(
        (REPO / "app" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )
    return str(conf.get("version", ""))


def build(variant: str) -> dict[str, Any]:
    if variant not in VARIANTS:
        raise SystemExit(
            f"未知变体 {variant!r}；只认 {sorted(k for k in VARIANTS if k)} 或留空"
        )
    meta = dict(VARIANTS[variant])
    meta["product"] = "GPT-SoVITS Fabric"
    meta["shell_version"] = shell_version()
    meta["installer"] = "tauri_nsis"
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(description="写 package_meta.json")
    ap.add_argument("--variant", default="", help="nvidia / cpu；留空 = 通用包")
    ap.add_argument("--out", help="写到哪（缺省：dist/package_meta.json）")
    ap.add_argument("--print", dest="only_print", action="store_true")
    args = ap.parse_args()

    meta = build(args.variant)
    text = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    if args.only_print:
        print(text, end="")
        return 0

    # **不写进负载**。这个文件是首启补全装完运行时之后由
    # `provision::write_package_meta` 生成的，不随安装包发 —— 随包发一份
    # 空 variant 的，只会多一个「装了但没写过」和「装了写了空」分不清的状态。
    # 这里落到 dist/，给「内测直发预置变体」这种手工场景用。
    out = Path(args.out) if args.out else REPO / "dist" / META_NAME
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"[meta] {out} ← variant={meta['variant'] or '(通用)'} v{meta['shell_version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
