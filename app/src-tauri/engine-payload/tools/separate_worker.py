# -*- coding: utf-8 -*-
"""人声分离 worker：跑一次 PyMSS，把进度按行吐给 Rust 侧（`src/separate.rs`）。

为什么不直接调 `python -m pymss.cli infer`：它的进度是 tqdm 画在 stderr 上的
进度条，要靠正则去刮，格式一变就瞎。PyMSS 的 separator 本来就收
`progress_callback(done, total, message)`，接上它按行输出 JSON 干净得多。

用法（Rust 侧这么调）::

    Runtime\\pythonw.exe tools/separate_worker.py <请求文件.json>

请求文件::

    {"model": "...", "model_dir": "...", "input": "...", "output": "...",
     "device": "auto", "format": "wav", "aggression": 10}

stdout 每行一条 JSON::

    {"phase":"start"}
    {"phase":"run","done":3,"total":10,"message":"..."}
    {"phase":"done","files":["..."]}
    {"phase":"error","message_code":"sep.failed","message":"...","detail":"..."}

只走 stdout，不掺日志：PyMSS 自己的 logger 走 stderr，Rust 那边单独收进日志
文件，两边不会互相踩。

# 这份和 RVC Fabric 那份的区别

`pymss` / `pymss_core` 两棵树是**逐字节照搬**的第三方代码，一个字都没改 ——
改了将来同步上游修复就得手工对 diff。改的只有这个 worker：

* 不依赖 `tools/msg_codes.py`。那份 345 行、104 个码，这里只用得上四个；
  为四个常量搬一整个模块就是又一次「抄过来没改」。四个码直接写在下面，
  和语言包 `msg.sep.*` 一一对应。
* 不再 try-import `worker_protocol.prepare_headless_windows` —— GSV 的
  `worker_protocol.py` 里没有这个函数，那句 try/except 只是块永远走 except
  的死代码。真需要无窗口时，Rust 侧已经在 spawn 时给了 CREATE_NO_WINDOW。
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path


def setup_sys_path() -> None:
    """让顶层的 ``pymss`` / ``pymss_core`` import 得到。

    Runtime 的 python 带着 ``python39._pth``，不认脚本目录，所以要手动插。
    而且**必须以 ``pymss`` 这个名字导入**，不能走 ``tools.pymss``：同一批文件
    换个包名加载之后，``uvr_lib_v5`` 里的 ``alias_submodules(__name__, …)``
    只认 ``pymss.modules.`` 开头的名字，VR 系模型（HP3/HP4）会在目录加载完
    之后才崩。这条是 RVC 那边踩出来的，照搬过来不要改。
    """
    tools = Path(__file__).resolve().parent
    root = tools.parent
    # tools 在前：`import pymss` / `import pymss_core` 要先命中这里。
    # root 在后：留给还写着 `import tools.xxx` 的地方。
    for p in (root, tools):
        s = str(p)
        if s not in sys.path:
            sys.path.insert(0, s)


setup_sys_path()

#: 与语言包 `msg.sep.*` 一一对应。`message` 是兜底：壳按 code 取不到词时
#: （新码还没进语言包）界面至少有句话。
SEP_NO_REQUEST = ("sep.no_request", "缺请求文件参数")
SEP_BAD_REQUEST = ("sep.bad_request", "无法读取请求文件：{error}")
SEP_EMPTY_FIELDS = ("sep.empty_fields", "模型 / 输入 / 输出 都不能为空")
SEP_FAILED = ("sep.failed", "分离失败，详见日志")

AUDIO_FORMATS = ("wav", "flac", "mp3", "m4a")


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


def fail(code_and_text: tuple[str, str], params: dict | None = None, **extra) -> None:
    code, text = code_and_text
    msg = {"phase": "error", "message_code": code,
           "message": text.format(**params) if params else text}
    if params:
        msg["message_params"] = {k: str(v) for k, v in params.items()}
    msg.update(extra)
    emit(**msg)


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if len(argv) < 2:
        fail(SEP_NO_REQUEST)
        return 2
    try:
        req = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        fail(SEP_BAD_REQUEST, {"error": e})
        return 2

    model = str(req.get("model") or "").strip()
    model_dir = str(req.get("model_dir") or "").strip()
    inp = str(req.get("input") or "").strip()
    out = str(req.get("output") or "").strip()
    device = str(req.get("device") or "auto").strip()
    fmt = str(req.get("format") or "wav").strip().lower()
    if fmt not in AUDIO_FORMATS:
        fmt = "wav"
    try:
        agg = int(req.get("aggression") if req.get("aggression") is not None else 10)
    except (TypeError, ValueError):
        agg = 10
    agg = max(0, min(agg, 20))
    if not (model and inp and out):
        fail(SEP_EMPTY_FIELDS)
        return 2

    # PyMSS 默认把权重放 ~/.cache/pymss；我们要它只认安装目录里的那份，
    # 免得用户 C 盘被悄悄塞几百 MB，也免得离线时它去联网拉。
    if model_dir:
        os.environ["PYMSS_MODEL_DIR"] = model_dir

    emit(phase="start")
    try:
        from pymss.model_registry import create_separator

        last = [-1]

        def on_progress(done, total, message=""):
            # 回调频率很高，同一个百分比不重复发 —— 每行都要过一次 IPC。
            pct = int(done * 100 / total) if total else 0
            if pct == last[0]:
                return
            last[0] = pct
            emit(phase="run", done=int(done), total=int(total or 1),
                 message=str(message or ""))

        with create_separator(
            model,
            model_dir=model_dir or None,
            device=device,
            device_ids=[0],
            output_format=fmt,
            store_dirs=out,
            progress_callback=on_progress,
            inference_params={"aggression": agg},
        ) as sep:
            files = sep.process_folder(inp)
        emit(phase="done", files=[str(f) for f in (files or [])])
        return 0
    except Exception as e:  # noqa: BLE001
        # 原始异常进 stderr（壳会收进日志），界面上只给能翻译的那句。
        traceback.print_exc(file=sys.stderr)
        fail(SEP_FAILED, detail=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
