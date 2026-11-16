"""Small checkpoint fixtures for the replacement inspector; no training or synthesis."""
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

import torch

ROOT = Path(__file__).resolve().parents[1] / "app/src-tauri/engine-payload"
spec = importlib.util.spec_from_file_location("weight_inspect", ROOT / "tools/weight_inspect.py")
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


def gpt(phones=732, tokens=1024):
    return {"config": {"model": {"phoneme_vocab_size": phones, "embedding_dim": 2,
            "hidden_dim": 2, "vocab_size": tokens + 1, "EOS": tokens}, "data": {"max_sec": 54}},
            "weight": {"model.ar_text_embedding.word_embeddings.weight": torch.zeros(phones, 2),
                       "model.ar_audio_embedding.word_embeddings.weight": torch.zeros(tokens + 1, 2),
                       "model.ar_predict_layer.weight": torch.zeros(tokens + 1, 2)}}


def sovits(version="v2"):
    import json
    table = json.loads((ROOT / "configs/upstream_versions.json").read_text(encoding="utf-8"))["versions"]
    config = json.loads((ROOT / table[version]["s2_config"]).read_text(encoding="utf-8"))
    weights = {"quantizer.vq.layers.0._codebook.embed": torch.zeros(1024, 2)}
    if table[version]["lora"]:
        weights["cfm.base_model.model.to_q.lora_A.default.weight"] = torch.zeros(2, 4)
    else:
        weights["enc_p.text_embedding.weight"] = torch.zeros(322 if version == "v1" else 732, 2)
        weights["dec.conv_pre.weight"] = torch.zeros(config["model"]["upsample_initial_channel"], 2, 1)
    if table[version]["needs_sv"]:
        weights["sv_emb.weight"] = torch.zeros(2, 2)
    checkpoint = {"config": config, "weight": weights}
    if table[version]["lora"]:
        checkpoint["lora_rank"] = 2
    return checkpoint


class WeightInspectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def save(self, name, checkpoint, head=None):
        path = self.root / name
        buffer = io.BytesIO()
        torch.save(checkpoint, buffer)
        data = buffer.getvalue()
        path.write_bytes(head + data[2:] if head else data)
        return path

    def check(self, path, kind, other=None, version=None):
        return inspector.validate_replacement(path, kind, other, version, ROOT)

    def test_all_upstream_header_versions(self):
        for head, (_, version, lora) in inspector._tables(ROOT)["head2version"].items():
            with self.subTest(version=version, lora=lora):
                checkpoint = sovits(version)
                if version == "v3" and not lora:
                    checkpoint.pop("lora_rank")
                    checkpoint["weight"] = {k.replace(".lora_A.default", ""): v for k,v in checkpoint["weight"].items()}
                path = self.save("model.pth", checkpoint, head)
                result = self.check(path, "sovits")
                self.assertEqual(result["version"], version)

    def test_legacy_versions_use_tensor_shapes_not_file_size(self):
        for version in ("v1", "v2"):
            path = self.save("model.pth", sovits(version))
            self.assertEqual(self.check(path, "sovits")["version"], version)

    def test_legacy_embedding_overrides_fast_header_like_tts(self):
        path = self.save("model.pth", sovits("v1"), b"01")
        self.assertEqual(self.check(path, "sovits")["version"], "v1")

    def test_new_version_header_must_match_saved_config(self):
        checkpoint = sovits("v5dev")
        checkpoint["config"]["version"] = "v5dev"
        path = self.save("model.pth", checkpoint, b"08")
        with self.assertRaises(inspector.WeightError):
            self.check(path, "sovits")

    def test_shared_gpt_pairs_with_pro_and_v5(self):
        a = self.save("gpt.ckpt", gpt())
        for version, head in (("v2Pro", b"05"), ("v2ProPlus", b"06"), ("v5dev", b"07"), ("v5turbo", b"08")):
            b = self.save("sovits.pth", sovits(version), head)
            self.assertEqual(self.check(a, "gpt", b)["version"], version)

    def test_old_gpt_rejects_new_phoneme_vocabulary(self):
        a = self.save("gpt.ckpt", gpt(512))
        b = self.save("sovits.pth", sovits())
        with self.assertRaisesRegex(inspector.WeightError, "pair"):
            self.check(a, "gpt", b)

    def test_new_gpt_can_use_legacy_sovits(self):
        a = self.save("gpt.ckpt", gpt())
        b = self.save("sovits.pth", sovits("v1"))
        self.assertEqual(self.check(a, "gpt", b)["version"], "v1")

    def test_semantic_codebooks_must_match(self):
        a = self.save("gpt.ckpt", gpt(tokens=1023))
        b = self.save("sovits.pth", sovits())
        with self.assertRaisesRegex(inspector.WeightError, "pair"):
            self.check(a, "gpt", b)

    def test_requested_version_cannot_relabel_weights(self):
        path = self.save("model.pth", sovits("v2Pro"), b"05")
        with self.assertRaisesRegex(inspector.WeightError, "version_mismatch"):
            self.check(path, "sovits", version="v5dev")

    def test_wrong_kind_and_empty_state_dict_rejected(self):
        path = self.save("renamed.ckpt", sovits())
        with self.assertRaises(inspector.WeightError):
            self.check(path, "gpt")
        path = self.save("empty.ckpt", {"config": {}, "weight": {}})
        with self.assertRaises(inspector.WeightError):
            self.check(path, "gpt")

    def test_invalid_or_truncated_zip_rejected(self):
        path = self.save("truncated.ckpt", gpt())
        path.write_bytes(path.read_bytes()[:100])
        with self.assertRaises(Exception):
            self.check(path, "gpt")
        path.write_bytes(b"not a checkpoint")
        with self.assertRaises(inspector.WeightError):
            self.check(path, "gpt")

    def test_header_must_match_architecture(self):
        path = self.save("wrong.pth", sovits("v2Pro"), b"07")
        with self.assertRaises(inspector.WeightError):
            self.check(path, "sovits")
        path = self.save("wrong.pth", sovits("v2Pro"), b"06")
        with self.assertRaises(inspector.WeightError):
            self.check(path, "sovits")

    def test_lora_rank_must_match_adapters(self):
        checkpoint = sovits("v5dev")
        checkpoint["lora_rank"] = 3
        path = self.save("wrong.pth", checkpoint, b"07")
        with self.assertRaises(inspector.WeightError):
            self.check(path, "sovits")

    def test_gpt_config_must_match_tensors(self):
        checkpoint = gpt()
        checkpoint["config"]["model"]["phoneme_vocab_size"] = 512
        path = self.save("wrong.ckpt", checkpoint)
        with self.assertRaises(inspector.WeightError):
            self.check(path, "gpt")

    def test_pickle_code_is_never_executed(self):
        marker = self.root / "executed.txt"
        class Unsafe:
            def __reduce__(self):
                return (eval, (f"open({str(marker)!r}, 'w').write('bad')",))
        path = self.save("unsafe.ckpt", {"config": Unsafe(), "weight": {}})
        with self.assertRaises(Exception):
            self.check(path, "gpt")
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
