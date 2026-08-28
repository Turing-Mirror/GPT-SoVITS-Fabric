# -*- coding: utf-8 -*-
"""GPT-SoVITS Fabric 训练 worker。

由 Rust 端（`src/train.rs`）一次性 spawn，参数走一个 JSON 文件而不是命令行 ——
数据集路径里有中文和空格是常态。stdout 一行一条 JSON，格式与 `train.rs` 的
`note_progress` 一一对应::

    {"phase":"start"}
    {"phase":"env", "device":"cuda", "version":"v2ProPlus", ...}
    {"phase":"stage",      "stage":"prepare|format|sovits|gpt",
                           "done":n, "total":n,
                           "message_code":"train.xxx", "message_params":{...},
                           "message":"（兜底原文，语言包里没登记时才显示）"}
    {"phase":"checkpoint", "stage":"sovits|gpt", "epoch":n, "path":"..."}
    {"phase":"done",  "weights":{...}}
    {"phase":"error", "message_code":"train.xxx", "message_params":{...}}

文案一律走 ``message_code``（对应语言包 ``msg.train.*``），壳侧按用户当前语言取
词。``message`` 只是兜底：新加的 code 还没进语言包时，界面至少有句英文可看，
而不是一片空白。

用法::

    Runtime\\python.exe tools/train_worker.py <request.json>

# 四个阶段

1. ``prepare`` 数据集工具链。**只在数据集里没有 ``.list`` 时才做事**：
   角色包的约定格式（``docs/DECISIONS.md`` D4）本来就带 ``<id>.list``，
   那种情况直接用。没有的话切片，然后转写；转写模型（faster-whisper /
   funasr）不随引擎发，缺了就明确报「去标注窗口自己打标」，不是静默跳过。
2. ``format`` 训练集格式化。上游 ``GPT_SoVITS/prepare_datasets`` 的三步，
   env 驱动、逐个子进程跑。产物落 ``logs/<exp>/``。
3. ``sovits`` s2 微调（``GPT_SoVITS/s2_train.py``）。
4. ``gpt`` s1 微调（``GPT_SoVITS/s1_train.py``）。

# 为什么是子进程而不是 import

上游那几个脚本是 env 驱动的顶层脚本，不是可复用的函数；而且训练本身随时可能
OOM 或者被上游的 C 扩展直接拖死整个解释器。开子进程一是照着上游 webui 的用法
走（少踩一层坑），二是崩了只崩那一步，worker 还能把 ``error`` 发出去 ——
不然壳那边只看到管道断了，报「退出码 -1」，用户什么都不知道。

# 配置模板从引擎树里读，不写死

s2 的 json 和 s1 的 yaml 从 ``GPT_SoVITS/configs/`` 读出来再改几个键。上游换过
几次字段名，写死一份迟早对不上；读模板的话，我们只负责改自己关心的那几个，
其余原样。模板不在就明确报缺文件，不猜。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# 安装根：payload/GPT_SoVITS/… 与 payload/tools/… 是兄弟。
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PRETRAINED = "pretrained_models"

#: 各版本的 s2 底模。路径与 `engine_assets.rs` 的 `engine_core_files` 对齐 ——
#: 两边必须是同一套约定，不然「预检说齐了、训练说缺」。
S2_PRETRAINED = {
    "v2ProPlus": (f"{PRETRAINED}/v2ProPlus/s2Gv2ProPlus.pth",
                  f"{PRETRAINED}/v2ProPlus/s2Dv2ProPlus.pth"),
    "v2Pro": (f"{PRETRAINED}/v2Pro/s2Gv2Pro.pth",
              f"{PRETRAINED}/v2Pro/s2Dv2Pro.pth"),
    "v2": (f"{PRETRAINED}/gsv-v2final-pretrained/s2G2333k.pth",
           f"{PRETRAINED}/gsv-v2final-pretrained/s2D2333k.pth"),
}

#: GPT 底模。v3/v4/v2Pro/v2ProPlus 共用 s1v3（catalog-src/base-models 的说明）。
S1_PRETRAINED = f"{PRETRAINED}/s1v3.ckpt"

CNHUBERT_DIR = f"{PRETRAINED}/chinese-hubert-base"
BERT_DIR = f"{PRETRAINED}/chinese-roberta-wwm-ext-large"
#: v2Pro 系列的说话人验证嵌入。随 v2proplus 包一起发；不在就不传，
#: 上游会走没有 sv 的分支。
SV_PATH = f"{PRETRAINED}/sv/pretrained_eres2netv2w24s4ep4.ckpt"

STAGES = ("prepare", "format", "sovits", "gpt")

AUDIO_EXT = (".wav", ".flac", ".mp3", ".m4a", ".ogg", ".opus", ".aac", ".wma")


# ---------------------------------------------------------------------------
# 协议
# ---------------------------------------------------------------------------

def emit(**kw) -> None:
    line = json.dumps(kw, ensure_ascii=False) + "\n"
    try:
        sys.stdout.write(line)
        sys.stdout.flush()
    except (OSError, UnicodeEncodeError):
        try:
            sys.stdout.buffer.write(line.encode("utf-8", errors="replace"))
            sys.stdout.buffer.flush()
        except Exception:
            pass


def say(stage: str, code: str, fallback: str, *, done=None, total=None, **params) -> None:
    """一条进度。`code` 对应语言包 msg.train.<code>，`fallback` 是兜底原文。

    `done` / `total` 既是进度条的分子分母，也自动进 `message_params` —— 「第 3 /
    20 轮」这类文案要用到它们，而在调用处再写一遍 `total=…` 会和这里的具名参数
    撞名。
    """
    msg = {"phase": "stage", "stage": stage,
           "message_code": f"train.{code}", "message": fallback}
    if done is not None:
        msg["done"] = done
        params.setdefault("done", str(done))
    if total is not None:
        msg["total"] = total
        params.setdefault("total", str(total))
    if params:
        msg["message_params"] = params
    emit(**msg)


class Fail(Exception):
    """能翻译的失败。壳侧按 code 取词，params 填空。"""

    def __init__(self, code: str, fallback: str, **params) -> None:
        super().__init__(fallback)
        self.code = f"train.{code}"
        self.fallback = fallback
        self.params = params


def _ensure_stdio_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 请求
# ---------------------------------------------------------------------------

def normalize(raw: dict) -> dict:
    """请求字段与 `train.rs` 的 `TrainReq` 一一对应。

    这里再钳一次范围不是多余：壳那边已经在 `preflight` 里判过，但 worker 也可能
    被人手工调起来（排障时就是这么用的），钳一下比训到一半才发现参数离谱好。
    """
    exp = str(raw.get("exp") or "").strip()
    if not exp:
        raise Fail("name_invalid", "experiment name is empty")
    version = str(raw.get("version") or "v2ProPlus")
    if version not in S2_PRETRAINED:
        raise Fail("bad_version", f"unsupported version: {version}", version=version)
    return {
        "exp": exp,
        "dataset": str(raw.get("dataset") or ""),
        "version": version,
        "total_epoch": max(1, min(200, int(raw.get("total_epoch") or 24))),
        "batch_size": max(1, min(64, int(raw.get("batch_size") or 8))),
        "learning_rate": float(raw.get("learning_rate") or 1e-4),
        "save_every": max(1, int(raw.get("save_every") or 5)),
        "device": str(raw.get("device") or "cpu"),
        "is_half": bool(raw.get("is_half")),
        "resume": bool(raw.get("resume")),
        "output_dir": str(raw.get("output_dir") or ""),
    }


def need(rel: str, code: str, fallback: str, **params) -> Path:
    p = ROOT / rel
    if not p.exists():
        raise Fail(code, fallback, **params)
    return p


# ---------------------------------------------------------------------------
# 跑子进程
# ---------------------------------------------------------------------------

def _no_window() -> dict:
    """Windows 上别弹黑框。训练要开十来个子进程，弹十来次没法看。"""
    if os.name != "nt":
        return {}
    return {"creationflags": 0x08000000}  # CREATE_NO_WINDOW


import re

#: 上游两个训练脚本报轮数的写法。s2 是自己 print 的 `====> Epoch: 12`；
#: s1 走 lightning，进度条上是 `Epoch 11:`（0 基，所以要加一）。
EPOCH_PATTERNS = (
    (re.compile(r"====>\s*Epoch:\s*(\d+)"), 0),
    (re.compile(r"\bEpoch\s+(\d+)\s*[:/]"), 1),
)


def _epoch_of(line: str) -> int | None:
    for pat, offset in EPOCH_PATTERNS:
        m = pat.search(line)
        if m:
            try:
                return int(m.group(1)) + offset
            except ValueError:
                return None
    return None


def run_step(argv: list[str], env: dict, *, stage: str, label: str,
             total_epoch: int = 0) -> None:
    """跑一个上游脚本。失败时把最后几行 stderr 带上来。

    不带 stderr 的话，用户看到的是「该步骤失败（退出码 1）」—— 一句等于没说的
    话。上游的报错本身通常是有用的（缺文件、显存不够、标注格式不对）。

    `total_epoch` 给了的话，顺带从上游的输出里抠轮数往上报。**这一条不是锦上
    添花**：两段微调各要跑几个小时，不报轮数的话进度条从头到尾停在 0，用户
    分不出「在训」和「卡死了」，也没法判断关掉软件明天还能不能接着跑。
    """
    proc = subprocess.Popen(
        argv,
        cwd=str(ROOT),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        **_no_window(),
    )
    tail: list[str] = []
    last_epoch = -1
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        # 上游自己的输出原样转到 stderr，壳把 stderr 直接落进日志文件 ——
        # 排障时那份日志就是全部现场。stdout 是协议，不能混。
        print(line, file=sys.stderr)
        tail.append(line)
        if len(tail) > 40:
            del tail[0]
        if total_epoch:
            n = _epoch_of(line)
            # 只在轮数真的往前走时报一次。lightning 的进度条一秒刷几十行，
            # 逐行报等于把管道刷爆，壳那边光解析 JSON 就吃掉一个核。
            if n is not None and n > last_epoch:
                last_epoch = n
                say(stage, "epoch", f"epoch {n} / {total_epoch}",
                    done=min(n, total_epoch), total=total_epoch, epoch=str(n))
    code = proc.wait()
    if code != 0:
        joined = "\n".join(tail[-8:])
        if _looks_like_oom(joined):
            raise Fail("oom", "out of memory", batch=str(_CURRENT.get("batch_size", "")))
        raise Fail("step_failed", f"{label} failed (exit {code})\n{joined}",
                   step=label, code=str(code))


def _looks_like_oom(text: str) -> bool:
    low = text.lower()
    return "out of memory" in low or "cuda oom" in low or "outofmemoryerror" in low


#: 当前请求。只给报错时填参数用（比如 OOM 要报当前批大小）。
_CURRENT: dict = {}


def base_env(req: dict) -> dict:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ROOT), env.get("PYTHONPATH", "")]
    ).rstrip(os.pathsep)
    env["PYTHONIOENCODING"] = "utf-8"
    env["is_half"] = "True" if req["is_half"] else "False"
    # 上游一律读这个变量决定用哪张卡；CPU 上传空串（它据此走 cpu 分支）。
    env["_CUDA_VISIBLE_DEVICES"] = "0" if req["device"] == "cuda" else ""
    env["i_part"] = "0"
    env["all_parts"] = "1"
    return env


# ---------------------------------------------------------------------------
# 阶段 1：数据集工具链
# ---------------------------------------------------------------------------

def find_list(dataset: Path) -> Path | None:
    """数据集里现成的标注文件。角色包按 D4 的约定本来就带一份。"""
    if dataset.is_file() and dataset.suffix.lower() == ".list":
        return dataset
    if not dataset.is_dir():
        return None
    lists = sorted(dataset.rglob("*.list"))
    return lists[0] if lists else None


def audio_files(dataset: Path) -> list[Path]:
    if not dataset.is_dir():
        return []
    return sorted(
        p for p in dataset.rglob("*")
        if p.is_file() and p.suffix.lower() in AUDIO_EXT
    )


def stage_prepare(req: dict, opt_dir: Path) -> Path:
    """产出（或直接沿用）标注文件 `.list`。

    **这一阶段大多数时候什么都不做。** 从广场装来的角色包、以及在标注窗口里
    校对过的数据集，都已经带着 `.list` 了 —— 那才是正常路径。切片和转写是给
    「用户扔进来一堆原始音频」准备的兜底。
    """
    dataset = Path(req["dataset"])
    existing = find_list(dataset)
    if existing is not None:
        rows = parse_list(existing)
        if not rows:
            raise Fail("list_empty", f"{existing.name} has no usable lines",
                       name=existing.name)
        say("prepare", "skip_prepare", "using the existing annotation file",
            done=1, total=1, name=existing.name, count=str(len(rows)))
        return existing

    files = audio_files(dataset)
    if not files:
        raise Fail("dataset_missing", f"no audio under {dataset}", path=str(dataset))

    slicer = ROOT / "tools" / "slice_audio.py"
    if not slicer.is_file():
        raise Fail("no_slicer", "tools/slice_audio.py is missing")

    sliced = opt_dir / "sliced"
    sliced.mkdir(parents=True, exist_ok=True)
    say("prepare", "slicing", "slicing the source audio", done=0, total=len(files))
    env = base_env(req)
    for i, f in enumerate(files):
        run_step(
            [sys.executable, str(slicer), str(f), str(sliced),
             "-34", "4000", "300", "10", "500", "0.9", "0.25", "0", "1"],
            env, stage="prepare", label="slice_audio",
        )
        say("prepare", "slicing", "slicing the source audio",
            done=i + 1, total=len(files))

    asr = _pick_asr()
    if asr is None:
        # 转写模型不随引擎发。与其静默产出一个空标注、让后面三个阶段跑出一个
        # 废模型，不如在这里停住并告诉用户下一步该点哪儿。
        raise Fail(
            "no_asr",
            "no ASR model is installed; label the slices in the annotation window",
            path=str(sliced),
        )
    say("prepare", "transcribing", "transcribing the slices")
    out_list = opt_dir / f"{req['exp']}.list"
    run_step(
        [sys.executable, str(asr), "-i", str(sliced), "-o", str(opt_dir),
         "-s", "large-v3", "-l", "auto", "-p", "float16" if req["is_half"] else "float32"],
        env, stage="prepare", label="asr",
    )
    produced = find_list(opt_dir)
    if produced is None:
        raise Fail("no_transcript", "the ASR step produced no .list file")
    if produced != out_list:
        shutil.move(str(produced), str(out_list))
    return out_list


def _pick_asr() -> Path | None:
    for rel in ("tools/asr/fasterwhisper_asr.py", "tools/asr/funasr_asr.py"):
        p = ROOT / rel
        if p.is_file():
            return p
    return None


def parse_list(path: Path) -> list[dict]:
    """`音频路径|说话人|语种|文本`。与 synth_worker.parse_list 同一套解析。"""
    rows: list[dict] = []
    base = path.parent
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|", 3)
        if len(parts) != 4:
            continue
        rows.append({"wav": parts[0], "speaker": parts[1],
                     "lang": parts[2], "text": parts[3],
                     "abs": str((base / parts[0]).resolve())})
    return rows


# ---------------------------------------------------------------------------
# 阶段 2：训练集格式化
# ---------------------------------------------------------------------------

#: 上游 prepare_datasets 的三步与各自的产物。产物名与 `train.rs` 的
#: `STAGE_ARTIFACTS` 必须对齐 —— 那张表是清理判据，对不上就是删错东西。
FORMAT_STEPS = (
    ("1-get-text.py", "2-name2text.txt"),
    ("2-get-hubert-wav32k.py", "5-wav32k"),
    ("3-get-semantic.py", "6-name2semantic.tsv"),
)


def stage_format(req: dict, list_path: Path, opt_dir: Path) -> None:
    rows = parse_list(list_path)
    if not rows:
        raise Fail("list_empty", f"{list_path.name} has no usable lines",
                   name=list_path.name)
    missing = [r for r in rows if not Path(r["abs"]).is_file()][:5]
    if missing:
        raise Fail("wav_missing", f"annotation points at a missing file: {missing[0]['wav']}",
                   name=missing[0]["wav"])

    env = base_env(req)
    env["inp_text"] = str(list_path)
    env["inp_wav_dir"] = str(list_path.parent)
    env["exp_name"] = req["exp"]
    env["opt_dir"] = str(opt_dir)
    env["bert_pretrained_dir"] = str(need(
        BERT_DIR, "bert_missing", "the BERT base model is missing"))
    env["cnhubert_base_dir"] = str(need(
        CNHUBERT_DIR, "hubert_missing", "the cnhubert base model is missing"))
    g_rel, _ = S2_PRETRAINED[req["version"]]
    env["pretrained_s2G"] = str(need(
        g_rel, "pretrained_missing",
        f"the {req['version']} base model is missing", version=req["version"]))
    env["s2config_path"] = str(need(
        "GPT_SoVITS/configs/s2.json", "config_missing",
        "GPT_SoVITS/configs/s2.json is missing", name="s2.json"))
    env["version"] = req["version"]
    sv = ROOT / SV_PATH
    if sv.is_file():
        env["sv_path"] = str(sv)

    total = len(FORMAT_STEPS)
    for i, (script, artifact) in enumerate(FORMAT_STEPS):
        # 续跑：产物在就跳过。格式化一步动辄十几分钟，重跑一遍纯属白等。
        if req["resume"] and (opt_dir / artifact).exists():
            say("format", "skip_step", "reusing the existing artifact",
                done=i + 1, total=total, name=artifact)
            continue
        say("format", "formatting", "building the training set",
            done=i, total=total, name=script)
        path = need(f"GPT_SoVITS/prepare_datasets/{script}",
                    "script_missing", f"{script} is missing", name=script)
        run_step([sys.executable, str(path)], env, stage="format", label=script)
        if not (opt_dir / artifact).exists():
            raise Fail("no_artifact", f"{script} produced no {artifact}",
                       name=artifact, step=script)
    say("format", "formatted", "the training set is ready", done=total, total=total)


# ---------------------------------------------------------------------------
# 阶段 3 / 4：两段微调
# ---------------------------------------------------------------------------

def stage_sovits(req: dict, opt_dir: Path, weights_dir: Path) -> None:
    tmpl = need("GPT_SoVITS/configs/s2.json", "config_missing",
                "GPT_SoVITS/configs/s2.json is missing", name="s2.json")
    cfg = json.loads(tmpl.read_text(encoding="utf-8"))
    g_rel, d_rel = S2_PRETRAINED[req["version"]]

    # 只改我们关心的那几个键，其余原样从模板带过来 —— 上游换过几次字段名，
    # 写死一整份 config 迟早对不上。
    cfg.setdefault("train", {})
    cfg["train"].update({
        "batch_size": req["batch_size"],
        "epochs": req["total_epoch"],
        "learning_rate": req["learning_rate"],
        "save_every_epoch": req["save_every"],
        "if_save_latest": True,
        "if_save_every_weights": True,
        "pretrained_s2G": str(need(g_rel, "pretrained_missing",
                                   f"the {req['version']} base model is missing",
                                   version=req["version"])),
        "pretrained_s2D": str(need(d_rel, "pretrained_missing",
                                   f"the {req['version']} base model is missing",
                                   version=req["version"])),
        "gpu_numbers": "0" if req["device"] == "cuda" else "",
        "fp16_run": req["is_half"],
    })
    cfg.setdefault("data", {})["exp_dir"] = str(opt_dir)
    cfg["s2_ckpt_dir"] = str(opt_dir)
    cfg["save_weight_dir"] = str(weights_dir)
    cfg["name"] = req["exp"]
    cfg["version"] = req["version"]
    cfg.setdefault("model", {})["version"] = req["version"]

    tmp = opt_dir / "s2_config.json"
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    script = need("GPT_SoVITS/s2_train.py", "script_missing",
                  "GPT_SoVITS/s2_train.py is missing", name="s2_train.py")
    say("sovits", "sovits_started", "fine-tuning SoVITS", done=0, total=req["total_epoch"])
    run_step([sys.executable, str(script), "--config", str(tmp)],
             base_env(req), stage="sovits", label="s2_train",
             total_epoch=req["total_epoch"])
    _report_ckpts("sovits", opt_dir / "logs_s2")
    say("sovits", "sovits_done", "SoVITS fine-tuning finished",
        done=req["total_epoch"], total=req["total_epoch"])


def stage_gpt(req: dict, opt_dir: Path, weights_dir: Path) -> None:
    import yaml  # 上游自己就依赖 pyyaml；缺了说明 Runtime 不完整

    name = "s1longer-v2.yaml" if req["version"] != "v1" else "s1longer.yaml"
    tmpl = need(f"GPT_SoVITS/configs/{name}", "config_missing",
                f"GPT_SoVITS/configs/{name} is missing", name=name)
    cfg = yaml.safe_load(tmpl.read_text(encoding="utf-8")) or {}

    cfg.setdefault("train", {})
    cfg["train"].update({
        "batch_size": req["batch_size"],
        "epochs": req["total_epoch"],
        "save_every_n_epoch": req["save_every"],
        "if_save_latest": True,
        "if_save_every_weights": True,
        "exp_name": req["exp"],
        "precision": "16-mixed" if req["is_half"] else "32",
    })
    cfg["train_semantic_path"] = str(opt_dir / "6-name2semantic.tsv")
    cfg["train_phoneme_path"] = str(opt_dir / "2-name2text.txt")
    cfg["output_dir"] = str(opt_dir / "logs_s1")
    cfg["pretrained_s1"] = str(need(S1_PRETRAINED, "pretrained_missing",
                                    "the GPT base model s1v3.ckpt is missing",
                                    version="s1v3"))
    cfg.setdefault("data", {})["max_eval_sample"] = cfg.get("data", {}).get(
        "max_eval_sample", 8)

    tmp = opt_dir / "s1_config.yaml"
    tmp.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                   encoding="utf-8")

    env = base_env(req)
    # 上游 s1 侧读这两个：权重落点与语义 token 的帧率。
    env["hz"] = "25hz"
    env["SoVITS_weight_root"] = str(weights_dir)
    env["GPT_weight_root"] = str(weights_dir)

    script = need("GPT_SoVITS/s1_train.py", "script_missing",
                  "GPT_SoVITS/s1_train.py is missing", name="s1_train.py")
    say("gpt", "gpt_started", "fine-tuning GPT", done=0, total=req["total_epoch"])
    run_step([sys.executable, str(script), "--config_file", str(tmp)],
             env, stage="gpt", label="s1_train",
             total_epoch=req["total_epoch"])
    _report_ckpts("gpt", opt_dir / "logs_s1")
    say("gpt", "gpt_done", "GPT fine-tuning finished",
        done=req["total_epoch"], total=req["total_epoch"])


def _report_ckpts(stage: str, d: Path) -> None:
    """把这一段落下的检查点报给壳。断点续跑要靠它判断走到哪了。"""
    if not d.is_dir():
        return
    for p in sorted(d.rglob("*")):
        if p.is_file() and p.suffix in (".pth", ".ckpt"):
            emit(phase="checkpoint", stage=stage, path=str(p),
                 bytes=p.stat().st_size)


# ---------------------------------------------------------------------------
# 收尾：把两个权重拼成一个角色
# ---------------------------------------------------------------------------

def collect(req: dict, weights_dir: Path) -> dict:
    """挑出这次训练的 SoVITS 与 GPT 权重。

    上游按 `<exp>_eN_sM.pth` / `.ckpt` 落一堆，最后一轮那个才是要的。按修改
    时间挑而不是按文件名里的轮数 —— 续跑时轮数会从头再来一遍，时间不会。
    """
    def newest(exts: tuple[str, ...]) -> Path | None:
        cands = [p for p in weights_dir.rglob("*")
                 if p.is_file() and p.suffix in exts and req["exp"] in p.name]
        return max(cands, key=lambda p: p.stat().st_mtime) if cands else None

    sovits = newest((".pth",))
    gpt = newest((".ckpt",))
    if sovits is None or gpt is None:
        raise Fail("no_weight", "training finished but the weights are missing",
                   name="SoVITS/GPT")
    return {"sovits": str(sovits), "gpt": str(gpt)}


# ---------------------------------------------------------------------------

def main() -> int:
    _ensure_stdio_utf8()
    if len(sys.argv) < 2:
        emit(phase="error", message_code="train.usage",
             message="usage: train_worker.py <request.json>")
        return 2
    try:
        raw = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        emit(phase="error", message_code="train.bad_request",
             message=f"cannot read the request file: {exc}",
             message_params={"error": str(exc)})
        return 2

    try:
        req = normalize(raw)
    except Fail as f:
        emit(phase="error", message_code=f.code, message=f.fallback,
             message_params=f.params)
        return 1
    _CURRENT.update(req)

    exp_dir = ROOT / "logs" / req["exp"]
    exp_dir.mkdir(parents=True, exist_ok=True)
    weights_dir = Path(req["output_dir"]) if req["output_dir"] else (
        ROOT / "User_Data" / "models")
    weights_dir.mkdir(parents=True, exist_ok=True)

    emit(phase="start")
    emit(phase="env", device=req["device"], version=req["version"],
         is_half=req["is_half"], exp_dir=str(exp_dir),
         weights_dir=str(weights_dir), python=sys.version.split()[0])

    started = time.time()
    try:
        list_path = stage_prepare(req, exp_dir)
        stage_format(req, list_path, exp_dir)
        stage_sovits(req, exp_dir, weights_dir)
        stage_gpt(req, exp_dir, weights_dir)
        weights = collect(req, weights_dir)
    except Fail as f:
        emit(phase="error", message_code=f.code, message=f.fallback,
             message_params=f.params)
        return 1
    except KeyboardInterrupt:
        emit(phase="error", message_code="train.cancelled", message="cancelled")
        return 1
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        emit(phase="error", message_code="train.train_failed",
             message=str(exc), message_params={"code": "1", "log": "logs"})
        return 1

    emit(phase="done", weights=weights, seconds=round(time.time() - started, 1))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        emit(phase="error", message_code="train.train_failed", message=str(e))
        raise SystemExit(1)
