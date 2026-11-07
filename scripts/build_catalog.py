# -*- coding: utf-8 -*-
"""在线清单编译器 —— `catalog/sources.json` → `index.json`。

软件启动后读的唯一入口就是发布仓根上的 `index.json`（`catalog.rs` 的
`MANIFEST_URLS` 写死了那两条地址）。这个脚本把人工维护的单一来源
`catalog/sources.json` 编译成它。**产物 json 不要手改** —— 手改的那一次
一定会和下一次编译打架。

## 为什么不抄 RVC 那份

RVC 的同名脚本 2554 行，多出来的两千行几乎全在伺候「第三方音色收编」：
从 HuggingFace 收编条目、批量验证、YAML 每音色一个文件再编译。这个产品
现在没有第三方角色生态，先不建那套；建了也是没人用的两千行。

所以走 So-VITS-SVC 的路子：**单一 JSON 源，不经 YAML 中转**。段位少、
结构固定，多一层模板只增加出错机会。

## 只写壳真读的字段

字段表是从六个 Rust 模块里 grep 出来的，多写的一律不写 —— RVC 的
index.json 有 7000 行，其中相当一部分现在没有任何代码在读：

* `catalog.rs`      → runtimes / runtime_release_tag / parts[] / release_tag
* `extra_assets.rs` → extras.<key>.{label,dest,group,order,recommended,files[]}
* `update.rs`       → app / gui
* `store.rs`        → roles[]（角色包）
* `plaza.rs`        → entries[]

## 输入（catalog/sources.json）

    {
      "app":         {"name","version","sha256","size_bytes"},
      "engine_core": {"version","packs":[{name,sha256,size_bytes}]},  # 旧形：{"name",...} 单包
      "runtimes":    {"nvidia": {"label","version","parts":[{name,sha256,size_bytes}]}},
      "roles":       [{"id","name","author","version","pack","sha256","cover"}],
      "extras":      {"<key>": {"label","dest","group","tag","repo"?,"files":[{name,sha256,size_bytes}]}}
    }

## 用法

    python scripts/build_catalog.py --sources <发布仓>/catalog/sources.json \\
        --out <发布仓>/index.json
    python scripts/build_catalog.py --sources ... --check   # 只校验必填字段
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]

CNB_BASE = "https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases"
CNB_ORG_REPO = "Turing-Mirror/GPT-SoVITS-Fabric-Releases"

#: 三条 Release 标签。分开是因为三样东西的更新节奏完全不同：Runtime 几个 GB
#: 极少动、底模按版本组增量、角色包持续新增。混在一个标签里没法单独重传。
TAG_RUNTIME = "GSV-runtime"
TAG_CORE = "GSV-engine-core"
TAG_ROLES = "GSV-roles"
TAG_SETUP = "GSV-setup"
#: 封面走 Release 附件，不走 git raw：raw 对图片不给正确的 Content-Type，
#: 而 Release 附件按扩展名给 image/jpeg，也没有 nosniff。
TAG_COVERS = "GSV-covers"

SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def asset_url(tag: str, name: str, base: str = CNB_BASE) -> str:
    # Release 附件是平铺的：带子目录的 name（落盘位置）只取文件名部分。
    return f"{base}/-/releases/download/{tag}/{name.rsplit('/', 1)[-1]}"


def raw_url(rel: str) -> str:
    return f"{CNB_BASE}/-/git/raw/main/{rel}"


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warns: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warns.append(msg)


def need_sha(rep: Report, who: str, node: dict[str, Any]) -> str:
    """sha 必须是 64 位十六进制。

    空 sha 不是「以后再填」的占位 —— `run_provision` 的校验会拒装，
    用户看到的是「校验信息缺失」。所以在编译期就挡住，别等到发出去。
    """
    sha = str(node.get("sha256", "")).strip().lower()
    if not SHA_RE.match(sha):
        rep.error(f"{who}: sha256 不是 64 位十六进制（拿到 {sha!r}）")
    return sha


def need_size(rep: Report, who: str, node: dict[str, Any]) -> int:
    """体积必须是正数。

    0 会让下载进度条连分母都没有 —— `auto_connections` 按大小决定开几路，
    看到 0 就只给一条连接慢慢爬。
    """
    try:
        n = int(node.get("size_bytes", 0))
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        rep.error(f"{who}: size_bytes 必须是正数（拿到 {node.get('size_bytes')!r}）")
    return n


def build_runtimes(src: dict, rep: Report) -> dict:
    out: dict[str, Any] = {}
    for variant, rt in (src.get("runtimes") or {}).items():
        if variant not in ("nvidia", "cpu"):
            # `catalog::normalize_variant` 只认这两个，其余一律折到 cpu ——
            # 清单里写第三个变体，客户端会把它当 cpu，装完发现不是那回事。
            rep.error(f"runtimes.{variant}: 只认 nvidia / cpu（见 DECISIONS D3）")
            continue
        parts = []
        for i, part in enumerate(rt.get("parts") or []):
            who = f"runtimes.{variant}.parts[{i}]"
            name = str(part.get("name", "")).strip()
            if not name:
                rep.error(f"{who}: 缺 name")
                continue
            parts.append({
                "index": i,
                "name": name,
                "size_bytes": need_size(rep, who, part),
                "sha256": need_sha(rep, who, part),
                "channel": "release",
                "urls": [asset_url(TAG_RUNTIME, name)],
                "sha256_urls": [raw_url(f"assets/runtime/{name}.sha256")],
            })
        if not parts:
            rep.error(f"runtimes.{variant}: 一个分片都没有")
            continue
        out[variant] = {
            "variant": variant,
            "label": rt.get("label") or variant,
            "version": str(rt.get("version", "")),
            "format": "tar.gz" if parts[0]["name"].endswith(".tar.gz") else "tar",
            "size_bytes": sum(p["size_bytes"] for p in parts),
            "extract_root": rt.get("extract_root", "Runtime"),
            "channel": "release",
            "release_tag": TAG_RUNTIME,
            "parts": parts,
        }
    if not out:
        rep.error("runtimes: 一个变体都没有 —— 首启补全会直接无源可下")
    return out


def build_roles(src: dict, rep: Report) -> list[dict]:
    """角色包条目。

    落点是 `User_Data/characters/<id>/`，由 `characters::install_zip` 解压 ——
    不是 RVC 那个 `User_Data/models/`。清单这边只负责给出 URL 与校验值，
    包的形状（config.json + models/{sovits.pth,gpt.ckpt} + dataset/）
    由 `verify_role_pack.py` 在发布前验。
    """
    out = []
    seen: set[str] = set()
    for i, v in enumerate(src.get("roles") or []):
        who = f"roles[{i}]"
        rid = str(v.get("id", "")).strip()
        if not rid:
            rep.error(f"{who}: 缺 id")
            continue
        if rid in seen:
            rep.error(f"{who}: id 重复：{rid}")
            continue
        seen.add(rid)
        pack = str(v.get("pack", "")).strip()
        if not pack:
            rep.error(f"{who}: 缺 pack（zip 文件名）")
            continue
        entry = {
            "id": rid,
            "name": v.get("name") or rid,
            "author": v.get("author", ""),
            "author_url": v.get("author_url", ""),
            "source_url": v.get("source_url", ""),
            "released": v.get("released", ""),
            "version": str(v.get("version", "v2ProPlus")),
            "package_type": "role_pack",
            "pack_url": asset_url(TAG_ROLES, pack),
            "sha256": need_sha(rep, who, v),
            "size_bytes": need_size(rep, who, v),
            "dest": "characters",
        }
        for k in ("name_en", "name_ja", "name_zh_hant", "series", "group"):
            if v.get(k):
                entry[k] = v[k]
        if cover := str(v.get("cover", "")).strip():
            entry["cover"] = cover
            entry["cover_url"] = asset_url(TAG_COVERS, cover)
        out.append(entry)
    return out


def build_extras(src: dict, rep: Report) -> dict:
    out: dict[str, Any] = {}
    for key, ex in (src.get("extras") or {}).items():
        who = f"extras.{key}"
        files = []
        for j, f in enumerate(ex.get("files") or []):
            fw = f"{who}.files[{j}]"
            name = str(f.get("name", "")).strip()
            if not name:
                rep.error(f"{fw}: 缺 name")
                continue
            files.append({
                "name": name,
                "sha256": need_sha(rep, fw, f),
                "size_bytes": need_size(rep, fw, f),
                "channel": "release",
                # `repo`：附件挂在别的发布仓时填它的地址（人声分离模型与 RVC
                # Fabric 共用同一批 Release 附件，不重复上传）。
                "urls": [asset_url(ex.get("tag") or TAG_CORE, name, ex.get("repo") or CNB_BASE)],
            })
        if not files:
            rep.error(f"{who}: 一个文件都没有")
            continue
        group = str(ex.get("group", "other"))
        if group not in ("train", "separate", "synth", "other"):
            # 与前端 `extraGroups.ts` 的 CATEGORY_ORDER 一致。写别的值，
            # 那一条会落进「其他」分类，用户在分离页点「下载模型」就找不到它。
            rep.error(f"{who}: group 只认 train / separate / synth / other（拿到 {group!r}）")
        out[key] = {
            "key": key,
            "label": ex.get("label") or key,
            "dest": ex.get("dest") or "",
            "notes": ex.get("notes", ""),
            "group": group,
            "recommended": bool(ex.get("recommended", False)),
            "order": int(ex.get("order", 100)),
            "release_tag": ex.get("tag") or TAG_CORE,
            "size_bytes": sum(f["size_bytes"] for f in files),
            "files": files,
        }
    return out


def build(src: dict, rep: Report) -> dict:
    app = src.get("app") or {}
    core = src.get("engine_core") or {}

    out: dict[str, Any] = {
        "schema": 3,
        "format": "gsv_fabric_index",
        "product": "GPT-SoVITS Fabric",
        "cnb_repo": CNB_ORG_REPO,
        "runtime_release_tag": TAG_RUNTIME,
        "manifest_urls": [
            f"{CNB_BASE}/-/git/raw/main/index.json",
            f"{CNB_BASE}/-/git/raw/main/catalog/online_catalog.snippet.json",
        ],
        "note": "由 scripts/build_catalog.py 从 catalog/sources.json 编译，勿手改",
    }

    if app:
        name = str(app.get("name", "")).strip()
        if not name:
            rep.error("app: 缺 name")
        out["app"] = {
            "name": name,
            "version": str(app.get("version", "")),
            "channel": "release",
            "size_bytes": need_size(rep, "app", app),
            "sha256": need_sha(rep, "app", app),
            "urls": [asset_url(TAG_SETUP, name)],
            "sha256_urls": [raw_url(f"assets/setup/{name}.sha256")],
        }
    else:
        rep.warn("没有 app 段：客户端的「检查更新」会永远回答「已是最新」")

    if core.get("packs"):
        # 底模拆成多个包（scripts/build_engine_core.py 的 manifest.json）：按包名
        # 去掉 .zip 做键。客户端只按 name 查大小，sha 以壳内 BASE_MODEL_PACKS 为准。
        packs: dict[str, Any] = {}
        for p in core["packs"]:
            name = str(p.get("name", "")).strip()
            who = f"engine_core.{name or '?'}"
            if not name:
                rep.error(f"{who}: 缺 name")
                continue
            packs[name.removesuffix(".zip")] = {
                "name": name,
                "version": str(core.get("version", "")),
                "channel": "release",
                "size_bytes": need_size(rep, who, p),
                "sha256": need_sha(rep, who, p),
                "urls": [asset_url(TAG_CORE, name)],
            }
        out["engine_core"] = packs
    elif core:
        name = str(core.get("name", "")).strip()
        out["engine_core"] = {
            "name": name,
            "version": str(core.get("version", "")),
            "channel": "release",
            "size_bytes": need_size(rep, "engine_core", core),
            "sha256": need_sha(rep, "engine_core", core),
            "urls": [asset_url(TAG_CORE, name)],
            "sha256_urls": [raw_url(f"assets/core/{name}.sha256")],
        }
    else:
        rep.warn("没有 engine_core 段：底模只能靠 extras 一条条补")

    out["runtimes"] = build_runtimes(src, rep)
    out["roles"] = build_roles(src, rep)
    out["extras"] = build_extras(src, rep)
    return out


def loopback(doc: dict, rep: Report) -> None:
    """把编译出来的清单喂给**真正的客户端解析器**再看一眼。

    自己校验自己没有意义：这个脚本认为「填了 sha 就行」，客户端认不认得出
    是另一回事。`src/bin/catalog-check.rs` 就是为这一步存在的 —— 它调的是
    `catalog::parse_spec`，和用户机器上跑的是同一份代码。

    二进制没构建就跳过（`cargo build --bin catalog-check` 一次即可），
    不为一个校验步骤强制所有人装 Rust 工具链。
    """
    name = "catalog-check.exe" if sys.platform == "win32" else "catalog-check"
    target = REPO / "app" / "src-tauri" / "target"
    exe = next((p for p in (target / "debug" / name, target / "release" / name) if p.is_file()), None)
    if exe is None:
        rep.warn(
            "没有 catalog-check 二进制，跳过客户端回环校验；"
            "跑一次 `cargo build --bin catalog-check` 就有了"
        )
        return
    try:
        r = subprocess.run(
            [str(exe), "runtimes"],
            input=json.dumps(doc), capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as e:
        rep.warn(f"回环校验没跑起来：{e}")
        return
    if r.returncode != 0:
        rep.error(f"客户端解析器拒绝了这份清单：{r.stderr.strip()[:200]}")
        return
    try:
        got = json.loads(r.stdout)
    except json.JSONDecodeError:
        rep.error("回环校验的输出不是 JSON")
        return
    for row in got.get("runtimes") or []:
        who = f"runtimes.{row.get('variant')}"
        if not row.get("sha256"):
            rep.error(f"{who}: 客户端解析后拿不到 sha256 —— 装的时候会被拒")
        if not row.get("urls"):
            rep.error(f"{who}: 客户端解析后一条 URL 都没有 —— 无从下载")
    print(
        f"[catalog] 回环校验：{len(got.get('runtimes') or [])} 个变体过了客户端解析器",
        file=sys.stderr,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="编译在线清单")
    ap.add_argument("--sources", required=True, help="catalog/sources.json")
    ap.add_argument("--out", help="写到哪（缺省打到 stdout）")
    ap.add_argument("--check", action="store_true", help="只校验，不输出清单")
    ap.add_argument("--bundle", help="同时把编译结果并进随包内置清单（engine-payload/configs/online_catalog.json）")
    args = ap.parse_args()

    path = Path(args.sources)
    if not path.is_file():
        print(f"[catalog] 找不到 {path}", file=sys.stderr)
        return 1
    src = json.loads(path.read_text(encoding="utf-8"))

    rep = Report()
    doc = build(src, rep)
    if not rep.errors:
        loopback(doc, rep)

    for w in rep.warns:
        print(f"[catalog] 警告：{w}", file=sys.stderr)
    for e in rep.errors:
        print(f"[catalog] 错误：{e}", file=sys.stderr)
    if rep.errors:
        print(f"[catalog] {len(rep.errors)} 个错误，没有输出清单", file=sys.stderr)
        return 1

    n_rt = len(doc.get("runtimes") or {})
    n_role = len(doc.get("roles") or [])
    n_ex = len(doc.get("extras") or {})
    print(
        f"[catalog] 运行时 {n_rt} 个变体 · 角色 {n_role} 个 · extras {n_ex} 组",
        file=sys.stderr,
    )
    if args.check:
        print("[catalog] 校验通过", file=sys.stderr)
        return 0

    if args.bundle:
        # 内置清单是离线兜底，另有 community 等本脚本不管的段：只覆盖编译出的那几段。
        bp = Path(args.bundle)
        bundled = json.loads(bp.read_text(encoding="utf-8")) if bp.is_file() else {}
        for k in ("schema", "format", "cnb_repo", "runtime_release_tag", "manifest_urls",
                  "app", "engine_core", "runtimes", "roles", "extras"):
            if k in doc:
                bundled[k] = doc[k]
        bp.write_text(json.dumps(bundled, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[catalog] 内置清单已更新 → {bp}", file=sys.stderr)

    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"[catalog] → {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
