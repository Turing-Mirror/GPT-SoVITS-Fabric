# -*- coding: utf-8 -*-
"""搭一个本机开发用的产品根，给 `TM_VOICE_ROOT` 用。

布局与安装后一致::

    <root>/
      Runtime/                      ← 目录联接到 build_runtime.py 的产物
      GPT_SoVITS/ tools/ ...        ← 引擎负载（复制，重跑本脚本即同步）
      GPT_SoVITS/pretrained_models  ← 目录联接到本机已有的底模目录
      GPT_SoVITS/text/G2PWModel     ← 同上

`User_Data/` 第一次创建后不再动，重跑不会清掉开发时装的角色与设置。

用法::

    python scripts/dev_root.py --pretrained <含 chinese-hubert-base 等的目录> \\
        --g2pw <G2PWModel 目录>
    python scripts/dev_root.py            # 只同步负载，联接保持原样
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PAYLOAD = REPO / "app" / "src-tauri" / "engine-payload"
DEFAULT_ROOT = REPO / "data" / "dev-root"
DEFAULT_RUNTIME = REPO / "data" / "runtime-build" / "nvidia" / "Runtime"

#: 负载里这几个是运行期产物或联接点，同步时不覆盖。
KEEP = {"logs", "pretrained_models", "G2PWModel", "__pycache__"}


def log(msg: str) -> None:
    print(f"[dev-root] {msg}", flush=True)


def junction(link: Path, target: Path) -> None:
    """Windows 目录联接：不需要管理员权限，删联接不会删目标。"""
    if not target.is_dir():
        raise SystemExit(f"[dev-root] 目标不存在：{target}")
    if link.exists() or link.is_symlink():
        if link.resolve() == target.resolve():
            return
        if link.is_dir() and not any(link.iterdir()):
            link.rmdir()
        else:
            raise SystemExit(f"[dev-root] {link} 已存在且指向别处，先手动移走")
    link.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"[dev-root] 联接失败：{r.stderr or r.stdout}")
    log(f"{link.name} → {target}")


def sync_payload(root: Path) -> None:
    def ignore(_d: str, names: list[str]) -> set[str]:
        return {n for n in names if n in KEEP}

    for item in PAYLOAD.iterdir():
        dst = root / item.name
        if item.is_dir():
            shutil.copytree(item, dst, ignore=ignore, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dst)
    log(f"负载已同步 ← {PAYLOAD}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(DEFAULT_ROOT))
    ap.add_argument("--runtime", default=str(DEFAULT_RUNTIME))
    ap.add_argument("--pretrained", help="底模目录（上游的 GPT_SoVITS/pretrained_models）")
    ap.add_argument("--g2pw", help="G2PWModel 目录（上游的 GPT_SoVITS/text/G2PWModel）")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    sync_payload(root)
    runtime = Path(args.runtime).resolve()
    if runtime.is_dir():
        junction(root / "Runtime", runtime)
    else:
        log(f"Runtime 还没有：{runtime}")
    if args.pretrained:
        junction(root / "GPT_SoVITS" / "pretrained_models", Path(args.pretrained).resolve())
    if args.g2pw:
        junction(root / "GPT_SoVITS" / "text" / "G2PWModel", Path(args.g2pw).resolve())
    (root / "User_Data").mkdir(exist_ok=True)
    log(f"完成：TM_VOICE_ROOT={root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
