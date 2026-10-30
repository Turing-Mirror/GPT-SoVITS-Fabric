# -*- coding: utf-8 -*-
"""打出安装包（Tauri NSIS）。

薄包：壳 + 上游源码，**不含** Runtime、底模、角色。这三样加起来十几个 GB，
塞进安装包等于让每个用户下一遍他不一定用得上的东西；它们由首启补全按需拿。

这个脚本做的事，按顺序：

1. `shell_version.py --check` —— 版本必须比上一版大。忘了升版本就发的话，
   客户端的更新检查是比大小，所有人都收不到，而且没有任何报错。
2. `npm run build` —— 里面串着 eslint + tsc + check_i18n + vite build，
   四道全过才继续。
3. `prepare_engine_payload.py` —— 铺上游源码 + 校验负载与 resources 对得上。
4. `tauri build` —— 出 NSIS。
5. 把产物改名成 `GPT-SoVITS-Fabric-Setup-<版本>.exe` 并算 sha256 边车，
   放进 `dist/`。名字里带版本，是因为发布仓和下载页都按文件名认。

用法::

    python scripts/build_setup.py --prev 1.5.5
    python scripts/build_setup.py --prev 1.5.5 --skip-frontend   # 只重打壳
    python scripts/build_setup.py --dry-run                      # 只跑前三步
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP = REPO / "app"
TAURI = APP / "src-tauri"
DIST = REPO / "dist"

PRODUCT = "GPT-SoVITS Fabric"
SETUP_STEM = "GPT-SoVITS-Fabric-Setup"


def run(cmd: list[str], cwd: Path, label: str) -> None:
    print(f"[setup] {label}：{' '.join(cmd)}")
    r = subprocess.run(cmd, cwd=str(cwd))
    if r.returncode != 0:
        raise SystemExit(f"[setup] {label} 失败（退出码 {r.returncode}）")


def npm() -> str:
    """Windows 上 npm 是 npm.cmd，直接 `npm` 会 FileNotFoundError。"""
    return "npm.cmd" if os.name == "nt" else "npm"


def version() -> str:
    return str(json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))["version"])


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_installer() -> Path:
    """Tauri 把 NSIS 产物落在 target/release/bundle/nsis/。

    按 mtime 取最新的那个：目录里可能留着上一次构建的旧版本，
    按名字猜会拿到旧的，而旧的能装 —— 那种错误要到用户装完打开
    「关于」页看到版本号不对才会被发现。
    """
    d = TAURI / "target" / "release" / "bundle" / "nsis"
    if not d.is_dir():
        raise SystemExit(f"[setup] 没有产物目录：{d}")
    exes = sorted(d.glob("*.exe"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not exes:
        raise SystemExit(f"[setup] {d} 里没有 .exe")
    return exes[0]


def main() -> int:
    ap = argparse.ArgumentParser(description="打 GPT-SoVITS Fabric 安装包")
    ap.add_argument("--prev", help="上一个发布版本；给了就校验版本必须更大")
    ap.add_argument("--upstream", help="上游 GPT-SoVITS 源码树（传给 prepare_engine_payload）")
    ap.add_argument("--runtime", help="Runtime 目录（传给 prepare_engine_payload，预编译日语词典）")
    ap.add_argument("--skip-frontend", action="store_true", help="跳过 npm run build")
    ap.add_argument("--dry-run", action="store_true", help="只跑到 tauri build 之前")
    args = ap.parse_args()

    ver = version()
    print(f"[setup] {PRODUCT} v{ver}")

    if args.prev:
        run([sys.executable, str(REPO / "scripts" / "shell_version.py"), "--check", args.prev],
            REPO, "版本校验")

    if not args.skip_frontend:
        run([npm(), "run", "build"], APP, "前端构建")

    prep = [sys.executable, str(REPO / "scripts" / "prepare_engine_payload.py")]
    if args.upstream:
        prep += ["--upstream", args.upstream]
    else:
        # 没指上游就只校验，不重铺 —— 仓库里那份已经是钉在 pin 上的，
        # 平时打包不需要每次都从上游拷一遍。
        prep += ["--check"]
    if args.runtime:
        prep += ["--runtime", args.runtime]
    run(prep, REPO, "引擎负载")

    if args.dry_run:
        print("[setup] --dry-run：到此为止")
        return 0

    run([npm(), "run", "tauri", "--", "build"], APP, "Tauri 打包")

    src = find_installer()
    DIST.mkdir(parents=True, exist_ok=True)
    out = DIST / f"{SETUP_STEM}-{ver}.exe"
    shutil.copy2(src, out)
    digest = sha256_of(out)
    (DIST / f"{out.name}.sha256").write_text(digest + "\n", encoding="utf-8")

    size = out.stat().st_size
    print(f"[setup] {out}")
    print(f"[setup] {size / 1024 / 1024:.1f} MB  sha256 {digest}")
    print("[setup] 下一步：publish_asset.py --tag GSV-setup 上传，再 build_catalog.py 回填")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
