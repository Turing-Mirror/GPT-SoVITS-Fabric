#!/usr/bin/env python3
"""为 Tauri 安装包准备干净的引擎负载。

## 为什么需要这一步

两件事，Tauri 的 `bundle.resources` 都不会替你做。

**一、上游源码得随包发。** 三个 worker 全都 `import GPT_SoVITS`：
`synth_worker` 走 `GPT_SoVITS.TTS_infer_pack.TTS`，`train_worker` 起
`GPT_SoVITS/prepare_datasets/*.py` 与 `s1_train.py` / `s2_train.py`，
后者还 `from tools.my_utils import clean_path`。而仓库里的
`engine-payload/` 只有我们自己写的 `tools/`，没有 `GPT_SoVITS/`，
也没有上游的 `tools/`。装完之后运行时和底模都补齐了，`import GPT_SoVITS`
照样失败 —— 这个洞不补，前面所有的接线都跑不起来。

源码**钉在一个 commit 上随包发**，不做成可下载的 extras。理由是契约：
worker 是对着 `UPSTREAM_PIN` 那个版本逐行核过的（方法名、属性名、
返回值形状、配置键、产物目录），让它跟壳分开升级，就是在等下一轮
「合成台一次都没跑起来过」。要升上游，先改这里的 pin、再重核一遍 worker。

**二、`resources` 漏登记会静默丢文件。** 负载里多出一个顶层条目、而
`tauri.conf.json` 的 `bundle.resources` 没列上，那个条目就不进安装包 ——
用户装完少一整个目录，没有任何报错。所以脚本最后拿负载的顶层条目和
配置对一遍，对不上直接失败。

## 用法

    # 上游 clone 的位置：--upstream，或环境变量 GSV_UPSTREAM，
    # 或与产品仓同级的 ../GPT-SoVITS-upstream
    python scripts/prepare_engine_payload.py --upstream /path/to/GPT-SoVITS
    python scripts/prepare_engine_payload.py --check   # 只校验，不改文件

上游按 pin 取：

    git clone https://github.com/RVC-Boss/GPT-SoVITS.git
    git -C GPT-SoVITS checkout <UPSTREAM_PIN>
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PAYLOAD = REPO / "app" / "src-tauri" / "engine-payload"
TAURI_CONF = REPO / "app" / "src-tauri" / "tauri.conf.json"

#: 随包发的上游版本。**改这个值 = 承诺重新核对三个 worker 的契约。**
#: 当前值是 2026-10-19 的 `fix(streaming): 支持API v2语义流式文本切分 (#2850)`，含 V5。
UPSTREAM_PIN = "b4570b8"

#: 从上游整个搬过来的目录。`GPT_SoVITS/pretrained_models` 不搬 ——
#: 那是底模的落点，几百 MB，走 engine-core 按需补全。
UPSTREAM_DIRS = ["GPT_SoVITS", "tools"]

#: 上游根目录下这几个单文件也要：`webui.py` / `inference_webui.py` 是
#: 「其他」页那两个高级入口开的东西，`config.py` 是它们读端口的地方。
UPSTREAM_FILES = ["webui.py", "api_v2.py", "config.py"]

#: 不进安装包的东西。缓存和字节码每台机器都不一样，进包只会让包变大、
#: 让两次构建的产物对不上。
EXCLUDE_NAMES = {
    "__pycache__",
    ".git",
    ".github",
    ".gitignore",
    ".DS_Store",
    "pretrained_models",  # 底模走 engine-core
    "TEMP",               # 上游 japanese.py 的运行期缓存
}
EXCLUDE_SUFFIX = {".pyc", ".pyo", ".log"}


def fail(msg: str) -> None:
    print(f"[payload] 失败：{msg}", file=sys.stderr)
    raise SystemExit(1)


def find_upstream(explicit: str | None) -> Path:
    for cand in [
        explicit,
        os.environ.get("GSV_UPSTREAM"),
        str(REPO.parent / "GPT-SoVITS-upstream"),
        str(REPO.parent / "GPT-SoVITS"),
    ]:
        if not cand:
            continue
        p = Path(cand).expanduser()
        if (p / "GPT_SoVITS").is_dir():
            return p
    fail(
        "找不到上游源码树。用 --upstream 指过去，或设 GSV_UPSTREAM；\n"
        "  git clone https://github.com/RVC-Boss/GPT-SoVITS.git\n"
        f"  git -C GPT-SoVITS checkout {UPSTREAM_PIN}"
    )
    raise AssertionError("unreachable")


def upstream_commit(up: Path) -> str:
    """上游 clone 当前停在哪个 commit。不是 git 仓库就返回空串。"""
    try:
        out = subprocess.run(
            ["git", "-C", str(up), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def ignore(_dir: str, names: list[str]) -> set[str]:
    out = set()
    for n in names:
        if n in EXCLUDE_NAMES or Path(n).suffix in EXCLUDE_SUFFIX:
            out.add(n)
    return out


def vendor(up: Path) -> None:
    """把上游源码铺进负载。

    `tools/` 是**合并**不是替换：我们自己的 worker 就住在那儿
    （`synth_worker.py` / `train_worker.py` / `separate_worker.py` / pymss
    两棵树），而上游的 `tools/my_utils.py`、`slice_audio.py`、`asr/`
    是 prepare_datasets 那几步 import 的。两边文件名没有交集，
    合并之后 `import tools.my_utils` 和 `python tools/synth_worker.py`
    同时成立 —— 这正是 worker 写的时候假设的布局。
    """
    for name in UPSTREAM_DIRS:
        src = up / name
        if not src.is_dir():
            fail(f"上游缺目录：{src}")
        dst = PAYLOAD / name
        if name == "tools":
            merged = 0
            for p in src.rglob("*"):
                if any(part in EXCLUDE_NAMES for part in p.parts):
                    continue
                if p.suffix in EXCLUDE_SUFFIX or not p.is_file():
                    continue
                rel = p.relative_to(src)
                out = dst / rel
                # 我们自己的文件优先，绝不被上游同名文件盖掉。
                if out.exists() and not _is_vendored(out):
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, out)
                merged += 1
            print(f"[payload] tools/ 合并上游 {merged} 个文件")
        else:
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst, ignore=ignore)
            print(f"[payload] {name}/ ← 上游")

    for name in UPSTREAM_FILES:
        src = up / name
        if not src.is_file():
            fail(f"上游缺文件：{src}")
        shutil.copy2(src, PAYLOAD / name)
    print(f"[payload] 顶层单文件 ← {', '.join(UPSTREAM_FILES)}")


#: 我们自己维护的、住在 `tools/` 里的东西。合并时这些不许被上游覆盖。
OURS_IN_TOOLS = {
    "synth_worker.py",
    "train_worker.py",
    "separate_worker.py",
    "pymss",
    "pymss_core",
}


def _is_vendored(p: Path) -> bool:
    """这个文件是上游铺下来的（可以覆盖），还是我们自己的（不许动）。"""
    rel = p.relative_to(PAYLOAD / "tools")
    return rel.parts[0] not in OURS_IN_TOOLS


def scrub() -> int:
    """删掉负载里的字节码与缓存。构建机上跑过一次就会长出来。"""
    n = 0
    for p in sorted(PAYLOAD.rglob("*"), key=lambda x: -len(x.parts)):
        if p.is_dir() and p.name in EXCLUDE_NAMES:
            shutil.rmtree(p, ignore_errors=True)
            n += 1
        elif p.is_file() and p.suffix in EXCLUDE_SUFFIX:
            p.unlink(missing_ok=True)
            n += 1
    return n


def resource_entries() -> list[str]:
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    res = conf.get("bundle", {}).get("resources", [])
    # 数组形态（保留相对路径）和对象形态（显式落点）都要认。
    return list(res.keys()) if isinstance(res, dict) else list(res)


def check_resources() -> list[str]:
    """负载顶层条目 ↔ tauri.conf.json 的 resources，两边都不许有落单。"""
    listed = {
        e.split("engine-payload/", 1)[1]
        for e in resource_entries()
        if e.startswith("engine-payload/")
    }
    actual = {p.name for p in PAYLOAD.iterdir()}
    problems = []
    for missing in sorted(actual - listed):
        problems.append(
            f"负载里有 `{missing}`，但 resources 没登记 —— 它不会进安装包，"
            f"而且不会有任何报错"
        )
    for stale in sorted(listed - actual):
        problems.append(f"resources 登记了 `{stale}`，但负载里没有这个条目")
    return problems


def write_meta(up: Path, commit: str) -> None:
    meta_path = PAYLOAD / "setup_package.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["upstream_repo"] = "https://github.com/RVC-Boss/GPT-SoVITS"
    meta["upstream_pin"] = UPSTREAM_PIN
    meta["upstream_commit"] = commit
    meta["payload_entries"] = sorted(p.name for p in PAYLOAD.iterdir())
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"[payload] setup_package.json ← upstream {commit or '(非 git)'}")


#: 版本表落点。壳（train.rs）和 train_worker 都读它，不各自写一份版本清单。
VERSION_TABLE = PAYLOAD / "configs" / "upstream_versions.json"


def _literal(tree, name: str):
    """模块顶层 `name = <字面量>` 的值（允许 `a = b = <字面量>` 连写）。"""
    import ast

    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in node.targets
        ):
            return ast.literal_eval(node.value)
    fail(f"上游里找不到 {name}，版本表的来源变了，需要重新核对")


def _train_choices(tree) -> list[str]:
    """webui 训练页的版本单选（label 为「训练模型的版本」的那个 Radio）。"""
    import ast

    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "Radio"):
            continue
        kw = {k.arg: k.value for k in node.keywords}
        label = kw.get("label")
        if (
            isinstance(label, ast.Call)
            and label.args
            and isinstance(label.args[0], ast.Constant)
            and label.args[0].value == "训练模型的版本"
            and "choices" in kw
        ):
            return list(ast.literal_eval(kw["choices"]))
    fail("webui.py 里找不到训练版本的单选，版本表的来源变了，需要重新核对")


def write_version_table() -> None:
    """从随包的上游源码抽出版本事实，写成 configs/upstream_versions.json。

    全部取自上游，不手写：可训练版本取 webui 训练页的选项，LoRA 版本取
    `v3v4set`，底模路径取 config.py 的两张表。判据也照抄上游：
    s2 配置模板是 `s2<版本>.json`（存在时）否则 `s2.json`（webui 的 open1Ba），
    非 LoRA 版本的判别器底模是把 s2G 换成 s2D，带 Pro 的版本格式化时要多跑
    说话人验证（prepare_datasets/2-get-sv.py），v1 用 s1longer.yaml。
    """
    import ast

    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SyntaxWarning)  # 上游正则字符串里的 "\d"
        cfg = ast.parse((PAYLOAD / "config.py").read_text(encoding="utf-8"))
        web = ast.parse((PAYLOAD / "webui.py").read_text(encoding="utf-8"))
    s2g = _literal(cfg, "pretrained_sovits_name")
    s1 = _literal(cfg, "pretrained_gpt_name")
    lora = set(_literal(web, "v3v4set"))
    train = _train_choices(web)
    configs = PAYLOAD / "GPT_SoVITS" / "configs"

    versions = {}
    for v, g in s2g.items():
        own = f"s2{v}.json"
        versions[v] = {
            "trainable": v in train,
            "lora": v in lora,
            "s2G": g,
            "s2D": None if v in lora else g.replace("s2G", "s2D"),
            "s1": s1.get(v),
            "s2_config": f"GPT_SoVITS/configs/{own if (configs / own).is_file() else 's2.json'}",
            "s1_config": "GPT_SoVITS/configs/" + ("s1longer.yaml" if v == "v1" else "s1longer-v2.yaml"),
            "needs_sv": "Pro" in v,
        }
    doc = {
        "_note": "由 scripts/prepare_engine_payload.py 从随包上游源码生成，勿手改",
        "upstream_pin": UPSTREAM_PIN,
        "train_order": train,
        "versions": versions,
    }
    VERSION_TABLE.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[payload] 版本表 ← 可训练 {', '.join(train)}；LoRA {', '.join(sorted(lora))}")


#: 日语用户词典。上游第一次处理日语文本时才把 13 万行的 csv 编成 user.dict，
#: 要两三分钟，用户看到的是「第一次合成卡住」。打包前用 Runtime 先编好，
#: 连同上游用来判断是否要重编的 md5 一起放进负载。
JA_USERDIC = PAYLOAD / "GPT_SoVITS" / "text" / "ja_userdic"


def compile_ja_userdict(runtime: Path) -> None:
    py = runtime / "python.exe"
    if not py.is_file():
        fail(f"找不到 Runtime：{py}")
    csv = JA_USERDIC / "userdict.csv"
    code = (
        "import hashlib, pyopenjtalk, sys; csv, out, md5 = sys.argv[1:4]; "
        "pyopenjtalk.mecab_dict_index(csv, out); "
        "open(md5, 'w', encoding='utf-8').write(hashlib.md5(open(csv, 'rb').read()).hexdigest())"
    )
    r = subprocess.run([str(py), "-I", "-c", code, str(csv),
                        str(JA_USERDIC / "user.dict"), str(JA_USERDIC / "userdict.md5")])
    if r.returncode != 0:
        fail("日语用户词典编译失败")
    print("[payload] 日语用户词典已预编译")


def main() -> int:
    ap = argparse.ArgumentParser(description="准备 GPT-SoVITS Fabric 的引擎负载")
    ap.add_argument("--upstream", help="上游 GPT-SoVITS 源码树")
    ap.add_argument("--check", action="store_true", help="只校验，不改文件")
    ap.add_argument("--runtime", help="Runtime 目录；给了就预编译日语用户词典")
    ap.add_argument("--versions", action="store_true", help="只按随包上游源码重写版本表")
    ap.add_argument(
        "--allow-pin-drift",
        action="store_true",
        help="允许上游 commit 与 UPSTREAM_PIN 不一致（只在核对完 worker 之后用）",
    )
    args = ap.parse_args()

    if args.runtime:
        compile_ja_userdict(Path(args.runtime))
    if args.versions:
        write_version_table()
        return 0

    if args.check:
        problems = check_resources()
        for p in problems:
            print(f"[payload] {p}", file=sys.stderr)
        if problems:
            return 1
        print("[payload] 校验通过：负载顶层条目与 resources 一一对上")
        return 0

    up = find_upstream(args.upstream)
    commit = upstream_commit(up)
    if commit and not commit.startswith(UPSTREAM_PIN) and not UPSTREAM_PIN.startswith(commit):
        msg = (
            f"上游停在 {commit}，而 UPSTREAM_PIN 是 {UPSTREAM_PIN}。\n"
            "  worker 的契约是对着 pin 那个版本逐行核过的。要升上游，\n"
            "  先重核 synth_worker / train_worker 再改 pin，别反过来。\n"
            "  确实核过了就加 --allow-pin-drift。"
        )
        if not args.allow_pin_drift:
            fail(msg)
        print(f"[payload] 警告：{msg}", file=sys.stderr)

    print(f"[payload] 上游：{up}（{commit or '非 git 目录'}）")
    vendor(up)
    n = scrub()
    if n:
        print(f"[payload] 清掉 {n} 个缓存/字节码条目")
    write_meta(up, commit)
    write_version_table()

    problems = check_resources()
    for p in problems:
        print(f"[payload] {p}", file=sys.stderr)
    if problems:
        return 1
    print("[payload] 完成：负载顶层条目与 resources 一一对上")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
