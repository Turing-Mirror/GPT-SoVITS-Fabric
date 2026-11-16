"""Inspect replacement checkpoints without constructing models or allocating tensor storage.

The bundled process_ckpt.py owns SoVITS header/hash identifiers. GPT models are
paired by their token vocabulary, not by the SoVITS release name (v2 Pro through
v5 share the s1v3 GPT model upstream).
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


class WeightError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class _HParams:
    """Data-only substitute for the upstream config container during unpickling."""


class _CheckpointFile(io.BufferedReader):
    """Expose the ZIP signature used before upstream adds its version prefix."""
    def read(self, size=-1):
        position = self.tell()
        data = super().read(size)
        if position < 2:
            count = min(2 - position, len(data))
            data = b"PK"[position:position + count] + data[count:]
        return data

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)


def _dict(value):
    if isinstance(value, _HParams):
        return {key: _dict(item) for key, item in vars(value).items()}
    if isinstance(value, dict):
        return {key: _dict(item) for key, item in value.items()}
    return value


def _tables(root):
    tree = ast.parse((root / "GPT_SoVITS/process_ckpt.py").read_text(encoding="utf-8"))
    names = {"head2version", "hash_pretrained_dict"}
    return {
        target.id: ast.literal_eval(node.value)
        for node in tree.body if isinstance(node, ast.Assign)
        for target in node.targets if isinstance(target, ast.Name) and target.id in names
    }


def _symbol_counts(root):
    counts = {}
    for version, filename in (("v1", "symbols.py"), ("v2", "symbols2.py")):
        spec = importlib.util.spec_from_file_location("weight_symbols", root / "GPT_SoVITS/text" / filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        counts[version] = len(module.symbols)
    return counts


def _shape(weights, name, ndim):
    import torch
    tensor = weights.get(name)
    if not isinstance(tensor, torch.Tensor) or tensor.ndim != ndim or any(n <= 0 for n in tensor.shape):
        raise WeightError("invalid")
    return tuple(tensor.shape)


def inspect_weight(path: Path, kind: str, root: Path = ROOT):
    import torch
    from torch._subclasses.fake_tensor import FakeTensorMode

    tables = _tables(root)
    with path.open("rb") as file:
        prefix = file.read(8192)
    head = prefix[:2]
    if head != b"PK" and (kind != "sovits" or head not in tables["head2version"]):
        raise WeightError("invalid")
    # FakeTensorMode reads shapes and storage metadata without loading the model
    # into CPU/GPU memory. Only the known, inert config container is allowlisted.
    with _CheckpointFile(path.open("rb", buffering=0)) as file:
        with torch.serialization.safe_globals([(_HParams, "utils.HParams"), (_HParams, "GPT_SoVITS.utils.HParams")]):
            with FakeTensorMode():
                checkpoint = torch.load(file, map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, dict):
        raise WeightError("invalid")
    config = _dict(checkpoint.get("config"))
    weights = checkpoint.get("weight")
    if not isinstance(config, dict) or not isinstance(weights, dict) or not weights:
        raise WeightError("invalid")
    model = config.get("model", {})
    data = config.get("data", {})
    if not isinstance(model, dict) or not isinstance(data, dict):
        raise WeightError("invalid")
    counts = _symbol_counts(root)
    if kind == "gpt":
        phones, embedding = _shape(weights, "model.ar_text_embedding.word_embeddings.weight", 2)
        tokens, audio_dim = _shape(weights, "model.ar_audio_embedding.word_embeddings.weight", 2)
        output_tokens, hidden = _shape(weights, "model.ar_predict_layer.weight", 2)
        if (phones != model.get("phoneme_vocab_size") or embedding != model.get("embedding_dim")
                or audio_dim != embedding or hidden != model.get("hidden_dim")
                or tokens != model.get("vocab_size") or output_tokens != tokens
                or model.get("EOS") != tokens - 1 or data.get("max_sec", 0) <= 0):
            raise WeightError("invalid")
        if phones < counts["v1"]:
            raise WeightError("invalid")
        return {"kind": kind, "symbol_version": "v2" if phones >= counts["v2"] else "v1",
                "phonemes": phones, "semantic_tokens": tokens - 1}
    if kind != "sovits":
        raise WeightError("invalid")
    tokens, _ = _shape(weights, "quantizer.vq.layers.0._codebook.embed", 2)
    identity = tables["hash_pretrained_dict"].get(hashlib.md5(prefix).hexdigest())
    identity = identity or tables["head2version"].get(head)
    has_cfm = any(key.startswith("cfm.") for key in weights)
    has_pro = "sv_emb.weight" in weights
    if identity:
        _, version, lora = identity
    elif has_cfm:
        # Unmarked legacy full v3 checkpoints are the only CFM format recognized
        # by the upstream fallback. Newer variants use its header/hash mapping.
        version, lora = "v3", False
    elif has_pro:
        raise WeightError("invalid")
    else:
        phones, _ = _shape(weights, "enc_p.text_embedding.weight", 2)
        version, lora = ("v1" if phones == counts["v1"] else "v2"), False
    # TTS.init_vits_weights resolves legacy v1/v2 from the embedding even when
    # the fast header/hash lookup says otherwise (including the v1 base hash).
    if version in {"v1", "v2"}:
        phones, _ = _shape(weights, "enc_p.text_embedding.weight", 2)
        version = "v1" if phones == counts["v1"] else "v2"
    table = json.loads((root / "configs/upstream_versions.json").read_text(encoding="utf-8"))["versions"]
    if version not in table:
        raise WeightError("invalid")
    declared = config.get("version")
    if declared in table and declared not in {"v1", "v2"} and declared != version:
        raise WeightError("invalid")
    uses_cfm = table[version]["lora"]
    if uses_cfm != has_cfm or table[version]["needs_sv"] != has_pro:
        raise WeightError("invalid")
    symbol_version = "v1" if version == "v1" else "v2"
    if not uses_cfm:
        phones, _ = _shape(weights, "enc_p.text_embedding.weight", 2)
        if phones != counts[symbol_version]:
            raise WeightError("invalid")
        channels, _, _ = _shape(weights, "dec.conv_pre.weight", 3)
        if channels != model.get("upsample_initial_channel"):
            raise WeightError("invalid")
        if has_pro:
            template = json.loads((root / table[version]["s2_config"]).read_text(encoding="utf-8"))
            for key in ("gin_channels", "upsample_initial_channel"):
                if model.get(key) != template["model"][key]:
                    raise WeightError("invalid")
    if lora:
        rank = checkpoint.get("lora_rank")
        adapters = [value for key, value in weights.items() if ".lora_A." in key]
        if not isinstance(rank, int) or rank <= 0 or not adapters or any(value.ndim != 2 or value.shape[0] != rank for value in adapters):
            raise WeightError("invalid")
    elif checkpoint.get("lora_rank"):
        raise WeightError("invalid")
    if any(data.get(key, 0) <= 0 for key in ("filter_length", "hop_length", "sampling_rate", "win_length", "n_speakers")):
        raise WeightError("invalid")
    if config.get("train", {}).get("segment_size", 0) <= 0:
        raise WeightError("invalid")
    return {"kind": kind, "version": version, "symbol_version": symbol_version,
            "phonemes": counts[symbol_version], "semantic_tokens": tokens, "lora": lora}


def validate_replacement(source, kind, counterpart=None, requested_version=None, root=ROOT):
    candidate = inspect_weight(Path(source), kind, root)
    if kind == "sovits" and requested_version and candidate["version"] != requested_version:
        raise WeightError("version_mismatch")
    result = {kind: candidate}
    if counterpart is not None:
        other_kind = "sovits" if kind == "gpt" else "gpt"
        result[other_kind] = inspect_weight(Path(counterpart), other_kind, root)
        gpt, sovits = result["gpt"], result["sovits"]
        if gpt["phonemes"] < sovits["phonemes"] or gpt["semantic_tokens"] != sovits["semantic_tokens"]:
            raise WeightError("pair")
    if "sovits" in result:
        result["version"] = result["sovits"]["version"]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--kind", choices=("gpt", "sovits"), required=True)
    parser.add_argument("--counterpart", type=Path)
    parser.add_argument("--version")
    args = parser.parse_args()
    try:
        result = validate_replacement(args.source, args.kind, args.counterpart, args.version)
        print(json.dumps({"ok": True, **result}))
        return 0
    except WeightError as exc:
        print(json.dumps({"ok": False, "error": exc.code}))
    except (ImportError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        print(json.dumps({"ok": False, "error": "runtime" if isinstance(exc, ImportError) else "invalid"}))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        print(json.dumps({"ok": False, "error": "invalid"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
