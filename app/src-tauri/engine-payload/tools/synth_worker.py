# -*- coding: utf-8 -*-
"""GPT-SoVITS Fabric 常驻合成 worker（原型）。

设计对齐 RVC-Fabric 的 sts_worker.py --resident 模式：
- 由 Rust 端 spawn，stdin/stdout 行协议（JSON 一行一条），模型常驻显存跨批复用；
- 直接 import GPT_SoVITS.TTS_infer_pack.TTS，不经 api_v2 的 HTTP 层，
  避免端口占用与防火墙弹窗；
- 流式合成按分片回传（写临时 wav 分片 + base64 可选），首包时间单独上报。

行协议（worker 输出）：
    {"event":"ready", "version":..., "device":...}
    {"event":"chunk", "job":"<id>", "seq":n, "path":"...", "b64":null}
    {"event":"done",  "job":"<id>", "t_first_ms":n, "t_total_ms":n, "out":"..."}
    {"event":"error", "job":"<id>", "message":"..."}

请求（stdin，一行一条）：
    {"cmd":"load",   "role_id":..., "sovits":"...", "gpt":"...", "version":"v2ProPlus"}
    {"cmd":"refs",   "role_id":..., "list_path":"dataset/xxx.list"}     # 解析 .list
    {"cmd":"synth",  "job":"<id>", "text":"...",
     "ref_wav":"...", "ref_text":"...", "ref_lang":"ZH",
     "params":{"speed":1.0,"top_k":15,"top_p":1.0,"temperature":1.0,
               "repetition_penalty":1.35},
     "streaming":true, "out_dir":"..."}
    {"cmd":"unload", "role_id":...}
    {"cmd":"quit"}

显存管理：LRU 缓存已加载角色（默认上限 2 个），超限自动卸载最久未用者；
单角色加载失败不拖垮进程，error 行后继续接受后续命令。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def emit(**kw) -> None:
    """向 stdout 输出一行 JSON 并立即刷新；Rust 端逐行解析。"""
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_list(path: str) -> list[dict]:
    """解析 .list 标注文件：音频路径|说话人|语种|文本。路径相对包根由调用方处理。"""
    rows: list[dict] = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|", 3)
        if len(parts) != 4:
            continue
        rows.append({"wav": parts[0], "speaker": parts[1], "lang": parts[2], "text": parts[3]})
    return rows


class SynthEngine:
    """TTS_infer_pack 的薄封装。真实推理逻辑在 M1 接通；本原型先跑通协议与生命周期。"""

    def __init__(self, lru_size: int = 2) -> None:
        self.lru_size = lru_size
        self._loaded: dict[str, dict] = {}
        self._order: list[str] = []
        self._tts = None  # TTS 实例，M1 接入

    def load(self, role_id: str, sovits: str, gpt: str, version: str) -> None:
        if role_id in self._loaded:
            self._touch(role_id)
            emit(event="ready", role=role_id, cached=True)
            return
        # M1: 在此初始化 TTS(config)，热切换 set_gpt_weights / set_sovits_weights。
        # 显存不足时按 LRU 先卸载最久未用角色再重试一次。
        while len(self._loaded) >= self.lru_size:
            self.unload(self._order[0])
        self._loaded[role_id] = {
            "sovits": sovits,
            "gpt": gpt,
            "version": version,
            "loaded_at": time.time(),
        }
        self._touch(role_id)
        emit(event="ready", role=role_id, cached=False)

    def unload(self, role_id: str) -> None:
        if role_id in self._loaded:
            del self._loaded[role_id]
        if role_id in self._order:
            self._order.remove(role_id)

    def _touch(self, role_id: str) -> None:
        if role_id in self._order:
            self._order.remove(role_id)
        self._order.append(role_id)

    def synth(self, req: dict) -> None:
        job = req.get("job", "")
        t0 = time.perf_counter()
        text = (req.get("text") or "").strip()
        if not text:
            emit(event="error", job=job, message="empty text")
            return
        params = req.get("params") or {}
        streaming = bool(req.get("streaming", True))
        # 演示实现：按语义长度估算分片数并写出空占位分片，验证协议与取消链路。
        # M1 替换为 self._tts.run(...) 的生成器消费循环。
        n_chunks = max(1, min(8, len(text) // 24 + 1))
        out_dir = Path(req.get("out_dir") or ".")
        first_ms = None
        for seq in range(n_chunks):
            chunk = out_dir / f"{job}.part{seq}.wav"
            chunk.parent.mkdir(parents=True, exist_ok=True)
            chunk.write_bytes(b"")  # 占位
            if seq == 0:
                first_ms = int((time.perf_counter() - t0) * 1000)
            if not streaming and seq + 1 < n_chunks:
                continue
            emit(event="chunk", job=job, seq=seq, path=str(chunk))
        out = out_dir / f"{job}.wav"
        out.write_bytes(b"")
        emit(
            event="done",
            job=job,
            t_first_ms=first_ms,
            t_total_ms=int((time.perf_counter() - t0) * 1000),
            out=str(out),
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="GPT-SoVITS Fabric resident synth worker")
    ap.add_argument("--resident", action="store_true", help="常驻模式（Rust 托管时固定传入）")
    ap.add_argument("--lru", type=int, default=2, help="同时驻留的角色数量上限")
    args = ap.parse_args()

    engine = SynthEngine(lru_size=args.lru)
    emit(event="ready", role=None, protocol=1)

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
            try:
                engine.load(req["role_id"], req["sovits"], req["gpt"], req.get("version", "v2ProPlus"))
            except Exception as exc:  # noqa: BLE001 —— 单角色失败不得拖垮进程
                emit(event="error", job=req.get("role_id"), message=str(exc))
        elif cmd == "synth":
            try:
                engine.synth(req)
            except Exception as exc:  # noqa: BLE001
                emit(event="error", job=req.get("job"), message=str(exc))
        elif cmd == "refs":
            rows = parse_list(req["list_path"])
            emit(event="refs", role=req.get("role_id"), rows=rows)
        elif cmd == "unload":
            engine.unload(req.get("role_id"))
            emit(event="unloaded", role=req.get("role_id"))
        elif cmd == "quit":
            emit(event="bye")
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
