# -*- coding: utf-8 -*-
"""发布前把角色包拆开验一遍 —— 里面到底是不是两份能用的权重。

`pack_role_pack.py` 验的是「文件在不在、大小超没超」，那是打包侧的事。
这个脚本验的是**内容**：清单里写着一个 zip，那串字节拆开之后到底是不是
GPT-SoVITS 的 SoVITS 与 GPT 权重？不验的话，上架一个把 RVC 的 .pth 改名
成 sovits.pth 的包，用户装完点合成才会知道，而报错是 torch 抛出来的一行
形状不匹配 —— 没人看得懂那是包的问题。

三层，逐层加深，只要没有 torch 也能跑前两层：

1. **结构**：zip 条目路径合法（无绝对路径 / `..` / 盘符）、必需文件齐全、
   体积在导入侧的上限内 —— 和 `characters::install_zip` 同一套判据。
2. **权重指纹**：不加载模型，只读 torch 序列化格式的头几个字节。
   支持 torch ZIP、旧式 pickle 和 GPT-SoVITS 带版本头的 SoVITS ZIP。
3. **可加载**（`--deep`，需要 torch）：`torch.load(map_location="cpu")`
   读取常规权重，再看 SoVITS 的 `config.model.version` 和 GPT 的
   `config.model` 在不在 —— 这两处正是 `TTS.init_vits_weights` /
   `init_t2s_weights` 会去读的地方。带版本头的角色包复用客户端的权重配对校验。

用法::

    python scripts/verify_role_pack.py dist/tomori_voice.zip
    python scripts/verify_role_pack.py dist/*.zip --deep
    python scripts/verify_role_pack.py --sha <64位> dist/tomori_voice.zip
"""

from __future__ import annotations

import argparse
import hashlib
from importlib.util import module_from_spec, spec_from_file_location
import json
import sys
import tempfile
import zipfile
from pathlib import Path

MAX_ENTRY_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
REQUIRED = ["config.json", "models/sovits.pth", "models/gpt.ckpt"]
#: 权重最小体积。SoVITS 大约 100 MB 量级、GPT 150 MB 量级；给一个很松的
#: 下限，只为挡住「改名的空文件」和 Git LFS 没拉下来的指针文件（130 字节）。
MIN_WEIGHT_BYTES = 1024 * 1024
ENGINE_PAYLOAD = Path(__file__).resolve().parents[1] / "app/src-tauri/engine-payload"
_inspector_spec = spec_from_file_location("weight_inspect", ENGINE_PAYLOAD / "tools/weight_inspect.py")
assert _inspector_spec is not None and _inspector_spec.loader is not None
weight_inspect = module_from_spec(_inspector_spec)
_inspector_spec.loader.exec_module(weight_inspect)
SOVITS_HEADERS = weight_inspect._tables(ENGINE_PAYLOAD)["head2version"]


def bad_path(rel: str) -> str | None:
    """和 `characters::check_entry_path` 同一套判据。"""
    if not rel:
        return "空路径"
    if ":" in rel:
        return "带盘符"
    norm = rel.replace("\\", "/")
    if norm.startswith("/"):
        return "绝对路径"
    if any(seg == ".." for seg in norm.split("/")):
        return "带 .."
    return None


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def torch_magic(data: bytes, *, sovits: bool = False) -> str | None:
    """torch 存出来的东西开头长什么样。返回 None 表示不像。"""
    if data[:4] == b"PK\x03\x04":
        return "zip"          # torch>=1.6 的默认容器
    if sovits and data[:2] in SOVITS_HEADERS and data[2:4] == b"\x03\x04":
        return "sovits_zip"
    if data[:1] == b"\x80":
        return "pickle"       # 老式 torch.save
    return None


def verify(path: Path, expect_sha: str | None, deep: bool) -> list[str]:
    problems: list[str] = []

    if expect_sha:
        got = sha256_file(path)
        if got.lower() != expect_sha.lower():
            problems.append(f"sha256 对不上：清单说 {expect_sha}，实际 {got}")

    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        return problems + [f"不是合法 zip：{e}"]

    with z:
        names = z.namelist()
        total = 0
        for info in z.infolist():
            if info.is_dir():
                continue
            if why := bad_path(info.filename):
                problems.append(f"条目路径非法（{why}）：{info.filename}")
            if info.file_size > MAX_ENTRY_BYTES:
                problems.append(
                    f"{info.filename} 解压后 {info.file_size / 1024**2:.0f} MB，"
                    "超过导入上限 512 MB"
                )
            total += info.file_size
        if total > MAX_TOTAL_BYTES:
            problems.append(f"解压后共 {total / 1024**3:.1f} GB，超过导入上限 4 GB")

        # 顶层多包一层目录的包（Windows 右键压缩）导入侧能剥，但我们自己
        # 发的包不该有 —— 剥壳是兜底，不是约定。
        if "config.json" not in names:
            tops = {n.split("/", 1)[0] for n in names if "/" in n}
            if len(tops) == 1:
                problems.append(
                    f"多包了一层顶层目录 {tops.pop()!r}；导入侧会剥，但发布包不该有"
                )

        for need in REQUIRED:
            if need not in names:
                problems.append(f"缺 {need}")

        if "config.json" in names:
            try:
                cfg = json.loads(z.read("config.json").decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                problems.append(f"config.json 读不出来：{e}")
                cfg = {}
            if not str(cfg.get("name", "")).strip():
                problems.append("config.json 缺 name")

        for w in ("models/sovits.pth", "models/gpt.ckpt"):
            if w not in names:
                continue
            info = z.getinfo(w)
            if info.file_size < MIN_WEIGHT_BYTES:
                problems.append(
                    f"{w} 只有 {info.file_size} 字节 —— 多半是改名的空文件，"
                    "或者 LFS 指针没拉下来"
                )
                continue
            with z.open(w) as f:
                head = f.read(8)
            if torch_magic(head, sovits=(w == "models/sovits.pth")) is None:
                problems.append(
                    f"{w} 开头不是 torch 序列化格式（拿到 {head[:4]!r}）—— "
                    "这不是 torch.save 存出来的东西"
                )

        if deep and not problems:
            problems += deep_check(z, names)

    return problems


def deep_check(z: zipfile.ZipFile, names: list[str]) -> list[str]:
    """真的把两份权重读一遍。需要 torch，没装就说清楚并跳过。"""
    try:
        import torch  # noqa: PLC0415
    except ImportError:
        return ["[警告] 没有 torch，--deep 跳过（用 Runtime 里的 python 跑）"]

    out: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        with z.open("models/sovits.pth") as f:
            tagged = torch_magic(f.read(4), sovits=True) == "sovits_zip"
        if tagged:
            sovits = Path(z.extract("models/sovits.pth", td))
            gpt = Path(z.extract("models/gpt.ckpt", td))
            try:
                pair = weight_inspect.validate_replacement(sovits, "sovits", gpt, root=ENGINE_PAYLOAD)
            except Exception as e:  # noqa: BLE001
                return [f"权重配对校验失败：{type(e).__name__}: {e}"]
            return [f"[信息] sovits 版本标记：{pair['version']}"]
        for w, kind in (("models/sovits.pth", "sovits"), ("models/gpt.ckpt", "gpt")):
            if w not in names:
                continue
            p = Path(td) / Path(w).name
            p.write_bytes(z.read(w))
            try:
                d = torch.load(str(p), map_location="cpu", weights_only=False)
            except Exception as e:  # noqa: BLE001
                out.append(f"{w} torch.load 失败：{type(e).__name__}: {e}")
                continue
            if not isinstance(d, dict):
                out.append(f"{w} 读出来不是 dict（{type(d).__name__}）")
                continue
            if kind == "sovits":
                # `TTS.init_vits_weights` 读的就是 config / weight 这两把钥匙。
                if "weight" not in d:
                    out.append("models/sovits.pth 里没有 weight —— 不是 SoVITS 权重")
                cfg = d.get("config") or {}
                ver = (cfg.get("model") or {}).get("version") if isinstance(cfg, dict) else None
                out.append(f"[信息] sovits 版本标记：{ver or '(未标)'}")
            else:
                if "config" not in d and "weight" not in d:
                    out.append("models/gpt.ckpt 里既没有 config 也没有 weight —— 不是 GPT 权重")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="发布前验角色包")
    ap.add_argument("packs", nargs="+", help="要验的 zip")
    ap.add_argument("--sha", help="清单里写的 sha256（只能配单个 zip）")
    ap.add_argument("--deep", action="store_true", help="真的 torch.load 一遍")
    args = ap.parse_args()

    if args.sha and len(args.packs) != 1:
        print("[verify] --sha 一次只能验一个包", file=sys.stderr)
        return 1

    bad = 0
    for name in args.packs:
        p = Path(name)
        if not p.is_file():
            print(f"[verify] 找不到 {p}", file=sys.stderr)
            bad += 1
            continue
        problems = verify(p, args.sha, args.deep)
        hard = [x for x in problems if not x.startswith(("[警告]", "[信息]"))]
        for x in problems:
            print(f"[verify] {p.name}: {x}", file=sys.stderr)
        if hard:
            bad += 1
        else:
            print(f"[verify] {p.name}: 通过")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
