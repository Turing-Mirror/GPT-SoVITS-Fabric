# -*- coding: utf-8 -*-
"""壳的版本号 —— 单一来源是 `app/src-tauri/tauri.conf.json` 的 `version`。

不是上游 GPT-SoVITS 的版本，也不是 Runtime / 底模 / 角色包的版本。
那几样各有各的版本，混起来会出现「软件 1.6 但清单里 app 写着 Runtime 的
日期」这种对不上的清单。

发布前用它做两件事：

* `--check <上一版>`：新版本必须**严格大于**上一版。这道闸挡的是
  「忘了升版本就发」—— 客户端的更新检查是比大小，版本没涨等于所有人
  都收不到这次更新，而且没有任何报错。
* `--set <版本>`：一处改完，Cargo.toml / package.json 跟着同步，
  免得三个文件各写各的。

用法::

    python scripts/shell_version.py                 # 打印当前版本
    python scripts/shell_version.py --check 1.5.5   # 必须 > 1.5.5
    python scripts/shell_version.py --set 1.6.0     # 三处一起改
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TAURI_CONF = REPO / "app" / "src-tauri" / "tauri.conf.json"
CARGO_TOML = REPO / "app" / "src-tauri" / "Cargo.toml"
PACKAGE_JSON = REPO / "app" / "package.json"

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


def parse(v: str) -> tuple[int, int, int]:
    if not VERSION_RE.match(v.strip()):
        raise SystemExit(f"版本号形状不对：{v!r}，要 x.y.z")
    a, b, c = v.strip().split(".")
    return int(a), int(b), int(c)


def current() -> str:
    return str(json.loads(TAURI_CONF.read_text(encoding="utf-8")).get("version", ""))


def set_version(new: str) -> None:
    parse(new)

    conf_text = TAURI_CONF.read_text(encoding="utf-8")
    # 用正则改而不是 json.dump 回去：那样会把整份配置重排一遍，
    # diff 里看不出到底改了哪一行。
    conf_text, n = re.subn(
        r'("version"\s*:\s*)"[^"]*"', rf'\1"{new}"', conf_text, count=1
    )
    if n != 1:
        raise SystemExit("tauri.conf.json 里没找到 version 字段")
    TAURI_CONF.write_text(conf_text, encoding="utf-8")

    cargo = CARGO_TOML.read_text(encoding="utf-8")
    cargo, n = re.subn(r'(?m)^(version\s*=\s*)"[^"]*"', rf'\1"{new}"', cargo, count=1)
    if n != 1:
        raise SystemExit("Cargo.toml 里没找到 version")
    CARGO_TOML.write_text(cargo, encoding="utf-8")

    pkg = PACKAGE_JSON.read_text(encoding="utf-8")
    pkg, n = re.subn(r'("version"\s*:\s*)"[^"]*"', rf'\1"{new}"', pkg, count=1)
    if n == 1:
        PACKAGE_JSON.write_text(pkg, encoding="utf-8")
    print(f"[version] → {new}（tauri.conf.json / Cargo.toml{' / package.json' if n == 1 else ''}）")


def main() -> int:
    ap = argparse.ArgumentParser(description="壳版本号")
    ap.add_argument("--check", metavar="上一版", help="当前版本必须严格大于它")
    ap.add_argument("--set", dest="new", metavar="x.y.z", help="改版本号")
    args = ap.parse_args()

    if args.new:
        set_version(args.new)
        return 0

    cur = current()
    if args.check:
        if parse(cur) <= parse(args.check):
            print(
                f"[version] 当前 {cur} 不大于上一版 {args.check} —— "
                "客户端的更新检查是比大小，版本没涨等于所有人都收不到这次更新，"
                "而且不会有任何报错。"
            )
            return 1
        print(f"[version] {cur} > {args.check}")
        return 0

    print(cur)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
