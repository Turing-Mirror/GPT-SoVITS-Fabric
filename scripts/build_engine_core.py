# -*- coding: utf-8 -*-
"""打引擎底模包（engine-core），挂 Release 标签 `GSV-engine-core`。

包名与内容和壳里的 `engine_assets.rs` 对齐：`BASE_MODEL_PACKS` 是包名，
`engine_core_files` 是装完后必须在的文件。每个 zip 的路径从 `GPT_SoVITS/`
底下算起，客户端解到 `<安装根>/GPT_SoVITS/`。

V5 底模不在这里：它是可选资源，按需下载（`--v5` 单独打 `base-v5.zip`）。

用法::

    python scripts/build_engine_core.py --pretrained <pretrained_models 目录> \\
        --g2pw <G2PWModel 目录> --out data/engine-core
    python scripts/build_engine_core.py ... --v5    # 另打 V5 包
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

#: 包名 → [(来源根, 来源内相对路径)]。来源根 "pm" = pretrained_models，"g2pw" = G2PWModel。
#: 包内路径 = pretrained_models/<相对路径> 或 text/G2PWModel/<相对路径>。
PACKS: dict[str, list[tuple[str, str]]] = {
    "base-hubert-bert.zip": [
        ("pm", "chinese-hubert-base/config.json"),
        ("pm", "chinese-hubert-base/preprocessor_config.json"),
        ("pm", "chinese-hubert-base/pytorch_model.bin"),
        ("pm", "chinese-roberta-wwm-ext-large/config.json"),
        ("pm", "chinese-roberta-wwm-ext-large/tokenizer.json"),
        ("pm", "chinese-roberta-wwm-ext-large/pytorch_model.bin"),
    ],
    "base-gpt-s1v3.zip": [("pm", "s1v3.ckpt")],
    "base-v2proplus.zip": [
        ("pm", "v2Pro/s2Gv2ProPlus.pth"),
        ("pm", "v2Pro/s2Dv2ProPlus.pth"),
        ("pm", "sv/pretrained_eres2netv2w24s4ep4.ckpt"),
    ],
    "base-g2pw.zip": [
        ("g2pw", "config.py"),
        ("g2pw", "g2pW.onnx"),
        ("g2pw", "POLYPHONIC_CHARS.txt"),
        ("g2pw", "MONOPHONIC_CHARS.txt"),
        ("g2pw", "bopomofo_to_pinyin_wo_tune_dict.json"),
        ("g2pw", "char_bopomofo_dict.json"),
    ],
    "base-langdetect.zip": [("pm", "fast_langdetect/lid.176.bin")],
}

V5_PACK = (
    "base-v5.zip",
    [
        ("pm", "gsv-v5-pretrained/s2Gv5dev.pth"),
        ("pm", "gsv-v5-pretrained/s2Gv5turbo.pth"),
        ("pm", "gsv-v5-pretrained/vocoder.pth"),
    ],
)

ARC_PREFIX = {"pm": "pretrained_models", "g2pw": "text/G2PWModel"}


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build(name: str, items: list[tuple[str, str]], roots: dict[str, Path], out: Path) -> dict:
    missing = [f"{roots[k] / rel}" for k, rel in items if not (roots[k] / rel).is_file()]
    if missing:
        raise SystemExit("[engine-core] 缺文件：\n  " + "\n  ".join(missing))
    path = out / name
    # 权重本身已是压缩过的二进制，再 deflate 只费时间不省空间。
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for k, rel in items:
            z.write(roots[k] / rel, f"{ARC_PREFIX[k]}/{rel}")
    digest = sha256_of(path)
    (out / f"{name}.sha256").write_text(f"{digest}  {name}\n", encoding="utf-8")
    size = path.stat().st_size
    print(f"[engine-core] {name}  {size / 1e6:.1f} MB  {digest}")
    return {"name": name, "size_bytes": size, "sha256": digest}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pretrained", required=True, help="上游的 GPT_SoVITS/pretrained_models 目录")
    ap.add_argument("--g2pw", required=True, help="上游的 GPT_SoVITS/text/G2PWModel 目录")
    ap.add_argument("--out", default=str(REPO / "data" / "engine-core"))
    ap.add_argument("--v5", action="store_true", help="另打 V5 底模包")
    args = ap.parse_args()

    roots = {"pm": Path(args.pretrained).resolve(), "g2pw": Path(args.g2pw).resolve()}
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    packs = dict(PACKS)
    if args.v5:
        packs[V5_PACK[0]] = V5_PACK[1]
    manifest = [build(name, items, roots, out) for name, items in packs.items()]
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[engine-core] 完成：{out}（sha256 回填到 engine_assets.rs 的 BASE_MODEL_PACKS）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
