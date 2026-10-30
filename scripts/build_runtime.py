# -*- coding: utf-8 -*-
"""构建 Runtime（nvidia / cpu）。

产物是一个 `Runtime/` 目录和它的 tar 包，tar 根下就是 `Runtime/python.exe`，
`extract.rs` 按这个布局解压。

Python 用 nuget 上的官方 `python` 包（python.org 同一份构建），不用嵌入版：
嵌入版没有 `include/` 与 `libs/`，triton-windows 在运行期编译内核时要用这两样，
缺了会在第一次推理时才报错。

依赖清单按上游 `requirements-py312-win-flash_attention/` 的 cu128 清单改写，
放在 `scripts/runtime/` 下，各变体一份。上游那份是它在 Windows 上实测过的组合，
不要自行放宽版本。

用法::

    python scripts/build_runtime.py --variant nvidia
    python scripts/build_runtime.py --variant cpu --out data/runtime-build
    python scripts/build_runtime.py --variant nvidia --no-pack   # 只装不打包
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REQ_DIR = REPO / "scripts" / "runtime"

PYTHON_VERSION = "3.12.10"
PYTHON_URL = f"https://www.nuget.org/api/v2/package/python/{PYTHON_VERSION}"

TORCH_VERSION = "2.7.1"

#: 每个变体：torch 的 wheel 源、torch 版本后缀、依赖清单。
VARIANTS = {
    "nvidia": {
        "torch_index": "https://mirrors.nju.edu.cn/pytorch/whl/cu128",
        "torch_suffix": "+cu128",
        "requirements": "requirements_nvidia.txt",
    },
    "cpu": {
        "torch_index": "https://mirrors.nju.edu.cn/pytorch/whl/cpu",
        "torch_suffix": "+cpu",
        "requirements": "requirements_cpu.txt",
    },
}

#: ffmpeg / ffprobe 放进 Runtime 根：上游 `tools/portable_runtime.py` 按
#: `Runtime/ffmpeg.exe` 找（合成变速），训练数据读取走 PATH 上的 `ffmpeg`，
#: 而 worker 的 PATH 第一项就是 Runtime。
FFMPEG_FILES = ("ffmpeg.exe", "ffprobe.exe")

#: g2p_en（英文注音）导入时会去 GitHub 拉这几份 NLTK 数据，没网就整段英文失败。
#: 构建时下好放进 `Runtime/nltk_data`，上游 `portable_runtime.activate` 把
#: NLTK_DATA 指到这里。不用 `nltk.download()`：它的防 SSRF 检查会把代理软件的
#: 保留地址（198.18.x）当成攻击拒掉，所以按 nltk_data 仓库的固定布局直接下。
NLTK_BASE = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages"
NLTK_PACKAGES = (
    ("taggers", "averaged_perceptron_tagger"),
    ("taggers", "averaged_perceptron_tagger_eng"),
    ("corpora", "cmudict"),
)

#: pyopenjtalk 的词典。名字与地址照 pyopenjtalk/__init__.py 里的写法。
JTALK_DIC_NAME = "open_jtalk_dic_utf_8-1.11"
JTALK_DIC_URL = f"https://github.com/r9y9/open_jtalk/releases/download/v1.11.1/{JTALK_DIC_NAME}.tar.gz"

#: 打包时剔除：缓存与字节码每台机器不同。torch/lib 下的 .lib 是给编译
#: C++ 扩展链接用的静态库（800 多 MB），运行与 triton 编内核都用不到。
PACK_EXCLUDE_NAMES = {"__pycache__"}
PACK_EXCLUDE_SUFFIX = {".pyc", ".pyo"}
PACK_EXCLUDE_LIB_DIR = ("torch", "lib")


def log(msg: str) -> None:
    print(f"[runtime] {msg}", flush=True)


def run(cmd: list[str], label: str) -> None:
    log(f"{label}：{' '.join(cmd)}")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise SystemExit(f"[runtime] {label} 失败（退出码 {r.returncode}）")


def fetch_python(cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    pkg = cache / f"python-{PYTHON_VERSION}.nupkg"
    if not pkg.is_file():
        log(f"下载 Python {PYTHON_VERSION}")
        tmp = pkg.with_suffix(".part")
        urllib.request.urlretrieve(PYTHON_URL, tmp)
        tmp.replace(pkg)
    return pkg


def unpack_python(pkg: Path, runtime: Path) -> None:
    """nupkg 是 zip，解释器在 `tools/` 下。整个铺到 `Runtime/`。"""
    if runtime.exists():
        shutil.rmtree(runtime)
    runtime.mkdir(parents=True)
    with zipfile.ZipFile(pkg) as z:
        for info in z.infolist():
            if not info.filename.startswith("tools/") or info.is_dir():
                continue
            rel = info.filename[len("tools/"):]
            dest = runtime / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, dest.open("wb") as dst:
                shutil.copyfileobj(src, dst)
    if not (runtime / "python.exe").is_file():
        raise SystemExit("[runtime] nupkg 里没有 tools/python.exe")


def copy_ffmpeg(src_dir: Path, runtime: Path) -> None:
    for name in FFMPEG_FILES:
        src = src_dir / name
        if not src.is_file():
            raise SystemExit(f"[runtime] 缺 {src}；用 --ffmpeg-dir 指到含 ffmpeg.exe 与 ffprobe.exe 的目录")
        shutil.copy2(src, runtime / name)
    log(f"ffmpeg ← {src_dir}")


def fetch_nltk(runtime: Path) -> None:
    for category, name in NLTK_PACKAGES:
        dest = runtime / "nltk_data" / category
        dest.mkdir(parents=True, exist_ok=True)
        archive = dest / f"{name}.zip"
        download(f"{NLTK_BASE}/{category}/{name}.zip", archive, f" NLTK {category}/{name}")
        # 新版 nltk 读解压后的目录，旧接口认 zip；两样都留。
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)


def fetch_jtalk_dic(runtime: Path, cache: Path) -> None:
    """pyopenjtalk 第一次注音时才去 GitHub 下它的词典（22 MB）解进自己的包目录。
    用户机器上这一步常常连不上，表现为日语合成卡几分钟后失败，所以构建时放好。"""
    pkg = runtime / "Lib" / "site-packages" / "pyopenjtalk"
    if (pkg / JTALK_DIC_NAME).is_dir():
        return
    archive = cache / f"{JTALK_DIC_NAME}.tar.gz"
    download(JTALK_DIC_URL, archive, "日语词典")
    with tarfile.open(archive) as tf:
        tf.extractall(pkg, filter="data")


def download(url: str, dest: Path, label: str, tries: int = 4) -> None:
    if dest.is_file():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    for i in range(1, tries + 1):
        try:
            log(f"下载{label}（第 {i} 次）")
            urllib.request.urlretrieve(url, tmp)
            tmp.replace(dest)
            return
        except OSError as e:
            log(f"{label}下载失败：{e}")
    raise SystemExit(f"[runtime] {label}下载失败：{url}")


def pip(py: Path, *args: str) -> list[str]:
    # -I：不读用户目录下的 site-packages 和环境变量，装进去的只有 Runtime 自己的东西。
    return [str(py), "-I", "-m", "pip", "--isolated", "--disable-pip-version-check", *args]


def install(runtime: Path, variant: str, cache: Path) -> None:
    spec = VARIANTS[variant]
    py = runtime / "python.exe"
    run([str(py), "-I", "-m", "ensurepip", "--upgrade"], "装 pip")
    suffix = spec["torch_suffix"]
    run(
        pip(py, "install", "--no-warn-script-location",
            f"torch=={TORCH_VERSION}{suffix}", f"torchaudio=={TORCH_VERSION}{suffix}",
            "--index-url", spec["torch_index"]),
        "装 torch",
    )
    run(
        pip(py, "install", "--no-warn-script-location", "-r", str(REQ_DIR / spec["requirements"])),
        "装依赖",
    )
    run([str(py), "-I", "-c",
         "import torch, torchaudio, transformers, librosa, funasr; print(torch.__version__)"],
        "导入自检")
    fetch_jtalk_dic(runtime, cache)
    run([str(py), "-I", "-c", "import pyopenjtalk; pyopenjtalk.g2p('テスト')"], "日语词典自检")


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pack(runtime: Path, out: Path, variant: str) -> Path:
    # gzip：DLL 能压掉三四成，下载量比解压时间值钱。extract.rs 认 .tar.gz。
    name = f"runtime-{variant}-{date.today():%Y.%m.%d}.tar.gz"
    tar_path = out / name

    def keep(ti: tarfile.TarInfo) -> tarfile.TarInfo | None:
        parts = Path(ti.name).parts
        if any(p in PACK_EXCLUDE_NAMES for p in parts):
            return None
        if Path(ti.name).suffix in PACK_EXCLUDE_SUFFIX:
            return None
        if ti.name.endswith(".lib") and tuple(parts[-3:-1]) == PACK_EXCLUDE_LIB_DIR:
            return None
        return ti

    log(f"打包 {tar_path}")
    with tarfile.open(tar_path, "w:gz", compresslevel=6) as tf:
        tf.add(runtime, arcname="Runtime", filter=keep)
    digest = sha256_of(tar_path)
    (out / f"{name}.sha256").write_text(f"{digest}  {name}\n", encoding="utf-8")
    log(f"完成：{tar_path}（{tar_path.stat().st_size / 1e9:.2f} GB，sha256 {digest}）")
    return tar_path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variant", choices=sorted(VARIANTS), required=True)
    ap.add_argument("--out", default=str(REPO / "data" / "runtime-build"),
                    help="构建目录，Runtime 落在 <out>/<variant>/Runtime")
    ap.add_argument("--ffmpeg-dir", default=str(REPO / "data" / "ffmpeg"),
                    help="含 ffmpeg.exe 与 ffprobe.exe 的目录")
    ap.add_argument("--no-pack", action="store_true", help="只装不打包")
    ap.add_argument("--reuse", action="store_true", help="已有 Runtime 时不重铺 Python，直接补装依赖")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    runtime = out / args.variant / "Runtime"
    if not (args.reuse and (runtime / "python.exe").is_file()):
        unpack_python(fetch_python(out / "cache"), runtime)
    install(runtime, args.variant, out / "cache")
    fetch_nltk(runtime)
    copy_ffmpeg(Path(args.ffmpeg_dir), runtime)
    if not args.no_pack:
        pack(runtime, out / args.variant, args.variant)


if __name__ == "__main__":
    sys.exit(main())
