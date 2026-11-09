"""Convert one installed Fabric V5 Turbo role into the gsv.cpp cache."""

from __future__ import annotations

import argparse
from copy import deepcopy
import gc
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "GSV_CPP" / "engine"
SHARED = ROOT / "GSV_CPP" / "shared"
BASE = ROOT / "GPT_SoVITS" / "pretrained_models" / "gsv-v5-pretrained" / "s2Gv5turbo.pth"
COMPONENTS = {
    "ar": ("convert_ar.py", "ar-f16.gguf", 295, ("--spec", "attn=f16,ffn=f16,predict=f16")),
    "cond": ("convert_cond.py", "cond-f16.gguf", 298, ("--spec", "wns1=f16,bridge=f16,enc_p.ffn=f16")),
    "dit": ("convert_dit.py", "dit-f16.gguf", 365, ("--spec", "lin=f16")),
    "refcode": ("convert_refcode.py", "refcode.gguf", 4, ()),
}
SHARED_FILES = {
    "bert": "bert-f16.gguf",
    "hubert": "hubert-f16.gguf",
    "vocoder": "vocoder-f32.gguf",
    "filter": "resampy_kaiser_best.bin",
}


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def manifest_for(folder: Path) -> dict:
    voice = {"name": "default", "version": "v5turbo"}
    voice.update({name: str(folder / spec[1]) for name, spec in COMPONENTS.items()})
    voice.update({name: str(SHARED / filename) for name, filename in SHARED_FILES.items()})
    return voice


def complete(folder: Path) -> bool:
    try:
        voice = manifest_for(folder)
        manifest = folder / "voices" / "default" / "manifest.json"
        return json.loads(manifest.read_text(encoding="utf-8")) == voice and all(
            Path(voice[name]).stat().st_size > 0 for name in (*COMPONENTS, *SHARED_FILES)
        )
    except (OSError, ValueError):
        return False


def merged_checkpoint(sovits: Path, tmp: Path, lora: bool) -> Path:
    import torch
    from GPT_SoVITS.process_ckpt import load_sovits_new

    if lora:
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        tts = object.__new__(TTS)
        tts.configs = TTS_Config(deepcopy(TTS_Config.default_configs))
        tts.configs.configs_path = str(tmp / "tts_infer.yaml")
        tts.configs.device = torch.device("cpu")
        tts.configs.is_half = False
        tts.init_vits_weights(str(sovits), load_vocoder=False)
        state = tts.vits_model.state_dict()
    else:
        state = load_sovits_new(sovits)["weight"]
    if any(".lora_" in name for name in state) or sum(
        name.startswith("cfm.estimator.") for name in state
    ) != 363:
        raise ValueError("The V5 Turbo checkpoint does not contain a full merged DiT.")
    output = tmp / "sovits.pth"
    with torch.inference_mode():
        torch.save(
            {"weight": {name: value.half() if value.is_floating_point() else value for name, value in state.items()}},
            output,
        )
    return output


def convert(gpt: Path, sovits: Path, cache: Path, workspace: Path) -> Path:
    with sovits.open("rb") as stream:
        lora = stream.read(2) == b"08"
    converter = ENGINE / "tools" / "export_gguf"
    identities = [sha256(gpt), sha256(sovits)]
    identities.extend(sha256(converter / spec[0]) for spec in COMPONENTS.values())
    if lora:
        identities.append(sha256(BASE))
    version = (ENGINE / "VERSION").read_text(encoding="utf-8").strip()
    key = hashlib.sha256("|".join(("v1", version, *identities)).encode("ascii")).hexdigest()
    target = (cache / key).resolve()
    if complete(target):
        return target

    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ENGINE / "deps"))
    from tools.portable_runtime import activate
    from tools.weight_inspect import validate_replacement

    activate(change_cwd=True)
    model = validate_replacement(str(sovits), "sovits", str(gpt), requested_version="v5turbo", root=ROOT)
    if model["sovits"]["lora"] != lora:
        raise ValueError("The V5 Turbo LoRA header does not match its weights.")
    from gguf import GGUFReader

    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=workspace, prefix="converting-") as temporary:
        stage = Path(temporary)
        files = stage / "model"
        files.mkdir()
        full = merged_checkpoint(sovits, stage, lora)
        gc.collect()
        argv = sys.argv
        try:
            for name, (filename, output_name, count, options) in COMPONENTS.items():
                script = converter / filename
                output = files / output_name
                checkpoint = gpt if name == "ar" else full
                sys.argv = [str(script), "--ckpt", str(checkpoint), "--out", str(output), *options]
                runpy.run_path(str(script), run_name="__main__")
                reader = GGUFReader(str(output))
                if len(reader.tensors) != count:
                    raise ValueError(f"The {name} GGUF has an unexpected tensor count.")
                del reader
        finally:
            sys.argv = argv
        manifest = files / "voices" / "default" / "manifest.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps(manifest_for(target), ensure_ascii=False), encoding="utf-8")
        try:
            files.rename(target)
        except FileExistsError:
            if not complete(target):
                invalid = stage / "incomplete"
                target.rename(invalid)
                try:
                    files.rename(target)
                except OSError:
                    invalid.rename(target)
                    raise
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gpt", type=Path, required=True)
    parser.add_argument("--sovits", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    args = parser.parse_args()
    result_stream, sys.stdout = sys.stdout, sys.stderr
    print(str(convert(args.gpt, args.sovits, args.cache, args.workspace)), file=result_stream, flush=True)


if __name__ == "__main__":
    main()
