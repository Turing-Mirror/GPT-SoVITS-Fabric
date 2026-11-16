"""Resident adapter between Fabric's synthesis protocol and gsv.cpp."""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from urllib.request import ProxyHandler, Request, build_opener
import wave

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "GSV_CPP" / "engine"
SHARED = ROOT / "GSV_CPP" / "shared"
SERVER = ENGINE / "bin" / "gsv_server.exe"
HOST = "127.0.0.1"
HTTP = build_opener(ProxyHandler({}))
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class WorkerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def emit(event: str, **values) -> None:
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind((HOST, 0))
        return listener.getsockname()[1]


def request(url: str, token: str, payload: dict | None = None, *, timeout: float) -> bytes:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with HTTP.open(Request(url, data=body, headers=headers), timeout=timeout) as response:
        return response.read()


def wait_ready(url: str, token: str, process: subprocess.Popen, field: str, value, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"{Path(process.args[0]).name} exited with {process.returncode}")
        try:
            if json.loads(request(url + "/health", token, timeout=2)).get(field) == value:
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.15)
    raise TimeoutError(f"The service at {url} did not become ready.")


def terminate(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def identity(paths: tuple[Path, ...]) -> tuple:
    result = []
    for path in paths:
        stat = path.stat()
        result.append((path, stat.st_size, stat.st_mtime_ns))
    return tuple(result)


def wav_details(wav) -> tuple[float, int, int, int]:
    with wave.open(wav, "rb") as data:
        rate = data.getframerate()
        frames = data.getnframes()
        return frames / rate, rate, data.getnchannels(), data.getsampwidth()


class VulkanWorker:
    def __init__(self, folder: Path):
        self.folder = folder
        self.child = None
        self.sidecar = None
        self.model_identity = None
        self.url = ""
        self.device = ""
        self.token = ""

    def close(self) -> None:
        terminate(self.child)
        terminate(self.sidecar)
        self.child = self.sidecar = None
        self.model_identity = None

    def load(self, job: dict) -> None:
        role = job["role_id"]
        files = (Path(job["gpt"]).resolve(), Path(job["sovits"]).resolve())
        g2pw = ROOT / "GPT_SoVITS" / "text" / "G2PWModel"
        langdetect = ROOT / "GPT_SoVITS" / "pretrained_models" / "fast_langdetect"
        if not (g2pw / "g2pW.onnx").is_file() or not (langdetect / "lid.176.bin").is_file():
            raise WorkerError("vulkan_resources_missing", "请先补全推理资源。")
        base = ROOT / "GPT_SoVITS" / "pretrained_models" / "gsv-v5-pretrained" / "s2Gv5turbo.pth"
        model_identity = identity((*files, base))
        if (
            model_identity == self.model_identity
            and self.child is not None and self.child.poll() is None
            and self.sidecar is not None and self.sidecar.poll() is None
        ):
            emit("ready", role=role, cached=True, device=self.device)
            return

        self.close()
        devices = subprocess.run(
            [str(SERVER), "--list-devices"], stdout=subprocess.PIPE, stderr=sys.stderr,
            cwd=SERVER.parent, encoding="utf-8", errors="replace", check=True,
            creationflags=NO_WINDOW, timeout=15,
        )
        choices = re.findall(r"^\s*#(\d+)\s+(GPU|iGPU)\s+Vulkan\d+\b", devices.stdout, re.MULTILINE)
        if not choices:
            raise WorkerError("vulkan_unavailable", "未检测到 Vulkan 显卡。")
        index = next((idx for idx, kind in choices if kind == "GPU"), choices[0][0])
        self.device = f"vulkan:{index}"

        env = dict(os.environ, PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
                   HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
        prepare = subprocess.run(
            [sys.executable, "-u", "-B", str(ROOT / "tools" / "gsv_cpp_prepare.py"),
             "--gpt", str(files[0]), "--sovits", str(files[1]), "--cache", job["gsv_cache"],
             "--workspace", str(self.folder)],
            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=sys.stderr, encoding="utf-8",
            creationflags=NO_WINDOW,
        )
        if prepare.returncode != 0:
            raise WorkerError("vulkan_model_failed", "无法准备此角色的 Vulkan 模型。")
        models = Path(prepare.stdout.strip())
        source_manifest = models / "voices" / "default" / "manifest.json"
        if not source_manifest.is_file():
            raise WorkerError("vulkan_model_failed", "无法准备此角色的 Vulkan 模型。")
        # v0.1.3 reads Windows argv in the ANSI code page. Keep path arguments
        # relative and pass the absolute model paths through the UTF-8 manifest.
        local_manifest = self.folder / "models" / "voices" / "default" / "manifest.json"
        local_manifest.parent.mkdir(parents=True, exist_ok=True)
        local_manifest.write_bytes(source_manifest.read_bytes())

        env.update({
            "PYTHONPATH": str(ENGINE / "deps"),
            "GSV_G2PW_MODEL": str(g2pw),
            "GSV_BERT_DIR": str(SHARED / "bert_tokenizer"),
            "GSV_FAST_LANGDETECT": str(langdetect),
            "NLTK_DATA": str(Path(sys.executable).parent / "nltk_data"),
        })
        parent = str(os.getpid())
        side_port, engine_port = free_port(), free_port()
        while engine_port == side_port:
            engine_port = free_port()
        self.token = secrets.token_urlsafe(24)
        self.url = f"http://{HOST}:{engine_port}"
        self.sidecar = subprocess.Popen(
            [sys.executable, "-u", "-B", str(ENGINE / "tools" / "text_sidecar.py"),
             "--host", HOST, "--port", str(side_port), "--parent-pid", parent],
            cwd=self.folder, env=env, stdout=sys.stderr, stderr=sys.stderr,
            creationflags=NO_WINDOW,
        )
        self.child = subprocess.Popen(
            [str(SERVER), "--models", "models", "--device", self.device,
             "--host", HOST, "--port", str(engine_port), "--token", self.token,
             "--sidecar", f"{HOST}:{side_port}", "--allow-path", ".",
             "--log-dir", "logs", "--parent-pid", parent],
            cwd=self.folder, stdout=sys.stderr, stderr=sys.stderr,
            creationflags=NO_WINDOW,
        )
        wait_ready(f"http://{HOST}:{side_port}", "", self.sidecar, "ready", True, 100)
        wait_ready(self.url, self.token, self.child, "engine", "ready", 100)
        self.model_identity = model_identity
        emit("ready", role=role, cached=False, device=self.device)

    def synth(self, job: dict) -> None:
        if self.child is None or self.child.poll() is not None:
            raise WorkerError("vulkan_unavailable", "Vulkan 引擎未就绪。")
        start = time.perf_counter()
        reference = self.folder / "reference.wav"
        ffmpeg = Path(sys.executable).parent / "ffmpeg.exe"
        if not ffmpeg.is_file():
            ffmpeg = ROOT / "ffmpeg.exe"
        try:
            subprocess.run(
                [str(ffmpeg), "-hide_banner", "-v", "error", "-y", "-i", job["ref_wav"],
                 "-vn", "-ac", "1", "-c:a", "pcm_s16le", str(reference)],
                cwd=self.folder, stdout=sys.stderr, stderr=sys.stderr, check=True,
                creationflags=NO_WINDOW, timeout=30,
            )
            duration, _, _, _ = wav_details(str(reference))
        except (OSError, subprocess.SubprocessError, wave.Error) as exc:
            raise WorkerError("vulkan_reference_failed", "无法读取参考音频。") from exc
        if not 3 <= duration <= 10:
            raise WorkerError("ref_length", "参考音频时长不在 3–10 秒内。")

        params = job.get("params", {})
        payload = {
            "text": job["text"], "text_lang": str(params.get("text_lang") or "auto").lower(),
            "ref_audio_path": reference.name, "prompt_text": job["ref_text"],
            "prompt_lang": str(job.get("ref_lang") or "zh").lower(),
            "speed_factor": params.get("speed", 1.0),
            "media_type": "wav", "stream": False,
        }
        for key in ("top_k", "top_p", "temperature", "repetition_penalty", "fragment_interval", "seed"):
            if params.get(key) is not None:
                payload[key] = params[key]
        payload["text_split_method"] = params.get("text_split_method") or (
            "cut5" if len(job["text"]) > 100 else "cut1"
        )
        if params.get("sample_steps") not in (None, ""):
            payload["sample_steps"] = params["sample_steps"]
        data = request(self.url + "/tts", self.token, payload, timeout=290)
        seconds, rate, channels, width = wav_details(io.BytesIO(data))
        if seconds <= 0 or (rate, channels, width) != (48000, 1, 2):
            raise ValueError("Unexpected output from gsv.cpp")

        out = Path(job["out_dir"]) / f"{job['job']}.wav"
        partial = out.with_suffix(".wav.part")
        stop = job.get("stop_file")
        try:
            partial.write_bytes(data)
            if stop and Path(stop).exists():
                raise WorkerError("cancelled", "已取消。")
            partial.replace(out)
        finally:
            partial.unlink(missing_ok=True)
        elapsed = round((time.perf_counter() - start) * 1000)
        emit("done", job=job["job"], out=str(out), t_first_ms=elapsed,
             t_total_ms=elapsed, audio_sec=round(seconds, 2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resident", action="store_true")
    parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="gsv-cpp-") as temporary:
        worker = VulkanWorker(Path(temporary))
        try:
            emit("ready", role=None, protocol=2)
            for line in sys.stdin:
                job = {}
                try:
                    job = json.loads(line)
                    match job["cmd"]:
                        case "load":
                            worker.load(job)
                        case "synth":
                            worker.synth(job)
                        case "quit":
                            break
                except Exception as exc:
                    traceback.print_exc(file=sys.stderr)
                    loading = job.get("cmd") == "load"
                    if loading:
                        worker.close()
                    code = "vulkan_unavailable" if loading else "vulkan_synth_failed"
                    message = "Vulkan 引擎未就绪。" if loading else "Vulkan 合成失败。"
                    if isinstance(exc, WorkerError):
                        code, message = exc.code, str(exc)
                    emit("error", job=job.get("job") or job.get("role_id"), code=code,
                         message_code=f"synth.{code}", message=message)
        finally:
            worker.close()


if __name__ == "__main__":
    main()
