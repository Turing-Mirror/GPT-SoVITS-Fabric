# -*- coding: utf-8 -*-
"""GPT-SoVITS Fabric 常驻合成 worker。

由 Rust 端 spawn，stdin/stdout 行协议（JSON 一行一条），模型常驻显存跨批复用。
直接 import GPT_SoVITS.TTS_infer_pack.TTS，不经 api_v2 的 HTTP 层，
避免端口占用与防火墙弹窗（docs/DECISIONS.md D2）。

用法::

    Runtime\\pythonw.exe tools/synth_worker.py --resident --lru 2

请求（stdin，一行一条）::

    {"cmd":"load",   "role_id":"...", "sovits":"...", "gpt":"...", "version":"v2ProPlus",
     "cnhubert":"<目录>", "bert":"<目录>", "main_gpu":-1}
    {"cmd":"synth",  "job":"<id>", "text":"...",
     "ref_wav":"...", "ref_text":"...", "ref_lang":"ZH",
     "params":{"speed":1.0,"top_k":15,"top_p":1.0,"temperature":1.0,
               "repetition_penalty":1.35},
     "streaming":true, "out_dir":"...",
     "cnhubert":"...", "bert":"..."}
    {"cmd":"unload", "role_id":"..."}
    {"cmd":"quit"}

stdout 每行一条 JSON::

    {"event":"ready",    "role":"<id>", "cached":bool, "device":"..."}
    {"event":"chunk",    "job":"<id>", "seq":n, "path":"...", "sec":12.3}
    {"event":"done",     "job":"<id>", "t_first_ms":n, "t_total_ms":n, "out":"...", "sec":12.3}
    {"event":"error",    "job":"<id>", "message":"...", "code":"oom|cancelled|..."}
    {"event":"unloaded", "role":"<id>"}
    {"event":"bye"}

取消：Rust 往 `stop_file` 写任意内容，worker 在分片间隙看到即停 —— 长分片
静默期也能秒停，因为上游 `TTS.stop()` 会打断当前句的生成循环。

显存管理：上游 TTS 类同一时刻只持一套权重，所以「常驻」的粒度是角色级热切换：
load 同一角色直接复用；load 不同角色 = `init_vits_weights` / `init_t2s_weights`
热切换（旧权重随之释放）；显存不足（OOM）时先 `empty_cache()` 再重试一次，
仍失败才报错。

**上游接口的四个坑，改之前先看这里**（对照 GPT-SoVITS @ 48b1a01）：

1. 换权重的方法叫 `init_vits_weights` / `init_t2s_weights`。
   `set_sovits_weights` / `set_gpt_weights` 是 `api_v2.py` 的 **HTTP 路由名**，
   `TTS` 类上没有这两个方法 —— 而 D2 定的就是不走 api_v2。
2. `TTS_Config()` 的默认值是 `device="cpu"` / `is_half=False`，构造完不设就
   永远是 CPU + float32。上游全靠 `self.configs.device` 与
   `self.configs.is_half` 决定权重搬到哪、要不要半精度（TTS.py 465/480-490/
   583-607/671 行）。
3. 属性名是 `cnhuhbert_base_path`（上游自己多打了一个 h）和 `bert_base_path`。
   写成 `cnhubert_base_path` / `bert_path` 只会给对象挂两个没人读的新属性，
   真路径仍停在相对 cwd 的上游布局。两者都要**目录**，不是权重文件 ——
   底下走的是 `HubertModel.from_pretrained()` / `AutoTokenizer.from_pretrained()`。
4. `TTS(cfg)` **构造时就加载权重**：`_init_models` 会读
   `cfg.t2s_weights_path` / `cfg.vits_weights_path`（TTS.py 467-473）。这两个
   默认值指向 `GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/` 的 v2 底模，
   我们没随包发 —— 不覆盖的话 `TTS()` 当场 FileNotFoundError，根本走不到
   换角色权重那一步。所以构造时直接填角色的 gpt/sovits 路径，让它一步到位。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import wave
from pathlib import Path

# GPT_SoVITS 源码树随引擎载荷分发在安装根（payload/GPT_SoVITS/...），
# 把根插进 sys.path，`import GPT_SoVITS` 才能解析。
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 两个都是 **目录**：上游 `CNHubert.__init__` 走 `HubertModel.from_pretrained`，
# BERT 走 `AutoTokenizer/AutoModelForMaskedLM.from_pretrained`，指到具体权重
# 文件上会当场报错。路径是上游布局：底模统一装在 `GPT_SoVITS/pretrained_models/`
# 下（sv.py / vocoder / g2pw 的 model_source 全都写死了这个前缀，放别处上游
# 看不见）。engine_assets.rs 的 engine_core_files 与这里必须对齐。
DEFAULT_CNHUBERT = "GPT_SoVITS/pretrained_models/chinese-hubert-base"
DEFAULT_BERT = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"


def emit(**kw) -> None:
    # 与 sep/train worker 同一套约定：code 是机器码（壳拿它认 cancelled），
    # message_code 喂 i18n（msg.synth.<code>，壳侧 t_worker_msg 翻译，语言包
    # 没登记的码回退到 message 原文）。
    if "code" in kw and "message_code" not in kw:
        kw["message_code"] = f"synth.{kw['code']}"
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


def _ensure_stdio_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def parse_list(path: str) -> list[dict]:
    """解析 .list 标注文件：音频路径|说话人|语种|文本。路径相对 .list 所在目录。"""
    rows: list[dict] = []
    base = Path(path).parent
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|", 3)
        if len(parts) != 4:
            continue
        rows.append(
            {
                "wav": parts[0],
                "speaker": parts[1],
                "lang": parts[2],
                "text": parts[3],
                "abs": str(base / parts[0]),
            }
        )
    return rows


def _is_oom(exc: BaseException) -> bool:
    low = f"{type(exc).__module__}.{type(exc).__name__}".lower()
    if "outofmemory" in low:
        return True
    return "out of memory" in str(exc).lower() or "cuda oom" in low


class SynthEngine:
    """TTS_infer_pack.TTS 的薄封装：角色热切换 + OOM 退避 + 分片回传。"""

    def __init__(self, lru_size: int = 2) -> None:
        self.lru_size = max(1, lru_size)
        self._tts = None
        self._config = None
        self._current: str | None = None
        self._loaded: set[str] = set()
        self._order: list[str] = []
        self._stop_file: Path | None = None

    # ---- 生命周期 -------------------------------------------------------

    @staticmethod
    def _pick_device(main_gpu: int):
        """选算力后端。cuda → mps → cpu，半精度只在 cuda 上开。

        `main_gpu` 来自设置里的「主显卡」（-1 = 自动）。它是 CUDA 序号，
        越界就退回 0 —— 越界直接崩掉不如换一张能用的卡。
        """
        try:
            import torch
        except Exception:
            return "cpu", False
        if torch.cuda.is_available():
            n = torch.cuda.device_count()
            idx = main_gpu if isinstance(main_gpu, int) and 0 <= main_gpu < n else 0
            return f"cuda:{idx}", True
        mps = getattr(getattr(torch, "backends", None), "mps", None)
        if mps is not None and mps.is_available():
            # 上游在 mps 上没有半精度路径，硬开会出 NaN。
            return "mps", False
        return "cpu", False

    def _abs(self, rel: str) -> str:
        return str(ROOT / rel) if not Path(rel).is_absolute() else rel

    def _ensure_tts(self, req: dict) -> bool:
        """起引擎。**返回 True 表示这次是新建的** —— `TTS(cfg)` 构造时就按
        cfg 里的权重路径做了 `_init_models`，角色权重已经在里面了，调用方
        不必再 swap 一遍。"""
        if self._tts is not None:
            return False
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        cnhubert = str(req.get("cnhubert") or "") or DEFAULT_CNHUBERT
        bert = str(req.get("bert") or "") or DEFAULT_BERT
        try:
            main_gpu = int(req.get("main_gpu", -1))
        except (TypeError, ValueError):
            main_gpu = -1
        device, is_half = self._pick_device(main_gpu)

        cfg = TTS_Config()
        # 版本照角色包来：TTS_Config() 恒为 v2，而 update_version 同时会
        # 切换 languages 白名单（v1 没有 yue/ko）。init_vits_weights 之后还会
        # 按检查点形状再认一次版本，这里只是把起点摆正。
        version = str(req.get("version") or "").strip()
        if version in ("v1", "v2", "v3", "v4", "v2Pro", "v2ProPlus"):
            cfg.update_version(version)
        # 底模路径显式覆盖：TTS_Config 的默认值指上游仓库布局，我们按
        # engine_assets 的安装路径来。属性名照上游写（cnhuhbert 的多余 h 是
        # 上游的拼写，不是笔误）。
        cfg.cnhuhbert_base_path = self._abs(cnhubert)
        cfg.bert_base_path = self._abs(bert)
        # 不设这两个就永远是 CPU + float32 —— 装了 6GB 的 N 卡运行时也一样。
        cfg.device = device
        cfg.is_half = is_half
        # TTS() 构造时就把这两份读进来（坑 4）：填角色自己的权重，让默认底模
        # 那份不存在的路径永远不被碰。
        sovits = str(req.get("sovits") or "").strip()
        gpt = str(req.get("gpt") or "").strip()
        if sovits:
            cfg.vits_weights_path = self._abs(sovits)
        if gpt:
            cfg.t2s_weights_path = self._abs(gpt)
        cfg.update_configs()

        # g2pw 分词器的 model_source 读 env bert_path，缺省落回上游相对路径
        # —— 那恰好转到这里装的同一目录，但写死成绝对路径更不容易被 cwd 坑。
        import os

        os.environ.setdefault("bert_path", self._abs(bert))

        self._config = cfg
        self._tts = TTS(cfg)
        return True

    def _swap_weights(self, sovits: str, gpt: str) -> None:
        """换成目标角色的两份权重。

        方法名是 `init_vits_weights` / `init_t2s_weights`；`set_sovits_weights`
        / `set_gpt_weights` 只存在于 api_v2 的 HTTP 层，`TTS` 类上没有。
        版本不用我们告诉它：`init_vits_weights` 会从检查点里的
        `enc_p.text_embedding.weight` 形状自己认（TTS.py 505-522）。
        """
        self._tts.init_vits_weights(sovits)
        self._tts.init_t2s_weights(gpt)

    def _free_memory(self) -> None:
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def _stopped(self) -> bool:
        return self._stop_file is not None and self._stop_file.exists()

    # ---- 命令 -----------------------------------------------------------

    def load(self, req: dict) -> None:
        role_id = str(req.get("role_id") or "")
        sovits = str(req.get("sovits") or "").strip()
        gpt = str(req.get("gpt") or "").strip()
        if not role_id or not sovits or not gpt:
            emit(event="error", job=role_id, message="load 缺参数", code="bad_request")
            return
        self._stop_file = Path(str(req.get("stop_file"))) if req.get("stop_file") else None

        if role_id == self._current:
            self._touch(role_id)
            emit(event="ready", role=role_id, cached=True, device=str(getattr(self._config, "device", "")))
            return

        def _load() -> None:
            """新建 = TTS(cfg) 构造时按角色权重初始化；已建 = 热切换。"""
            if not self._ensure_tts(req):
                self._swap_weights(sovits, gpt)

        try:
            _load()
        except Exception as exc:  # noqa: BLE001
            if _is_oom(exc):
                self._free_memory()
                try:
                    # 构造失败的 TTS() 不会留在 self._tts 上，重试仍是新建路径。
                    _load()
                except Exception as exc2:  # noqa: BLE001
                    emit(event="error", job=role_id, message="显存不足",
                         code="oom", detail=str(exc2))
                    return
            else:
                code = "init_failed" if self._tts is None else "load_failed"
                emit(event="error", job=role_id,
                     message="引擎初始化失败" if code == "init_failed" else "模型加载失败",
                     code=code, detail=str(exc))
                return

        self._current = role_id
        self._loaded.add(role_id)
        self._touch(role_id)
        while len(self._order) > self.lru_size:
            self._order.pop(0)
        emit(event="ready", role=role_id, cached=False, device=str(getattr(self._config, "device", "")))

    def unload(self, role_id: str) -> None:
        self._loaded.discard(role_id)
        if role_id in self._order:
            self._order.remove(role_id)
        if role_id == self._current:
            self._current = None
        self._free_memory()
        emit(event="unloaded", role=role_id)

    def synth(self, req: dict) -> None:
        job = str(req.get("job") or "")
        t0 = time.perf_counter()
        text = str(req.get("text") or "").strip()
        if not text:
            emit(event="error", job=job, message="文本为空", code="bad_request")
            return
        if self._tts is None or self._current is None:
            emit(event="error", job=job, message="尚未加载角色", code="not_loaded")
            return
        self._stop_file = Path(str(req.get("stop_file"))) if req.get("stop_file") else self._stop_file

        params = req.get("params") or {}
        streaming = bool(req.get("streaming", True))
        out_dir = Path(str(req.get("out_dir") or "."))
        out_dir.mkdir(parents=True, exist_ok=True)
        final = out_dir / f"{job}.wav"

        request = {
            "text": text,
            "text_lang": "auto",
            "ref_audio_path": str(req.get("ref_wav") or ""),
            "prompt_text": str(req.get("ref_text") or ""),
            "prompt_lang": str(req.get("ref_lang") or "zh").lower() or "zh",
            "top_k": int(params.get("top_k", 15)),
            "top_p": float(params.get("top_p", 1.0)),
            "temperature": float(params.get("temperature", 1.0)),
            "repetition_penalty": float(params.get("repetition_penalty", 1.35)),
            "speed_factor": float(params.get("speed", 1.0)),
            "streaming_mode": bool(streaming),
            "seed": -1,
            "parallel_infer": True,
            # 切句方式。上游默认 "cut1"（按标点凑四句），长文本会切得很粗；
            # 超过一屏就换成 "cut5"（逐标点切），首片来得更快也更好取消。
            # 取值见上游 text_segmentation_method.py，写别的名字会被它拒。
            "text_split_method": "cut5" if len(text) > 100 else "cut1",
            "aux_ref_audio_paths": [],
        }
        # 注：不要往这里塞 media_type / split_sentence —— `run()` 的入参表里
        # 没有这两个键，塞了会被静默丢弃，看着像生效了其实没有。

        first_ms = None
        seq = 0
        frames: list[bytes] = []
        sr = None
        cancelled = False
        try:
            gen = self._tts.run(request)
            # 上游每个 yield 都是 `(sr, audio)` —— 采样率在前，int16 的 numpy
            # 数组在后（TTS.py 1173/1477/1497 行都是 `yield output_sr, np.zeros(...)`）。
            # 反过来解包的话，bytes() 会拿到一个 int，int() 会拿到整段音频。
            for chunk_sr, chunk in gen:
                if first_ms is None:
                    first_ms = int((time.perf_counter() - t0) * 1000)
                sr = int(chunk_sr)
                frames.append(bytes(chunk))
                part = out_dir / f"{job}.part{seq}.wav"
                _write_wav(part, [bytes(chunk)], sr)
                emit(event="chunk", job=job, seq=seq, path=str(part), sec=round(time.perf_counter() - t0, 2))
                seq += 1
                if self._stopped():
                    cancelled = True
                    try:
                        self._tts.stop()
                    except Exception:
                        pass
                    break
        except Exception as exc:  # noqa: BLE001
            if _is_oom(exc):
                self._free_memory()
                emit(event="error", job=job, message="显存不足", code="oom", detail=str(exc))
            else:
                emit(event="error", job=job, message="合成失败", code="synth_failed", detail=str(exc))
            return

        if cancelled:
            emit(event="error", job=job, message="已取消", code="cancelled")
            return
        if not frames or sr is None:
            emit(event="error", job=job, message="没有产出任何音频", code="empty")
            return

        _write_wav(final, frames, sr)
        emit(
            event="done",
            job=job,
            t_first_ms=first_ms,
            t_total_ms=int((time.perf_counter() - t0) * 1000),
            out=str(final),
            sec=round(time.perf_counter() - t0, 2),
        )


def _write_wav(path: Path, chunks: list[bytes], sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sr))
        for c in chunks:
            wf.writeframes(c)


def main() -> int:
    _ensure_stdio_utf8()
    ap = argparse.ArgumentParser(description="GPT-SoVITS Fabric resident synth worker")
    ap.add_argument("--resident", action="store_true", help="常驻模式（Rust 托管时固定传入）")
    ap.add_argument("--lru", type=int, default=2, help="角色 LRU 记忆上限（上游单实例，见类注释）")
    args = ap.parse_args()

    engine = SynthEngine(lru_size=args.lru)
    emit(event="ready", role=None, protocol=2, root=str(ROOT))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            emit(event="error", job=None, message=f"bad json: {exc}")
            continue
        cmd = req.get("cmd")
        if cmd == "load":
            engine.load(req)
        elif cmd == "synth":
            engine.synth(req)
        elif cmd == "refs":
            try:
                rows = parse_list(req["list_path"])
                emit(event="refs", role=req.get("role_id"), rows=rows)
            except Exception as exc:  # noqa: BLE001
                emit(event="error", job=req.get("role_id"), message=str(exc))
        elif cmd == "unload":
            engine.unload(str(req.get("role_id") or ""))
        elif cmd == "quit":
            emit(event="bye")
            return 0
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        emit(event="error", job=None, message=str(e))
        raise SystemExit(1)
