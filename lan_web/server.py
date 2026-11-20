from __future__ import annotations

import argparse
import copy
import asyncio
import hashlib
import io
import ipaddress
import json
import math
import os
import platform
import re
import shutil
import signal
import stat
import statistics
import subprocess
import tempfile
import threading
import time
import uuid
import unicodedata
import urllib.parse
import urllib.request
import wave
import zipfile
from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask
import uvicorn


ROOT = Path(os.environ.get("FABRIC_ROOT", Path.cwd())).resolve()
FRONTEND = Path(os.environ.get("FABRIC_FRONTEND", Path(__file__).resolve().parents[1] / "app/frontend-lan")).resolve()
USER_DATA = ROOT / "User_Data"
CHARACTERS = USER_DATA / "characters"
TRAIN_ROOT = USER_DATA / "train"
OUTPUTS = USER_DATA / "outputs"
CONFIG_FILE = USER_DATA / "lan_web_config.json"


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")



class EventHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = threading.Lock()

    async def add(self, ws: WebSocket) -> None:
        await ws.accept()
        with self._lock:
            self._clients.add(ws)

    def remove(self, ws: WebSocket) -> None:
        with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, event: str, payload: Any) -> None:
        message = json.dumps({"event": event, "payload": payload}, ensure_ascii=False)
        with self._lock:
            clients = list(self._clients)
        for ws in clients:
            try:
                await ws.send_text(message)
            except Exception:
                self.remove(ws)

    def broadcast_threadsafe(self, event: str, payload: Any) -> None:
        loop = getattr(app.state, "loop", None)
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(self.broadcast(event, payload), loop)


hub = EventHub()


@asynccontextmanager
async def lifespan(application: FastAPI):
    # uvicorn.run creates its own loop; a loop obtained before run is never driven.
    application.state.loop = asyncio.get_running_loop()
    try:
        yield
    finally:
        application.state.loop = None


app = FastAPI(title="GPT-SoVITS Fabric LAN Web", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.state.allowed_origins = frozenset({"http://127.0.0.1:8790", "http://localhost:8790"})


class InvokeRequest(BaseModel):
    command: str
    args: dict[str, Any] = {}


jobs_lock = threading.Lock()
config_lock = threading.Lock()
annotation_lock = threading.Lock()
synth_lock = threading.Lock()
train_jobs: dict[str, dict[str, Any]] = {}
train_processes: dict[str, subprocess.Popen[str]] = {}


def _parse_list(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for index, raw in enumerate(path.read_text(encoding="utf-8-sig", errors="replace").splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        parts = raw.split("|", 3)
        if len(parts) != 4:
            continue
        wav, speaker, lang, text = parts
        audio = Path(wav)
        if not audio.is_absolute():
            audio = path.parent / audio
        rows.append({
            "line": index,
            "wav": wav,
            "speaker": speaker,
            "lang": lang.lower(),
            "text": text,
            "abs": str(audio),
            "exists": audio.is_file(),
            "issues": [] if audio.is_file() else ["missing_audio"],
        })
    return rows


def _role_rows(role_dir: Path, config: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for entry in config.get("lists", []) or []:
        rel = entry.get("file", "") if isinstance(entry, dict) else ""
        list_path = role_dir / rel
        rows.extend(_parse_list(list_path))
    return rows


def _characters() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if not CHARACTERS.is_dir():
        return result
    for role_dir in sorted(CHARACTERS.iterdir()):
        if role_dir.name.startswith("."):
            continue
        cfg_path = role_dir / "config.json"
        if not cfg_path.is_file():
            continue
        cfg = _read_json(cfg_path, {})
        if not isinstance(cfg, dict):
            continue
        lists = []
        for entry in cfg.get("lists", []) or []:
            rel = entry.get("file", "") if isinstance(entry, dict) else ""
            lists.append({
                "file": rel,
                "lang": (entry.get("lang", "zh") if isinstance(entry, dict) else "zh"),
                "note": "",
                "rows": _parse_list(role_dir / rel),
            })
        result.append({
            "id": cfg.get("id", role_dir.name),
            "name": cfg.get("name", role_dir.name),
            "author": cfg.get("author", ""),
            "version": cfg.get("version", "v5turbo"),
            "cover": cfg.get("cover", ""),
            "cover_exists": bool(cfg.get("cover") and (role_dir / cfg["cover"]).is_file()),
            "dir": str(role_dir),
            "params": cfg.get("params", {}),
            "lists": lists,
        })
    return result


def _asset_ready() -> tuple[bool, list[str]]:
    # v5turbo LAN mode only requires the resources actually used by Turbo.
    required = [
        ROOT / "GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5turbo.pth",
        ROOT / "GPT_SoVITS/pretrained_models/s1v3.ckpt",
        ROOT / "GPT_SoVITS/pretrained_models/chinese-hubert-base/pytorch_model.bin",
        ROOT / "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/pytorch_model.bin",
        ROOT / "GPT_SoVITS/text/G2PWModel/g2pW.onnx",
    ]
    missing = [str(p.relative_to(ROOT)) for p in required if not p.is_file()]
    return not missing, missing


def _config() -> dict[str, Any]:
    cfg = _read_json(CONFIG_FILE, {})
    cfg.setdefault("ui_locale", "zh-CN")
    cfg.setdefault("ui_locale_picked", True)
    cfg.setdefault("setup_guide_done", True)
    cfg.setdefault("onboard_dismiss", True)
    cfg.setdefault("main_gpu", 0)
    return cfg


AUDIO_EXTENSIONS = {".wav", ".flac"}
STAGE_ARTIFACTS = {
    "2-name2text.txt", "3-bert", "4-cnhubert", "5-wav32k", "6-name2semantic.tsv", "7-sv_cn",
}


def _linked(info: os.stat_result) -> bool:
    # On Windows, directory junctions and other reparse points are not all symlinks.
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def _tree_files(path: Path) -> Iterator[tuple[Path, os.stat_result]]:
    """Enumerate regular files, not linked directories or their external targets."""
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            info = current.lstat()
            if _linked(info):
                continue
            if stat.S_ISREG(info.st_mode):
                yield current, info
            elif stat.S_ISDIR(info.st_mode):
                stack.extend(current.iterdir())
        except FileNotFoundError:
            # A rotating log or cache file can disappear during a scan.
            continue


def _storage_usage() -> dict[str, Any]:
    ROOT.stat()  # A missing Runtime root is not an empty installation.
    names = ("characters", "training", "outputs", "runtime", "pretrained", "separation", "cache", "other")
    prefixes = {
        "characters": ("User_Data/characters",),
        "training": ("User_Data/train", "User_Data/train_inputs", "logs"),
        "outputs": ("User_Data/outputs", "User_Data/synth", "User_Data/api", "User_Data/separate"),
        "runtime": ("Runtime", "User_Data/runtimes"),
        "pretrained": ("GPT_SoVITS/pretrained_models", "GPT_SoVITS/text/G2PWModel"),
        "separation": ("tools/uvr5/uvr5_weights",),
        "cache": ("TEMP", "User_Data/cache", "User_Data/update_cache", "User_Data/cover_cache", "User_Data/ch-banner", "User_Data/lan_community_cache"),
    }
    by_root = {tuple(Path(p).parts): name for name, paths in prefixes.items() for p in paths}
    sizes = dict.fromkeys(names, 0)
    for path, info in _tree_files(ROOT):
        parts = path.relative_to(ROOT).parts
        # Root-relative categories never overlap. Each file is visited once.
        category = next((by_root[parts[:depth]] for depth in (3, 2, 1) if parts[:depth] in by_root), "other")
        sizes[category] += info.st_size
    return {
        "items": [{"name": n, "bytes": sizes[n]} for n in names if sizes[n]],
        "total_bytes": sum(sizes.values()),
        "free_bytes": shutil.disk_usage(ROOT).free,
        # Cache deletion is not enabled for the LAN adapter.
        "vulkan_cache_bytes": 0,
    }


def _train_cleanup_scan() -> list[dict[str, Any]]:
    if not TRAIN_ROOT.is_dir():
        return []
    rows = []
    for exp in sorted(TRAIN_ROOT.iterdir()):
        if exp.name == "mute" or exp.name.startswith("."):
            continue
        try:
            info = exp.lstat()
            if _linked(info) or not stat.S_ISDIR(info.st_mode):
                continue
            targets = list(exp.iterdir())
        except FileNotFoundError:
            continue
        kinds = {kind: {"files": 0, "bytes": 0} for kind in ("checkpoints", "dataset")}
        for target in targets:
            kind = "dataset" if target.name in STAGE_ARTIFACTS else None
            if kind is None and target.name.startswith(("logs_s1", "logs_s2")) and target.is_dir():
                kind = "checkpoints"
            if kind is None:
                continue
            for _, info in _tree_files(target):
                kinds[kind]["files"] += 1
                kinds[kind]["bytes"] += info.st_size
        total = sum(kind["bytes"] for kind in kinds.values())
        if total:
            rows.append({"exp": exp.name, "total_bytes": total, "kinds": kinds})
    return rows


def _synth_recent(limit: Any) -> list[dict[str, Any]]:
    limit = min(max(limit, 1), 200) if type(limit) is int else 30
    files = sorted(
        ((path, info) for path, info in _tree_files(OUTPUTS) if path.suffix.lower() in AUDIO_EXTENSIONS),
        key=lambda pair: pair[1].st_mtime_ns, reverse=True,
    )
    rows = []
    for path, info in files[:limit]:
        record = _read_json(path.with_suffix(".json"), None)
        if not isinstance(record, dict):
            record = None
        if path.suffix.lower() == ".wav" and not (record or {}).get("audio_sec"):
            try:
                with wave.open(str(path), "rb") as audio:
                    record = {**(record or {}), "audio_sec": audio.getnframes() / audio.getframerate()}
            except (OSError, EOFError, wave.Error):
                pass  # Keep older/exported WAVs visible even if their metadata is unreadable.
        rows.append({"path": str(path), "name": path.name, "mtime": int(info.st_mtime), "record": record})
    return rows


LAN_VERSION = "Fabric LAN Web 0.1.0"


def _gpu_names() -> list[str]:
    # No model load or performance test: only query the driver for card names.
    # Use the system utility, not a binary relative to a user-selected model path.
    if os.name != "nt":
        return []
    program = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/nvidia-smi.exe"
    try:
        result = subprocess.run(
            [str(program), "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3, check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _diagnostic_facts() -> dict[str, Any]:
    runtime = (ROOT / "Runtime/python.exe").is_file()
    worker = (ROOT / "tools/synth_worker.py").is_file()
    train_worker = (ROOT / "tools/train_worker.py").is_file()
    _, assets_missing = _asset_ready()
    try:
        free_bytes = shutil.disk_usage(ROOT).free
    except OSError:
        free_bytes = None
    return {
        "runtime": runtime, "worker": worker, "train_worker": train_worker,
        "assets_missing": assets_missing, "free_bytes": free_bytes,
    }


def _diagnostics_summary() -> str:
    facts = _diagnostic_facts()
    free = facts["free_bytes"]
    gpus = _gpu_names()
    # Shareable text. Do not include local paths, IPs, usernames, logs, or config values.
    return "\n".join([
        LAN_VERSION,
        f"Server OS: {platform.system()} {platform.release()}",
        f"Server Python: {platform.python_version()}",
        f"Fabric Runtime: {'Present' if facts['runtime'] else 'Missing'}",
        f"Synthesis worker: {'Present' if facts['worker'] else 'Missing'}",
        f"Training worker: {'Present' if facts['train_worker'] else 'Missing'}",
        f"Turbo resources: {'Present' if not facts['assets_missing'] else str(len(facts['assets_missing'])) + ' missing'}",
        f"NVIDIA GPU: {', '.join(gpus) if gpus else 'Not detected'}",
        f"Free disk space: {free / 1024**3:.2f} GiB" if free is not None else "Free disk space: Unknown",
    ])


def _diagnostics_self_check() -> list[dict[str, Any]]:
    facts = _diagnostic_facts()
    findings = []
    for key, name, path in (
        ("runtime", "Fabric Runtime", "Runtime/python.exe"),
        ("worker", "Synthesis worker", "tools/synth_worker.py"),
        ("train_worker", "Training worker", "tools/train_worker.py"),
    ):
        if not facts[key]:
            findings.append({"code": f"lan.{key}_missing", "level": "error", "title": f"{name} missing", "evidence": [{"file": path, "text": "Not found"}]})
    if facts["assets_missing"]:
        findings.append({"code": "lan.turbo_resources", "level": "error", "title": "Turbo resources missing", "evidence": [{"file": path, "text": "Not found"} for path in facts["assets_missing"]]})
    free = facts["free_bytes"]
    if free is None or free < 2 * 1024**3:
        findings.append({"code": "lan.disk_space", "level": "warn", "title": "Disk space unavailable or low", "evidence": []})
    return findings


LIST_LIMIT = 2 * 1024 * 1024
LIST_LANGS = {"zh", "ja", "en", "ko", "yue", "all_zh", "all_ja", "all_ko", "auto"}


def _lan_list_roots() -> tuple[Path, ...]:
    return (USER_DATA / "train_inputs", USER_DATA / "lan_lists", CHARACTERS)


def _audio_roots() -> tuple[Path, ...]:
    extra = os.environ.get("GPT_SOVITS_ROOT")
    return (ROOT, Path(extra).resolve()) if extra else (ROOT,)


def _annotation_path(value: Any) -> Path:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise HTTPException(422, "请选择 Windows 主机上的 .list 文件")
    path = Path(value).resolve()
    if path.suffix.lower() != ".list" or not any(path.is_relative_to(root) for root in _lan_list_roots()):
        raise HTTPException(403, "只能在标注与训练文件库内操作 .list 文件")
    if not path.is_file():
        raise HTTPException(404, "标注文件不存在")
    return path


def _read_annotation(path: Path) -> bytes:
    with path.open("rb") as handle:
        raw = handle.read(LIST_LIMIT + 1)
    if len(raw) > LIST_LIMIT:
        raise HTTPException(413, "标注文件超过 2 MiB")
    return raw


def _annotation_catalog() -> list[dict[str, Any]]:
    items = []
    for root in _lan_list_roots():
        for path, info in _tree_files(root):
            if path.suffix.lower() == ".list" and info.st_size <= LIST_LIMIT:
                items.append({"path": str(path), "label": path.relative_to(USER_DATA).as_posix()})
    return sorted(items, key=lambda item: item["label"].casefold())


def _decode_annotation(raw: bytes) -> str:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(422, "标注文件必须使用 UTF-8 编码") from exc
    if "\0" in text:
        raise HTTPException(422, "标注文件含无效控制字符")
    return text


def _annot_load(path: Path) -> dict[str, Any]:
    raw = _read_annotation(path)
    rows = []
    seen: set[Path] = set()
    roots = _audio_roots()
    for line, value in enumerate(_decode_annotation(raw).splitlines(), 1):
        if not value.strip() or value.lstrip().startswith("#"):
            continue
        fields = [field.strip() for field in value.split("|", 3)]
        wav, speaker, lang, text = fields + [""] * (4 - len(fields))
        lang = lang.lower()
        audio = (path.parent / wav).resolve() if wav else None
        exists = bool(audio and any(audio.is_relative_to(root) for root in roots) and audio.is_file())
        issues = []
        if not wav: issues.append("no_wav")
        elif not exists: issues.append("missing")
        if not speaker: issues.append("no_speaker")
        if not lang: issues.append("no_lang")
        elif lang not in LIST_LANGS: issues.append("odd_lang")
        if not text: issues.append("no_text")
        if audio is not None:
            if audio in seen: issues.append("dup")
            seen.add(audio)
        rows.append({"line": line, "wav": wav, "speaker": speaker, "lang": lang, "text": text,
                     "abs": str(audio) if audio and exists else "", "exists": exists, "issues": issues})
    return {"path": str(path), "dir": str(path.parent), "rows": rows, "total": len(rows),
            "bad": sum(bool(row["issues"]) for row in rows), "missing": sum(not row["exists"] for row in rows),
            "relocated": 0, "ambiguous": 0, "speakers": sorted({row["speaker"] for row in rows if row["speaker"]}),
            "revision": hashlib.sha256(raw).hexdigest()}


def _annot_upload(name: Any, text: Any) -> str:
    if not isinstance(name, str) or not isinstance(text, str) or not name.lower().endswith(".list"):
        raise HTTPException(422, "请选择 UTF-8 编码的 .list 文件")
    raw = text.encode("utf-8")
    if len(raw) > LIST_LIMIT:
        raise HTTPException(413, "标注文件超过 2 MiB")
    if not _decode_annotation(raw).strip():
        raise HTTPException(422, "标注文件为空")
    filename = re.sub(r'[^\w. -]', '_', name[:-5], flags=re.UNICODE).strip(' .')[:100] or 'annotation'
    folder = USER_DATA / "lan_lists" / uuid.uuid4().hex[:12]
    folder.mkdir(parents=True, exist_ok=False)
    path = folder / f"{filename}.list"
    path.write_bytes(raw)
    return str(path)


def _annot_save(path: Path, rows: Any, revision: Any) -> dict[str, Any]:
    keys = ("wav", "speaker", "lang", "text")
    if not isinstance(rows, list) or not rows or any(
        not isinstance(row, dict) or any(not isinstance(row.get(key), str) for key in keys) for row in rows
    ):
        raise HTTPException(422, "标注行无效；拒绝覆盖原文件")
    lines = []
    for row in rows:
        values = [row[key].replace("\r", " ").replace("\n", " ") for key in keys]
        if any("\0" in v for v in values) or any("|" in v for v in values[:3]):
            raise HTTPException(422, "音频路径、说话人或语种含无效字符")
        lines.append("|".join(values) + "\n")
    raw = "".join(lines).encode("utf-8")
    if len(raw) > LIST_LIMIT:
        raise HTTPException(413, "标注文件超过 2 MiB")
    with annotation_lock:
        old = _read_annotation(path)
        if revision != hashlib.sha256(old).hexdigest():
            raise HTTPException(409, "原文件已更新，请重新加载后再编辑")
        backup = path.with_suffix(".list.bak")
        # Never overwrite the original backup; no successful save without a backup.
        try:
            with backup.open("xb") as handle:
                handle.write(old)
        except FileExistsError:
            if backup.is_symlink() or not backup.is_file():
                raise HTTPException(409, "备份路径不可用；未覆盖原文件")
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".fabric-", delete=False) as handle:
            pending = Path(handle.name)
            handle.write(raw)
        try:
            if _read_annotation(path) != old:
                raise HTTPException(409, "原文件已更新，请重新加载后再编辑")
            os.replace(pending, path)
        finally:
            pending.unlink(missing_ok=True)
    return {"written": len(rows), "backup": True}


def _training_rows(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    rows = []
    issues = []
    used_names: set[str] = set()
    for row in _annot_load(path)["rows"]:
        audio = Path(row["abs"])
        name = audio.name.casefold()
        if row["issues"] and row["issues"] != ["dup"]:
            problem = "音频路径、说话人、语种或文本无效"
        elif not _known_audio(audio):
            problem = "不支持的音频格式"
        elif name in used_names:
            problem = f"音频文件名重复：{audio.name}（不同文件夹也不能同名）"
        elif "|" in row["text"] or "|" in str(audio):
            problem = "文本或音频路径内不能包含训练清单分隔符 |"
        else:
            used_names.add(name)
            rows.append(row)
            continue
        issues.append(f"第 {row['line']} 行：{problem}")
    return rows, issues


def _dataset_stats(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    rows, issues = _training_rows(path)
    paths = list(dict.fromkeys(Path(row["abs"]) for row in rows))
    durations = []
    total_bytes = 0
    for audio in paths:
        try:
            total_bytes += audio.stat().st_size
            if audio.suffix.lower() == ".wav":
                with wave.open(str(audio), "rb") as samples:
                    durations.append(samples.getnframes() / samples.getframerate())
        except (OSError, wave.Error, EOFError):
            continue
    complete = bool(paths) and len(durations) == len(paths)
    return ({"files": len(rows), "other_files": len(issues), "issue": issues[0] if issues else "", "total_bytes": total_bytes},
            {"available": complete, "files": len(rows), "sampled": len(durations),
             **({"median_seconds": statistics.median(durations), "estimated_total_seconds": sum(durations)} if complete else {})})


PACK_ENTRY_LIMIT = 512 * 1024**2
PACK_TOTAL_LIMIT = 4 * 1024**3
PACK_SUFFIXES = {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac", ".opus"}
PACK_WEIGHTS = {"models/sovits.pth", "models/gpt.ckpt"}
PACK_IMAGES = {".png", ".jpg", ".jpeg", ".webp"}
WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(prefix + n for prefix in ("com", "lpt") for n in "123456789¹²³")}
pack_lock = threading.Lock()
pack_upload_gate = threading.Lock()


def _pack_parts(name: str) -> tuple[str, ...]:
    parts = tuple(name.replace("\\", "/").split("/"))
    if len(name) > 240 or any(
        not part or part in {".", ".."} or part.endswith((".", " ")) or
        part.split(".", 1)[0].lower() in WINDOWS_RESERVED or
        any(ord(ch) < 32 or ch in '<>:"|?*' for ch in part)
        for part in parts
    ):
        raise HTTPException(422, "ZIP contains an invalid path")
    return parts


def _role_id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", value) or value.lower() in WINDOWS_RESERVED:
        raise HTTPException(422, "Invalid role ID: use letters, digits, hyphens or underscores")
    return value


def _experiment_name(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[\w-]{1,64}", value) or value.casefold() in WINDOWS_RESERVED:
        raise HTTPException(422, "实验名只能用字母、数字、中文、下划线或连字符（1–64 字符）")
    return value


def _trained_role_id(exp: str) -> str:
    if re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", exp):
        return exp
    digest = hashlib.sha256(unicodedata.normalize("NFC", exp).casefold().encode("utf-8")).hexdigest()[:24]
    return f"trained-{digest}"


def _pack_role_dir(role_id: str) -> Path:
    # Legacy locally-trained roles can already have a Unicode directory ID.
    # ZIP imports still enforce the portable ASCII ID contract.
    path = CHARACTERS / _experiment_name(role_id)
    if not path.is_dir() or not (path / "config.json").is_file():
        raise HTTPException(404, "Role not found")
    if path.resolve() != path or CHARACTERS.resolve() != CHARACTERS:
        raise HTTPException(403, "Linked role folders are not supported")
    return path


def _inspect_pack_weights(stage: Path) -> str:
    runtime = ROOT / "Runtime/python.exe"
    inspector = ROOT / "tools/weight_inspect.py"
    if not runtime.is_file() or not inspector.is_file():
        raise HTTPException(503, "Fabric weight validator is unavailable")
    try:
        result = subprocess.run([str(runtime), str(inspector), "--kind", "sovits", "--source",
            str(stage / "models/sovits.pth"), "--counterpart", str(stage / "models/gpt.ckpt")],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, "Timed out validating the two weight files") from exc
    try:
        payload = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        payload = {}
    if result.returncode or payload.get("ok") is not True or payload.get("version") != "v5turbo":
        raise HTTPException(422, "Not a valid v5turbo weight pair: " + str(payload.get("error", "unsupported version")))
    return payload["version"]


def _zip_contents(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    cleaned = []
    total = 0
    seen = set()
    infos = archive.infolist()
    if len(infos) > 20000:
        raise HTTPException(413, "ZIP contains too many entries")
    for entry in infos:
        parts = _pack_parts(entry.orig_filename.rstrip("/"))
        mode = stat.S_IFMT(entry.external_attr >> 16)
        if mode not in {0, stat.S_IFDIR, stat.S_IFREG} or entry.flag_bits & 1:
            raise HTTPException(422, "Links, special files and encrypted ZIPs are not supported")
        if entry.is_dir():
            continue
        key = unicodedata.normalize("NFC", "/".join(parts)).casefold()
        if key in seen:
            raise HTTPException(422, "ZIP has duplicate file names")
        seen.add(key)
        total += entry.file_size
        if entry.file_size > PACK_ENTRY_LIMIT or total > PACK_TOTAL_LIMIT:
            raise HTTPException(413, "Expanded ZIP exceeds the package size limit")
        cleaned.append((parts, entry))
    wrapped = bool(cleaned) and all(len(parts) > 1 and parts[0] == cleaned[0][0][0] for parts, _ in cleaned)
    return {"/".join(parts[1:] if wrapped else parts): entry for parts, entry in cleaned}


def _pack_ref_file(root: Path, value: Any) -> Path:
    if not isinstance(value, str):
        raise HTTPException(422, "Invalid annotation or cover path")
    path = root.joinpath(*_pack_parts(value))
    if path.resolve() != path or not path.is_file():
        raise HTTPException(422, "Role package references a missing or linked file")
    return path


def _known_audio(path: Path) -> bool:
    return path.suffix.lower() in PACK_SUFFIXES and any(path.is_relative_to(root) for root in _audio_roots()) and path.is_file()


def _install_role_package(source: Path, filename: str) -> dict[str, str]:
    try:
        with zipfile.ZipFile(source) as archive:
            entries = _zip_contents(archive)
            if not PACK_WEIGHTS.union({"config.json"}) <= entries.keys():
                raise HTTPException(422, "ZIP must contain config.json, models/sovits.pth and models/gpt.ckpt")
            if entries["config.json"].file_size > 1024**2:
                raise HTTPException(413, "Role configuration is too large")
            cfg = json.loads(archive.read(entries["config.json"]).decode("utf-8-sig"))
            if not isinstance(cfg, dict) or not isinstance(cfg.get("name"), str) or not cfg["name"].strip():
                raise HTTPException(422, "Role name is missing")
            raw_id = cfg.get("id") or Path(filename).stem.removesuffix("_voice")
            role_id = _role_id(raw_id)
            if CHARACTERS.resolve() != CHARACTERS:
                raise HTTPException(409, "Character storage is linked")
            dest = CHARACTERS / role_id
            if dest.exists() or dest.is_symlink():
                raise HTTPException(409, "A role with this ID already exists; nothing was overwritten")
            with tempfile.TemporaryDirectory(prefix=".lan-install-", dir=USER_DATA) as tmp:
                stage = Path(tmp) / "role"
                stage.mkdir()
                covers = {"/".join(_pack_parts(cfg["cover"]))} if isinstance(cfg.get("cover"), str) and cfg["cover"] else set()
                if any(Path(cover).suffix.lower() not in PACK_IMAGES or cover not in entries for cover in covers):
                    raise HTTPException(422, "Unsupported or missing role cover")
                for key, info in entries.items():
                    ext = Path(key).suffix.lower()
                    if key not in PACK_WEIGHTS and key not in covers and ext not in PACK_SUFFIXES | {".list"}:
                        continue
                    target = stage.joinpath(*_pack_parts(key))
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as data, target.open("xb") as output:
                        shutil.copyfileobj(data, output, length=1024**2)
                lists = cfg.get("lists")
                if not lists:
                    lists = [{"file": key, "lang": "zh"} for key in entries if key.lower().endswith(".list")]
                if not isinstance(lists, list) or not lists or len(lists) > 64:
                    raise HTTPException(422, "Role package needs at least one reference list")
                for entry in lists:
                    if not isinstance(entry, dict):
                        raise HTTPException(422, "Invalid reference list metadata")
                    annotation = _pack_ref_file(stage, entry.get("file"))
                    if annotation.suffix.lower() != ".list":
                        raise HTTPException(422, "Reference files must be .list files")
                    n = 0
                    for line in _decode_annotation(_read_annotation(annotation)).splitlines():
                        if not line.strip() or line.lstrip().startswith("#"):
                            continue
                        fields = line.split("|", 3)
                        if len(fields) != 4 or not all(field.strip() for field in fields):
                            raise HTTPException(422, "Role package has an incomplete annotation")
                        wav = annotation.parent.joinpath(*_pack_parts(fields[0].strip()))
                        if not wav.is_file() or wav.suffix.lower() not in PACK_SUFFIXES:
                            raise HTTPException(422, "Role package is missing bundled reference audio")
                        n += 1
                    if not n:
                        raise HTTPException(422, "Reference list is empty")
                version = _inspect_pack_weights(stage)
                # Save only fields used by Fabric; no host paths or external system settings.
                config = {k: cfg[k][:2000] for k in ("name", "author", "description") if isinstance(cfg.get(k), str)}
                if covers:
                    config["cover"] = next(iter(covers))
                if isinstance(cfg.get("params"), dict):
                    config["params"] = {k: v for k, v in list(cfg["params"].items())[:100]
                                        if type(v) in {bool, int, str} or type(v) is float and math.isfinite(v)}
                config.update(id=role_id, version=version, lists=[
                    {"file": "/".join(_pack_parts(item["file"])), "lang": str(item.get("lang") or "zh")[:16], "note": str(item.get("note") or "")[:200]}
                    for item in lists], lan_imported=True)
                _write_json(stage / "config.json", config)
                with pack_lock:
                    CHARACTERS.mkdir(parents=True, exist_ok=True)
                    if dest.exists() or dest.is_symlink():
                        raise HTTPException(409, "A role with this ID already exists; nothing was overwritten")
                    stage.rename(dest)
    except (zipfile.BadZipFile, UnicodeError, ValueError, NotImplementedError, FileExistsError) as exc:
        raise HTTPException(422, "Invalid or unsupported character ZIP") from exc
    hub.broadcast_threadsafe("roles-changed", {})
    return {"id": role_id, "name": config["name"]}


def _write_role_export(role_dir: Path, target: Path) -> None:
    cfg = _read_json(role_dir / "config.json", {})
    if not isinstance(cfg, dict) or not isinstance(cfg.get("lists"), list) or not cfg["lists"]:
        raise HTTPException(422, "This role has no reference list to export")
    files = {name: _pack_ref_file(role_dir, name) for name in PACK_WEIGHTS}
    exported_lists = []
    texts = {}
    seen = {}
    cover = cfg.get("cover")
    if isinstance(cover, str) and cover and Path(cover).suffix.lower() in PACK_IMAGES:
        source = _pack_ref_file(role_dir, cover)
        files[f"cover{source.suffix.lower()}"] = source
        cfg["cover"] = f"cover{source.suffix.lower()}"
    else:
        cfg.pop("cover", None)
    for i, entry in enumerate(cfg["lists"], 1):
        annotation = _pack_ref_file(role_dir, entry.get("file") if isinstance(entry, dict) else None)
        rows = _annot_load(annotation)["rows"]
        if not rows or any(not row["exists"] or not row["text"] or not row["speaker"] or not row["lang"] for row in rows):
            raise HTTPException(422, "The role has missing audio or incomplete reference rows")
        body = []
        for row in rows:
            audio = Path(row["abs"])
            if not _known_audio(audio):
                raise HTTPException(422, "Unsupported reference audio")
            if audio not in seen:
                seen[audio] = f"audios/{len(seen)+1:05d}{audio.suffix.lower()}"
                files[f"dataset/{seen[audio]}"] = audio
            body.append("|".join([seen[audio], row["speaker"], row["lang"], row["text"]]))
        portable = f"dataset/references-{i:02d}.list"
        texts[portable] = "\n".join(body) + "\n"
        exported_lists.append({"file": portable, "lang": entry.get("lang", "zh"), "note": str(entry.get("note", ""))})
    config = {key: cfg[key] for key in ("name", "author", "version", "cover", "params", "description") if key in cfg}
    config.update(id=_trained_role_id(role_dir.name), lists=exported_lists)
    texts["config.json"] = json.dumps(config, ensure_ascii=False, indent=2)
    sizes = [path.stat().st_size for path in files.values()] + [len(t.encode("utf-8")) for t in texts.values()]
    if max(sizes) > PACK_ENTRY_LIMIT or sum(sizes) > PACK_TOTAL_LIMIT:
        raise HTTPException(413, "Role exceeds the ZIP size limit")
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for name, path in files.items():
            archive.write(path, name)
        for name, text in texts.items():
            archive.writestr(name, text)


def _diagnostics_zip() -> bytes:
    # Explicitly omit logs, usernames, paths, tokens, model data and settings.
    output = io.BytesIO()
    findings = [{"code": item["code"], "level": item["level"], "title": item["title"]} for item in _diagnostics_self_check()]
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("environment.txt", _diagnostics_summary() + "\n")
        archive.writestr("checks.json", json.dumps({"scope": "runtime, worker scripts, Turbo resources and disk space", "findings": findings}, ensure_ascii=False, indent=2))
    return output.getvalue()


def _web_cache() -> Iterator[tuple[Path, os.stat_result]]:
    # Keep this allowlist narrow. Never touch Runtime TEMP, logs, models, settings or work files.
    for child in ("cover_cache", "lan_community_cache"):
        yield from _tree_files(USER_DATA / child)


def _cache_status() -> dict[str, Any]:
    files = list(_web_cache())
    size = sum(info.st_size for _, info in files)
    return {"bytes": size, "mb": f"{size / 1024**2:.1f}", "files": len(files)}


def _cache_clear(confirmed: Any) -> dict[str, Any]:
    if confirmed is not True:
        raise HTTPException(400, "Cache clear requires confirmation")
    size = removed = skipped = 0
    for path, original in _web_cache():
        try:
            current = path.lstat()
            if _linked(current) or path.resolve() != path or (current.st_ino, current.st_mtime_ns) != (original.st_ino, original.st_mtime_ns):
                skipped += 1
                continue
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            skipped += 1
        else:
            removed += 1
            size += current.st_size
    return {"freed_bytes": size, "freed_mb": f"{size / 1024**2:.1f}", "removed_files": removed, "skipped_files": skipped}


COMMUNITY_BASE = "https://api.turingmirror.com/v1/community"
RELEASE_FEED_BASE = "https://www.turingmirror.com/releases/gpt-sovits-fabric"
PRODUCT_ID = "com.turingmirror.gpt-sovits-fabric"


def _https_url(value: Any) -> str:
    if not isinstance(value, str) or any(ord(c) < 32 for c in value):
        return ""
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    return ""


def _get_public_json(url: str) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "GPT-SoVITS-Fabric-LAN/0.1"})
    with urllib.request.urlopen(request, timeout=9) as response:
        body = response.read(4 * 1024**2 + 1)
    if len(body) > 4 * 1024**2:
        raise ValueError("Public feed too large")
    return json.loads(body)


def _read_community_catalog(cursor: Any) -> dict[str, Any]:
    if not isinstance(cursor, str) or len(cursor) > 4096:
        raise HTTPException(422, "Invalid catalog page cursor")
    query = {"productId": PRODUCT_ID, "limit": "60"}
    if cursor:
        query["cursor"] = cursor
    cache = USER_DATA / "lan_community_cache" / (hashlib.sha256(cursor.encode()).hexdigest() + ".json")
    def normalized(data):
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise ValueError("Invalid community catalog response")
        items = []
        for item in data["items"]:
            if not isinstance(item, dict):
                continue
            version = item.get("compatibleVersion") or {}
            package = version.get("package") or {}
            identifiers = [item.get("id"), version.get("id"), package.get("id")]
            if not all(isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", value) for value in identifiers):
                continue
            size = package.get("sizeBytes")
            sha = package.get("sha256")
            if type(size) is not int or size <= 0 or not isinstance(sha, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", sha):
                continue
            items.append({"id": identifiers[0], "versionId": identifiers[1], "fileId": identifiers[2], "sha256": sha,
                          "bytes": size, "title": str(item.get("title") or identifiers[0]), "author": str(item.get("originalAuthor") or ""),
                          "version": str((version.get("metadata") or {}).get("familyVersion") or (item.get("metadata") or {}).get("familyVersion") or ""),
                          "license": str((item.get("license") or {}).get("id") or ""), "sourceUrl": _https_url(item.get("upstreamUrl")),
                          "description": str(item.get("description") or "")[:1000],
                          "cover": f"{COMMUNITY_BASE}/assets/{identifiers[0]}/cover" if item.get("coverUploadId") else ""})
        return {"items": items, "nextCursor": data.get("nextCursor") if isinstance(data.get("nextCursor"), str) else ""}
    try:
        data = normalized(_get_public_json(f"{COMMUNITY_BASE}/assets?{urllib.parse.urlencode(query)}"))
    except (OSError, ValueError, AttributeError, TypeError):
        old = _read_json(cache, None)
        if isinstance(old, dict) and isinstance(old.get("items"), list):
            return {**old, "source": "cache"}
        raise HTTPException(502, "Cannot reach the public community catalog; try again later")
    try:
        if cache.parent.resolve() == cache.parent:
            cache.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=cache.parent, delete=False) as work:
                json.dump(data, work, ensure_ascii=False)
            try:
                os.replace(work.name, cache)
            finally:
                Path(work.name).unlink(missing_ok=True)
    except OSError:
        pass  # Cache failures must not block live results.
    return {**data, "source": "remote"}


def _public_download(file_id: str, asset_id: str, version_id: str, sha256: str, size: int):
    if not isinstance(file_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", file_id):
        raise HTTPException(422, "Invalid community file ID")
    try:
        result = _get_public_json(f"{COMMUNITY_BASE}/files/{file_id}/download")
        origin = result["origin"]
        if origin["assetId"] != asset_id or origin["versionId"] != version_id or result["sha256"] != sha256 or result["sizeBytes"] != size:
            raise HTTPException(409, "Package metadata changed; refresh before downloading")
        url = _https_url(result["url"])
        if url:
            return url
    except (OSError, ValueError, TypeError, KeyError):
        pass
    raise HTTPException(502, "The community source did not return a download")


def _public_changelog():
    try:
        payload = _get_public_json(f"{RELEASE_FEED_BASE}/changelog.json")
        return [{"version": row["version"], "date": str(row.get("date", "")), "title": str(row.get("title") or row["version"]),
                 "notes": str(row.get("body", "")).splitlines()[:20]}
                for row in payload["entries"][:12] if isinstance(row, dict) and isinstance(row.get("version"), str)]
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(502, "Release notes unavailable")


_TRAIN_ACTIVE = {"queued", "running", "cancelling"}
_TRAIN_TERMINAL = {"completed", "failed", "cancelled"}
_TRAIN_RETRYABLE = {"failed", "cancelled"}


def _train_snapshot() -> list[dict[str, Any]]:
    with jobs_lock:
        return copy.deepcopy(list(train_jobs.values()))


def _broadcast_train() -> None:
    hub.broadcast_threadsafe("train-queue", {"jobs": _train_snapshot()})


def _train_status() -> dict[str, Any]:
    ready, missing = _asset_ready()
    jobs = _train_snapshot()
    return {
        "runtime_ready": (ROOT / "Runtime/python.exe").is_file(),
        "worker_present": (ROOT / "tools/train_worker.py").is_file(),
        "engine_core_ready": ready,
        "engine_core_missing": missing,
        "nvidia": True,
        "default_version": "v5turbo",
        "versions": [{
            "id": "v5turbo",
            "lora": True,
            "base_missing": missing,
            "defaults": {
                "sovits": {"epochs": 2, "max_epochs": 16, "save_every": 1, "batch": 2, "max_batch": 6, "learning_rate": 0.0001, "lora_rank": 32, "lora_ranks": [16, 32, 64, 128]},
                "gpt": {"epochs": 15, "min_epochs": 2, "max_epochs": 50, "save_every": 5, "batch": 8, "max_batch": 40},
            },
        }],
        "experiments": [{"name": p.name} for p in sorted(TRAIN_ROOT.iterdir()) if p.is_dir()] if TRAIN_ROOT.is_dir() else [],
        "disk_free_bytes": shutil.disk_usage(ROOT).free,
        "busy": any(j["state"] in _TRAIN_ACTIVE for j in jobs),
        "jobs": jobs,
    }


def _training_request(args: Any) -> tuple[dict[str, Any], str]:
    if not isinstance(args, dict):
        raise HTTPException(422, "训练请求无效")
    exp = _experiment_name(args.get("exp"))
    path = _annotation_path(args.get("dataset"))
    rows, issues = _training_rows(path)
    if not rows or issues:
        raise HTTPException(422, issues[0] if issues else "训练集为空")
    if args.get("version", "v5turbo") != "v5turbo" or args.get("resume"):
        raise HTTPException(422, "网页版只支持新建 v5turbo 训练，不支持续训")
    params: dict[str, Any] = {"exp": exp, "dataset": str(path), "version": "v5turbo"}
    for key, default, lo, hi in (
        ("sovits_epoch", 2, 1, 16), ("sovits_batch", 2, 1, 6), ("sovits_save_every", 1, 1, 16),
        ("gpt_epoch", 15, 2, 50), ("gpt_batch", 8, 1, 40), ("gpt_save_every", 5, 1, 50),
    ):
        value = args.get(key, default)
        if type(value) is not int or not lo <= value <= hi:
            raise HTTPException(422, f"训练参数 {key} 超出范围（{lo}–{hi}）")
        params[key] = value
    if params["sovits_save_every"] > params["sovits_epoch"] or params["gpt_save_every"] > params["gpt_epoch"]:
        raise HTTPException(422, "保存间隔不能大于总轮数，否则不会生成角色权重")
    lr, rank = args.get("learning_rate", 1e-4), args.get("lora_rank", 32)
    if type(lr) not in {int, float} or not 0.00001 <= lr <= 0.001 or type(rank) is not int or rank not in {16, 32, 64, 128}:
        raise HTTPException(422, "训练学习率或 LoRA Rank 不在允许范围内")
    params.update(learning_rate=lr, lora_rank=rank)
    # Make an immutable, BOM-free worker input with absolute paths. The selected
    # annotation is never rewritten, even if the user edits it during training.
    return params, "".join("|".join(row[key] for key in ("abs", "speaker", "lang", "text")) + "\n" for row in rows)


def _stop_train_process(proc: subprocess.Popen[str]) -> None:
    if os.name == "nt":
        # The training worker spawns Python children for formatting and both
        # training stages. Terminating the parent alone leaves those running.
        taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/taskkill.exe"
        result = subprocess.run([str(taskkill), "/PID", str(proc.pid), "/T", "/F"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode:
            raise RuntimeError("无法确认已停止训练进程及其子进程")
    else:
        os.killpg(proc.pid, signal.SIGKILL)


def _run_train(job_id: str, req: dict[str, Any], dataset: str, exp_dir: Path) -> None:
    proc = None
    error = ""
    done = None
    completed = False
    try:
        with jobs_lock:
            if train_jobs[job_id]["state"] == "cancelling":
                return
        role_id = _trained_role_id(req["exp"])
        role_dir = exp_dir / "role-stage" / role_id
        dest = CHARACTERS / role_id
        exp_dir.mkdir(parents=True, exist_ok=False)
        list_file = exp_dir / "lan-dataset.list"
        list_file.write_text(dataset, encoding="utf-8")
        request_path = exp_dir / "lan-request.json"
        _write_json(request_path, {**req, "dataset": str(list_file), "device": "cuda", "is_half": True,
                                   "resume": False, "output_dir": str(exp_dir / "weights"),
                                   "exp_dir": str(exp_dir), "role_dir": str(role_dir)})
        options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        with jobs_lock:
            if train_jobs[job_id]["state"] == "cancelling":
                return
            proc = subprocess.Popen(
                [str(ROOT / "Runtime/python.exe"), str(ROOT / "tools/train_worker.py"), str(request_path)],
                cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1, **options,
            )
            train_processes[job_id] = proc
            train_jobs[job_id]["state"] = "running"
        _broadcast_train()
        assert proc.stdout is not None
        for raw in proc.stdout:
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            phase = message.get("phase")
            if phase == "stage":
                progress = {k: message[k] for k in ("stage", "done", "total", "message_code", "message") if k in message}
                with jobs_lock:
                    train_jobs[job_id]["progress"] = progress
                _broadcast_train()
            elif phase == "done":
                done = message
            elif phase == "error":
                error = str(message.get("message") or message.get("message_code") or "训练失败")
        code = proc.wait()
        with jobs_lock:
            if train_jobs[job_id]["state"] == "cancelling":
                return
        if code != 0 or error or done is None:
            raise RuntimeError(error or f"训练程序退出，未报告成品（退出码 {code}）")
        config = _read_json(role_dir / "config.json", {})
        if not (isinstance(config, dict) and config.get("id") == role_id and config.get("lists")
                and all((role_dir / file).is_file() and (role_dir / file).stat().st_size for file in PACK_WEIGHTS)):
            raise RuntimeError("训练程序未生成可用的角色权重和参考音频")
        with pack_lock:
            CHARACTERS.mkdir(parents=True, exist_ok=True)
            if CHARACTERS.resolve() != CHARACTERS or dest.exists() or dest.is_symlink():
                raise RuntimeError("角色目录不可用或已被占用；训练文件已保留，未覆盖现有角色")
            role_dir.rename(dest)
        completed = True
        hub.broadcast_threadsafe("roles-changed", {})
    except Exception as exc:
        error = str(exc) or type(exc).__name__
    finally:
        if proc is not None:
            if proc.poll() is None:
                try:
                    _stop_train_process(proc)
                except (OSError, subprocess.SubprocessError, RuntimeError):
                    # Do not release the queue while a worker we could not stop is live.
                    pass
                proc.wait()
            if proc.stdout is not None:
                proc.stdout.close()
        with jobs_lock:
            train_processes.pop(job_id, None)
            job = train_jobs[job_id]
            if job["state"] == "cancelling":
                job.update(state="cancelled", error="")
            elif completed:
                job.update(state="completed", error="", role_id=role_id)
            else:
                job.update(state="failed", error=error or "训练未成功启动")
        _broadcast_train()


def _queue_train(req: dict[str, Any], data: str, retry_id: str | None = None) -> dict[str, str]:
    with jobs_lock:
        if any(job["state"] in _TRAIN_ACTIVE for job in train_jobs.values()):
            raise HTTPException(409, "已有进行中的网页训练任务")
        role_id = _trained_role_id(req["exp"])
        if (CHARACTERS / role_id).exists() or (CHARACTERS / req["exp"]).exists():
            raise HTTPException(409, "已有同名角色；未覆盖原角色")
        if retry_id is not None:
            original = train_jobs.get(retry_id)
            if not original or original["state"] not in _TRAIN_RETRYABLE:
                raise HTTPException(409, "原任务已变更，无法重试")
        job_id = uuid.uuid4().hex[:12]
        exp_dir = TRAIN_ROOT / (req["exp"] if retry_id is None else f"{req['exp']}-retry-{job_id}")
        if exp_dir.exists() or exp_dir.is_symlink():
            raise HTTPException(409, "已有同名实验；请换个实验名，网页版不覆盖或续训")
        train_jobs[job_id] = {"id": job_id, "state": "queued", "req": req, "progress": None, "error": ""}
    _broadcast_train()
    try:
        threading.Thread(target=_run_train, args=(job_id, req, data, exp_dir), daemon=True).start()
    except Exception as exc:
        with jobs_lock:
            job = train_jobs[job_id]
            if job["state"] == "cancelling":
                job.update(state="cancelled", error="")
            else:
                job.update(state="failed", error=str(exc))
        _broadcast_train()
    return {"id": job_id}


def _train_action(job_id: Any, action: Any) -> dict[str, Any]:
    if not isinstance(action, str) or action not in {"clear", "remove", "cancel", "retry"} or not isinstance(job_id, str):
        raise HTTPException(422, "未知训练队列操作")
    with jobs_lock:
        if action == "clear":
            removed = [key for key, job in train_jobs.items() if job["state"] in _TRAIN_TERMINAL]
            for key in removed:
                del train_jobs[key]
        else:
            job = train_jobs.get(job_id)
            if job is None:
                raise HTTPException(404, "训练任务不存在")
            state = job["state"]
            if action == "remove":
                if state not in _TRAIN_TERMINAL:
                    raise HTTPException(409, "请先停止训练再移除任务")
                del train_jobs[job_id]
                removed = [job_id]
            elif action == "retry":
                if state not in _TRAIN_RETRYABLE:
                    raise HTTPException(409, "只能重试失败或已取消的任务")
                request = dict(job["req"])
            else:
                if state == "cancelling":
                    return {"state": state}
                if state not in _TRAIN_ACTIVE:
                    raise HTTPException(409, "该训练任务已经结束")
                if proc := train_processes.get(job_id):
                    if proc.poll() is not None:
                        raise HTTPException(409, "该训练进程正在收尾")
                    try:
                        _stop_train_process(proc)
                    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
                        raise HTTPException(409, f"取消未确认：{exc}") from exc
                job["state"] = "cancelling"
    if action == "retry":
        return _queue_train(*_training_request(request), retry_id=job_id)
    _broadcast_train()
    return {"state": "cancelling"} if action == "cancel" else {"removed": len(removed)}


# The runtime's packaged LoRA base uses HParams as a data container. Allow
# only the two known serialized names, mapped to an inert class; all other
# globals still face Torch's weights-only check for imported role inference.
_SAFE_SYNTH_ENTRY = """
import runpy
import sys
import torch
class LanHParams:
    def __getitem__(self, name):
        return self.__dict__[name]
    def __setitem__(self, name, value):
        self.__dict__[name] = value
    def __contains__(self, name):
        return name in self.__dict__
    def keys(self):
        return self.__dict__.keys()
    def items(self):
        return self.__dict__.items()
    def values(self):
        return self.__dict__.values()
    def __len__(self):
        return len(self.__dict__)
real_load = torch.load
def private_weights_load(*args, **kwargs):
    if kwargs.get('weights_only') is True:
        # The weight inspector supplies its own inert HParams mapping here.
        return real_load(*args, **kwargs)
    kwargs['weights_only'] = True
    allowed = [(LanHParams, 'utils.HParams'), (LanHParams, 'GPT_SoVITS.utils.HParams')]
    with torch.serialization.safe_globals(allowed):
        return real_load(*args, **kwargs)
torch.load = private_weights_load
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
"""


SYNTH_TIMEOUT = 120


def _synth_worker(launch: list[str], payload: str, env: dict[str, str] | None, job: str,
                  progress_id: str | None) -> tuple[int, dict[str, Any] | None, int]:
    # Give stdin/stderr seekable files so neither large text nor worker logs
    # can block an unread pipe. Drain stdout incrementally until exit.
    with tempfile.TemporaryFile() as stdin, tempfile.TemporaryFile() as stderr:
        stdin.write(payload.encode("utf-8"))
        stdin.seek(0)
        with subprocess.Popen(launch, cwd=str(ROOT), env=env, stdin=stdin, stdout=subprocess.PIPE,
                              stderr=stderr, text=True, encoding="utf-8", errors="replace") as proc:
            timed_out = threading.Event()

            def expire() -> None:
                if proc.poll() is None:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        return
                    timed_out.set()

            timer = threading.Timer(SYNTH_TIMEOUT, expire)
            timer.daemon = True
            timer.start()
            result = None
            error = ""
            chunks = 0
            try:
                assert proc.stdout is not None
                for raw in proc.stdout:
                    try:
                        event = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(event, dict) or event.get("job") not in (None, job):
                        continue
                    if event.get("event") == "error":
                        error = str(event.get("message") or "Synthesis failed")
                    elif event.get("event") == "chunk":
                        chunks += 1
                        if progress_id:
                            hub.broadcast_threadsafe("synth-chunk", {"progressId": progress_id, "seq": chunks - 1})
                    elif event.get("event") == "done":
                        result = event
                exit_code = proc.wait()
            finally:
                timer.cancel()
                timer.join()
                if proc.poll() is None:
                    proc.kill()
            if timed_out.is_set():
                raise HTTPException(504, f"Synthesis timed out ({SYNTH_TIMEOUT} s); the worker was stopped")
            if error:
                raise RuntimeError(error)
            return exit_code, result, chunks


def _run_synth(args: dict[str, Any]) -> dict[str, Any]:
    role_dir = Path(args.get("roleDir") or "")
    role_id = str(args.get("roleId") or role_dir.name)
    # Do not let the request substitute arbitrary weight paths. Use the installed role only.
    role_dir = _pack_role_dir(role_id)
    role_id = role_dir.name
    progress_id = args.get("progressId")
    if progress_id is not None and (not isinstance(progress_id, str) or not re.fullmatch(r"[0-9a-f]{32}", progress_id)):
        raise HTTPException(422, "Invalid synthesis progress ID")
    installed = _read_json(role_dir / "config.json", {})
    opts = args.get("opts") or {}
    if not isinstance(opts, dict) or opts.get("backend", "cuda") != "cuda":
        raise HTTPException(422, "Fabric LAN synthesis only supports CUDA")
    main_ref = args.get("refWav", "")
    aux_refs = opts.get("aux_refs", [])
    if not isinstance(main_ref, str) or not isinstance(aux_refs, list) or any(
        not isinstance(ref, str) or not ref or not _known_audio(Path(ref).resolve())
        for ref in ([main_ref] if main_ref else []) + aux_refs
    ):
        raise HTTPException(422, "Reference audio must be within a configured media root")
    version = installed.get("version", "v5turbo")
    worker_env = None
    output_dir = OUTPUTS / role_id
    output_dir.mkdir(parents=True, exist_ok=True)
    job = f"lan-{uuid.uuid4().hex[:10]}"
    request = {
        "cmd": "load",
        "role_id": role_id,
        "sovits": str(role_dir / "models/sovits.pth"),
        "gpt": str(role_dir / "models/gpt.ckpt"),
        "version": version,
        "cnhubert": str(ROOT / "GPT_SoVITS/pretrained_models/chinese-hubert-base"),
        "bert": str(ROOT / "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"),
        "main_gpu": 0,
    }
    worker = ROOT / "Runtime/python.exe"
    script = ROOT / "tools/synth_worker.py"
    launch = [str(worker), str(script), "--resident"]
    if installed.get("lan_imported"):
        worker_env = {**os.environ, "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1"}
        launch[1:1] = ["-c", _SAFE_SYNTH_ENTRY]

    synth = {
        "cmd": "synth", "job": job, "text": args.get("text", ""),
        "ref_wav": main_ref, "ref_text": args.get("refText", ""),
        "ref_lang": args.get("refLang", "ZH"), "params": args.get("params", {}),
        "aux_refs": aux_refs, "format": opts.get("format", "wav"),
        "streaming": bool(args.get("streaming", False)), "out_dir": str(output_dir),
        "cnhubert": str(ROOT / "GPT_SoVITS/pretrained_models/chinese-hubert-base"),
        "bert": str(ROOT / "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"),
    }
    payload = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in (request, synth, {"cmd": "quit"}))
    if not synth_lock.acquire(blocking=False):
        raise HTTPException(409, "A Fabric LAN synthesis is already running")
    try:
        exit_code, result, chunks = _synth_worker(launch, payload, worker_env, job, progress_id)
        out = Path(result["out"]) if result and result.get("out") else None
        if exit_code or out is None or not out.is_file():
            raise RuntimeError(f"Synthesis worker exited without audio (exit {exit_code})")
        record = {key: result[key] for key in ("audio_sec", "t_first_ms", "t_total_ms") if key in result}
        _write_json(out.with_suffix(".json"), {**record, "params": synth["params"], "text": synth["text"], "role_name": opts.get("role_name", role_id)})
        hub.broadcast_threadsafe("synth-done", {"job": job, "out": str(out)})
        return {"out": str(out), "cancelled": False, "job": job, "chunks": chunks, **record}
    finally:
        synth_lock.release()


def _invoke(command: str, args: dict[str, Any]) -> Any:
    if command == "config_get": return _config()
    if command == "config_set":
        patch = args.get("patch", {})
        if not isinstance(patch, dict):
            raise HTTPException(422, "Expected a settings object")
        with config_lock:
            cfg = _config()
            cfg.update(patch)
            _write_json(CONFIG_FILE, cfg)
        return {"config": cfg, "hot": {}, "needs_restart": []}
    if command == "i18n_set_locale": return {"ok": True}
    if command == "product_root": return str(ROOT)
    if command == "shell_version": return LAN_VERSION
    if command == "lan_community_catalog": return _read_community_catalog(args.get("cursor", ""))
    if command == "lan_release_notes": return _public_changelog()
    if command == "lan_community_download":
        return _public_download(args.get("fileId", ""), args.get("id", ""), args.get("versionId", ""), args.get("sha256", ""), args.get("bytes", 0))
    if command == "diagnostics_summary_text": return _diagnostics_summary()
    if command == "diagnostics_self_check": return _diagnostics_self_check()
    if command in {"diagnostics_build", "legacy_open_panel", "legacy_open_webui", "reveal_user_dir", "engine_force_kill"}:
        raise HTTPException(501, "此操作只在 Fabric 桌面端可用 / This action is only available in the desktop app.")
    if command == "log_path": return str(USER_DATA / "logs")
    if command == "cache_status": return _cache_status()
    if command == "cache_clear": return _cache_clear(args.get("confirm"))
    if command == "assets_status":
        ready, missing = _asset_ready(); return {"engine_core_ready": ready, "missing": missing, "training_ready": ready}
    if command == "engine_status": return {"state": "busy" if synth_lock.locked() else "idle", "runtime_ready": (ROOT / "Runtime/python.exe").is_file(), "device": "cuda:0"}
    if command == "provision_status": return {"runtime_ready": True, "need_provision": False, "installed_variant": "nvidia", "recommended_variant": "nvidia", "worker_script_ok": True}
    if command == "synth_characters": return {"roles": _characters()}
    if command == "synth_recent": return _synth_recent(args.get("limit"))
    if command == "synth_start": return _run_synth(args)
    if command == "synth_cancel":
        raise HTTPException(501, "Cancelling an active synthesis is not available on Fabric LAN")
    if command == "storage_usage": return _storage_usage()
    if command == "train_cleanup_scan": return _train_cleanup_scan()
    if command in {"train_cleanup_apply", "gsv_cpp_clear_cache", "synth_rename", "synth_delete", "synth_reveal_file"}:
        raise HTTPException(501, "此操作只在 Fabric 桌面端可用 / This action is only available in the desktop app.")
    if command == "train_status": return _train_status()
    if command == "train_output_dir": return str(TRAIN_ROOT)
    if command == "annot_catalog": return _annotation_catalog()
    if command == "annot_upload": return _annot_upload(args.get("name"), args.get("text"))
    if command == "annot_load": return _annot_load(_annotation_path(args.get("path")))
    if command == "annot_save": return _annot_save(_annotation_path(args.get("path")), args.get("rows"), args.get("revision"))
    if command in {"train_scan_dataset", "train_inspect_dataset", "train_dataset_stats"}:
        scan, inspect = _dataset_stats(_annotation_path(args.get("path")))
        if command == "train_dataset_stats": return {"scan": scan, "inspect": inspect}
        return scan if command == "train_scan_dataset" else inspect
    if command == "train_queue_list": return {"jobs": _train_snapshot()}
    if command == "train_queue_add": return _queue_train(*_training_request(args.get("req")))
    if command == "train_queue_action": return _train_action(args.get("id", ""), args.get("action"))
    if command in {"role_update", "role_cover_reset", "role_cover_save", "role_delete", "role_assets_get", "role_import_pack", "role_export", "train_pick_dataset", "train_pick_output_dir", "annot_pick", "pick_wallpaper", "autostart_set", "community_publication", "plaza_fetch"}:
        raise HTTPException(501, "此功能尚未接入 Fabric 网页版 / This feature is not connected in Fabric LAN Web.")
    if command in {"store_catalog", "community_links", "community_account_status", "plaza_feed"}: return {"source": "lan", "voices": [], "thirdparty_voices": [], "roles": [], "items": []}
    if command in {"provision_start", "provision_cancel", "assets_ensure_engine_core", "extra_cancel", "extra_download", "assets_cancel_gsv_cpp", "vcredist_install"}: return {"ok": False, "message": "LAN mode uses the existing local Runtime; no download is required."}
    if command in {"open_external", "annot_reveal", "tools_open", "tools_open_downloads", "tools_open_help", "close_finish", "telemetry_tick", "ui_ready", "plaza_mark_seen", "plaza_dismiss", "separate_cancel", "separate_reveal", "store_cancel", "store_discard_staged", "store_install", "store_install_staged", "store_reveal_staged", "update_apply"}: return {"ok": True}
    return {}


_PRIVATE_LAN = tuple(ipaddress.IPv4Network(block) for block in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def _listen_origin(host: str, port: int, trusted_lan: bool) -> str:
    address = ipaddress.IPv4Address(host)
    if not address.is_loopback and (not trusted_lan or not any(address in network for network in _PRIVATE_LAN)):
        raise ValueError("Bind to loopback or to one explicit private IPv4 address with --trusted-lan (no public or wildcard addresses)")
    if not 1 <= port <= 65535:
        raise ValueError("Port must be 1–65535")
    return f"http://{address}:{port}"


def _request_allowed(headers) -> bool:
    origins = app.state.allowed_origins
    target = "http://" + headers.get("host", "").lower()
    origin = headers.get("origin")
    return target in origins and (origin is None or origin == target) and headers.get("sec-fetch-site") != "cross-site"


@app.middleware("http")
async def browser_boundary(request: Request, call_next):
    # Restrict allowed Hosts even for the UI and disallow cross-origin API requests.
    host = "http://" + request.headers.get("host", "").lower()
    path = request.url.path
    if host not in app.state.allowed_origins or ((path == "/api" or path.startswith("/api/")) and not _request_allowed(request.headers)):
        return JSONResponse({"detail": "Request must use the configured Fabric origin"}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


@app.get("/api/health")
def health(): return {"ok": True, "product": "GPT-SoVITS Fabric LAN Web"}


@app.get("/api/bootstrap")
def bootstrap():
    return {"token_required": False, "product": "GPT-SoVITS Fabric LAN Web", "version": "0.1.0"}


@app.post("/api/invoke")
async def invoke_endpoint(req: InvokeRequest):
    try:
        return {"ok": True, "result": await asyncio.to_thread(_invoke, req.command, req.args)}
    except HTTPException:
        raise
    except Exception as exc:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(exc)})


@app.post("/api/event")
async def event_endpoint(request: Request):
    data = await request.json()
    await hub.broadcast(data.get("event", ""), data.get("payload"))
    return {"ok": True}


@app.websocket("/api/events")
async def events_endpoint(ws: WebSocket):
    if not _request_allowed(ws.headers):
        await ws.close(code=4401); return
    await hub.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        hub.remove(ws)
    except Exception:
        hub.remove(ws)


@app.post("/api/role-package")
async def upload_role_package(request: Request, name: str):
    if not name.lower().endswith(".zip") or request.headers.get("content-type") != "application/zip":
        raise HTTPException(415, "Choose a Fabric .zip package")
    if not pack_upload_gate.acquire(blocking=False):
        raise HTTPException(409, "Another role package is being imported")
    try:
        def add_chunk(file, chunk):
            file.write(chunk)
        USER_DATA.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".lan-package-", dir=USER_DATA) as tmp:
            path = Path(tmp) / "import.zip"
            received = 0
            with path.open("xb") as upload:
                async for chunk in request.stream():
                    received += len(chunk)
                    if received > PACK_TOTAL_LIMIT:
                        raise HTTPException(413, "ZIP exceeds 4 GiB")
                    await asyncio.to_thread(add_chunk, upload, chunk)
            role = await asyncio.to_thread(_install_role_package, path, name)
        return {"ok": True, "result": role}
    finally:
        pack_upload_gate.release()


@app.get("/api/role-package/{role_id}")
def export_role_package(role_id: str):
    role_dir = _pack_role_dir(role_id)
    temp = tempfile.TemporaryDirectory(prefix=".lan-export-", dir=USER_DATA)
    try:
        out = Path(temp.name) / f"{role_id}_voice.zip"
        _write_role_export(role_dir, out)
        return FileResponse(out, filename=out.name, media_type="application/zip", background=BackgroundTask(temp.cleanup))
    except BaseException:
        temp.cleanup()
        raise


@app.get("/api/diagnostics.zip")
def download_diagnostics():
    return Response(_diagnostics_zip(), media_type="application/zip", headers={
        "Content-Disposition": 'attachment; filename="fabric-lan-diagnostics.zip"', "Cache-Control": "no-store",
    })


@app.get("/api/file")
def file_endpoint(path: str):
    candidate = Path(path).resolve()
    if candidate.suffix.lower() not in PACK_IMAGES | PACK_SUFFIXES or not any(candidate.is_relative_to(root) for root in _audio_roots()):
        raise HTTPException(403, "Only managed images and audio can be served")
    if not candidate.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(candidate)


def main() -> None:
    global ROOT, FRONTEND, USER_DATA, CHARACTERS, TRAIN_ROOT, OUTPUTS, CONFIG_FILE
    parser = argparse.ArgumentParser(description="Serve the opt-in GPT-SoVITS Fabric LAN web frontend")
    parser.add_argument("--root", default=os.environ.get("FABRIC_ROOT"), required="FABRIC_ROOT" not in os.environ, help="Installed Fabric product directory")
    parser.add_argument("--frontend", default=str(FRONTEND), help="Frontend built with npm run build:lan")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--trusted-lan", action="store_true", help="Acknowledge unauthenticated access by devices on a private network")
    args = parser.parse_args()
    try:
        origin = _listen_origin(args.host, args.port, args.trusted_lan)
    except ValueError as exc:
        parser.error(str(exc))
    ROOT = Path(args.root).resolve()
    FRONTEND = Path(args.frontend).resolve()
    if not (ROOT / "tools/synth_worker.py").is_file():
        parser.error("--root must point to an installed Fabric product directory with its worker scripts")
    if not (FRONTEND / "index.html").is_file():
        parser.error("LAN build not found: run npm run build:lan in app/ or pass --frontend")
    allowed = {origin}
    if args.host == "127.0.0.1":
        allowed.add(f"http://localhost:{args.port}")
    app.state.allowed_origins = frozenset(allowed)
    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
    USER_DATA = ROOT / "User_Data"
    CHARACTERS, TRAIN_ROOT, OUTPUTS = (USER_DATA / name for name in ("characters", "train", "outputs"))
    CONFIG_FILE = USER_DATA / "lan_web_config.json"
    print(f"Fabric LAN Web: {origin} (use a trusted network only; no account authentication)", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, proxy_headers=False)


if __name__ == "__main__": main()
