# -*- coding: utf-8 -*-
"""把一个角色目录打成可上架的 `<id>_voice.zip`。

包格式是 DECISIONS D4，落地实现是 `characters::install_zip`：

    <id>_voice.zip
    ├─ config.json        id/name/author/author_url/date/cover/version
    │                     lists: [{file, lang, note}]
    │                     params: {top_k,top_p,temperature,repetition_penalty,speed}
    ├─ cover.jpg
    ├─ models/{sovits.pth, gpt.ckpt}
    └─ dataset/{<id>.list, audios/*.wav}

打包时就把导入侧的三条硬校验先过一遍 —— 上架之后才发现缺一份权重，
用户那边表现为「装上了但一点合成就报错」，比打包失败难查得多：

* 两份权重缺一不可（`models/sovits.pth` + `models/gpt.ckpt`）
* 单条目 ≤ 512 MB，整包 ≤ 4 GB（导入侧的上限，超了会被拒收）
* 包内路径一律相对包根，不许绝对路径 / `..` / 盘符

**不带一层顶层目录。** Windows 右键「压缩」会多包一层，导入侧为此专门写了
剥壳逻辑；我们自己打的包没有理由去踩那条兜底。

用法::

    python scripts/pack_role_pack.py --dir ./roles/tomori --out dist/
    python scripts/pack_role_pack.py --dir ./roles/tomori --id tomori --check
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

MAX_ENTRY_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
REQUIRED = ["config.json", "models/sovits.pth", "models/gpt.ckpt"]
#: 参考音频的语种码，和 `TTS_Config.v2_languages` 对齐（去掉 auto*）。
LANGS = {"zh", "en", "ja", "ko", "yue", "all_zh", "all_ja", "all_yue", "all_ko"}
#: 上游认得的版本，取自随包版本表（prepare_engine_payload.py 生成）。
VERSION_TABLE = (Path(__file__).resolve().parent.parent / "app" / "src-tauri"
                 / "engine-payload" / "configs" / "upstream_versions.json")
KNOWN_VERSIONS = set(json.loads(VERSION_TABLE.read_text(encoding="utf-8"))["versions"])

SKIP_NAMES = {"__pycache__", ".DS_Store", ".git", "Thumbs.db"}


def collect(root: Path) -> list[Path]:
    out = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if any(part in SKIP_NAMES for part in p.relative_to(root).parts):
            continue
        out.append(p)
    return out


def check(root: Path, files: list[Path]) -> list[str]:
    problems: list[str] = []
    rels = {p.relative_to(root).as_posix() for p in files}

    for need in REQUIRED:
        if need not in rels:
            problems.append(f"缺 {need} —— 导入侧会整包拒收")

    total = 0
    for p in files:
        n = p.stat().st_size
        total += n
        if n > MAX_ENTRY_BYTES:
            rel = p.relative_to(root).as_posix()
            problems.append(
                f"{rel} 单个 {n / 1024**2:.0f} MB，超过导入上限 512 MB"
            )
    if total > MAX_TOTAL_BYTES:
        problems.append(f"整包 {total / 1024**3:.1f} GB，超过导入上限 4 GB")

    cfg_path = root / "config.json"
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            problems.append(f"config.json 不是合法 JSON：{e}")
            return problems
        if not str(cfg.get("name", "")).strip():
            problems.append("config.json 缺 name —— 导入侧以此判定整包无效")
        ver = str(cfg.get("version", "")).strip()
        if ver and ver not in KNOWN_VERSIONS:
            problems.append(
                f"[警告] version={ver} 不在上游版本表里（{sorted(KNOWN_VERSIONS)}）"
            )
        # lists 里点名的标注文件必须真的在包里，否则合成台挑参考音频时是空的。
        for i, item in enumerate(cfg.get("lists") or []):
            f = str(item.get("file", "")).strip()
            if not f:
                problems.append(f"config.json lists[{i}] 缺 file")
            elif f not in rels:
                problems.append(f"config.json lists[{i}] 指向包里没有的 {f}")
            lang = str(item.get("lang", "")).strip()
            if lang and lang not in LANGS:
                problems.append(f"[警告] lists[{i}] 的 lang={lang!r} 不在上游语种表里")
        if cover := str(cfg.get("cover", "")).strip():
            if cover not in rels:
                problems.append(f"config.json 的 cover 指向包里没有的 {cover}")
    return problems


def role_id(root: Path, explicit: str | None) -> str:
    if explicit:
        return explicit
    cfg = root / "config.json"
    if cfg.is_file():
        try:
            v = json.loads(cfg.read_text(encoding="utf-8")).get("id")
            if v and str(v).strip():
                return str(v).strip()
        except json.JSONDecodeError:
            pass
    return root.name


def main() -> int:
    ap = argparse.ArgumentParser(description="打角色包")
    ap.add_argument("--dir", required=True, help="角色目录（里面直接就是 config.json）")
    ap.add_argument("--id", help="角色 id，缺省取 config.json 的 id，再退到目录名")
    ap.add_argument("--out", default="dist", help="zip 落到哪个目录")
    ap.add_argument("--check", action="store_true", help="只校验，不打包")
    args = ap.parse_args()

    root = Path(args.dir).resolve()
    if not root.is_dir():
        print(f"[pack] 不是目录：{root}", file=sys.stderr)
        return 1

    files = collect(root)
    if not files:
        print(f"[pack] {root} 里没有文件", file=sys.stderr)
        return 1

    problems = check(root, files)
    hard = [p for p in problems if not p.startswith("[警告]")]
    for p in problems:
        print(f"[pack] {p}", file=sys.stderr)
    if hard:
        print(f"[pack] {len(hard)} 个硬错误，没有打包", file=sys.stderr)
        return 1

    rid = role_id(root, args.id)
    if args.check:
        print(f"[pack] 校验通过：{rid}，{len(files)} 个文件")
        return 0

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / f"{rid}_voice.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            # arcname 一律用 POSIX 分隔符：Windows 上打的包在解压时
            # 反斜杠会被当成文件名的一部分，导入侧的路径检查直接判它非法。
            z.write(p, p.relative_to(root).as_posix())

    size = zip_path.stat().st_size
    print(f"[pack] {zip_path}  {size / 1024**2:.1f} MB  {len(files)} 个文件")
    print("[pack] 下一步：verify_role_pack.py 拆开验一遍，再 publish_asset.py --tag GSV-roles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
