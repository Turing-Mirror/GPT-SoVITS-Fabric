"""Exercise worker collection and the real upstream export branches without GPU training."""
import ast
from collections import OrderedDict
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

PAYLOAD = Path(__file__).resolve().parents[1] / "app/src-tauri/engine-payload"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


worker = load_module("epoch_train_worker", PAYLOAD / "tools/train_worker.py")
prepare = load_module("epoch_prepare", Path(__file__).with_name("prepare_engine_payload.py"))


class EpochVersionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.weights = self.root / "weights"
        self.weights.mkdir()
        self.exp = "Voice.[a]+(1)"
        self.req = {"exp": self.exp, "version": "v2", "role_dir": str(self.root / "voice")}
        self.started = time.time_ns()

    def weight(self, name, body=b"weight", *, modified=None):
        path = self.weights / name
        path.write_bytes(body)
        # Explicit nanosecond times keep freshness tests independent of filesystem rounding.
        stamp = self.started + 1_000_000 if modified is None else modified
        os.utime(path, ns=(stamp, stamp))
        return path

    def test_collect_merges_existing_metadata_and_records_the_original_source(self):
        role = Path(self.req["role_dir"])
        role.mkdir()
        old = {"author": "Author", "cover": "cover.png", "custom": {"key": 42},
               "name": "Edited display name", "lists": [{"file": "dataset/old.list"}],
               "training": {"custom": "keep", "selected": {"gpt": {"epoch": 2}}}}
        (role / "config.json").write_text(json.dumps(old), encoding="utf-8")
        self.weight(f"{self.exp}_e200_s999.pth", b"stale", modified=self.started - 1)
        self.weight(f"{self.exp}_e7_s70_l32.pth", b"new sovits")
        self.weight(f"{self.exp}-e5.ckpt", b"new gpt")
        # Another experiment and training archives are newer but must never win.
        self.weight(f"{self.exp}other_e99_s999.pth", modified=self.started + 2_000_000)
        self.weight("G_999.pth", modified=self.started + 3_000_000)
        self.weight("epoch=99.ckpt", modified=self.started + 3_000_000)
        result = worker.collect(self.req, self.weights, None, started_ns=self.started)
        cfg = json.loads((role / "config.json").read_text(encoding="utf-8"))
        for key in ("author", "cover", "custom", "name", "lists"):
            self.assertEqual(cfg[key], old[key])
        self.assertEqual(cfg["training"]["experiment"], self.exp)
        self.assertEqual(cfg["training"]["weights_dir"], str(self.weights.resolve()))
        self.assertEqual(cfg["training"]["custom"], "keep")
        self.assertNotIn("selected", cfg["training"])
        self.assertEqual(cfg["training"]["final"]["sovits"],
                         {"file": f"{self.exp}_e7_s70_l32.pth", "epoch": 7, "step": 70})
        self.assertEqual(cfg["training"]["final"]["gpt"],
                         {"file": f"{self.exp}-e5.ckpt", "epoch": 5, "step": None})
        self.assertEqual(Path(result["sovits"]).read_bytes(), b"new sovits")
        self.assertEqual(Path(result["gpt"]).read_bytes(), b"new gpt")

    def test_collect_chooses_by_fresh_modification_time_instead_of_epoch(self):
        self.weight(f"{self.exp}_e100_s100.pth")
        self.weight(f"{self.exp}_e2_s2.pth", b"latest", modified=self.started + 2_000_000)
        self.weight(f"{self.exp}-e2.ckpt")
        result = worker.collect(self.req, self.weights, None, started_ns=self.started)
        self.assertEqual(Path(result["sovits"]).read_bytes(), b"latest")

    def test_collect_keeps_an_earlier_export_when_a_resumed_stage_trained_nothing(self):
        self.weight(f"{self.exp}_e7_s70.pth", b"earlier sovits", modified=self.started - 1)
        self.weight(f"{self.exp}-e7.ckpt", b"fresh gpt")
        result = worker.collect(self.req, self.weights, None, started_ns=self.started)
        self.assertEqual(Path(result["sovits"]).read_bytes(), b"earlier sovits")
        self.assertEqual(Path(result["gpt"]).read_bytes(), b"fresh gpt")

    def test_collect_fails_without_any_export(self):
        self.weight(f"{self.exp}-e7.ckpt")
        with self.assertRaises(worker.Fail) as error:
            worker.collect(self.req, self.weights, None, started_ns=self.started)
        self.assertEqual(error.exception.code, "train.no_weight")
        self.assertFalse(Path(self.req["role_dir"]).exists())

    def test_snapshot_flag_defaults_to_true_and_preserves_explicit_false(self):
        raw = {"exp": self.exp, "version": "v2"}
        self.assertTrue(worker.normalize(raw)["save_every_weights"])
        self.assertFalse(worker.normalize({**raw, "save_every_weights": False})["save_every_weights"])

    def test_both_stage_configs_forward_the_snapshot_flag_and_output_directory(self):
        import yaml
        req = worker.normalize({"exp": self.exp, "version": "v2"})
        opt = self.root / "experiment"
        opt.mkdir()
        # Read real version-specific templates; only skip subprocesses and base-weight presence.
        def need(rel, *_args, **_kwargs):
            return PAYLOAD / rel
        for enabled in (True, False):
            with self.subTest(enabled=enabled), patch.object(worker, "need", side_effect=need), \
                    patch.object(worker, "run_step"), patch.object(worker, "emit"):
                req["save_every_weights"] = enabled
                worker.stage_sovits(req, opt, self.weights)
                worker.stage_gpt(req, opt, self.weights)
                s2 = json.loads((opt / "s2_config.json").read_text(encoding="utf-8"))
                s1 = yaml.safe_load((opt / "s1_config.yaml").read_text(encoding="utf-8"))
                self.assertEqual(s2["train"]["if_save_every_weights"], enabled)
                self.assertEqual(s1["train"]["if_save_every_weights"], enabled)
                self.assertEqual(s2["save_weight_dir"], str(self.weights))
                self.assertEqual(s1["train"]["half_weights_save_dir"], str(self.weights))

    def test_sovits_and_lora_execute_final_export_with_both_flag_values(self):
        # Execute the actual save block from each shipped script, with lightweight tensors.
        tensor = Mock()
        tensor.half.return_value.cpu.return_value = tensor
        for name in ("s2_train.py", "s2_train_v3_lora.py"):
            tree = ast.parse((PAYLOAD / "GPT_SoVITS" / name).read_text(encoding="utf-8"))
            block = next(node for node in ast.walk(tree) if isinstance(node, ast.If)
                         and "hps.train.save_every_epoch" in ast.unparse(node.test))
            code = compile(ast.fix_missing_locations(ast.Module(body=[block], type_ignores=[])), name, "exec")
            for enabled in (True, False):
                for epoch, total, rank, expected in [(7, 7, 0, True), (4, 7, 0, enabled),
                                                     (3, 7, 0, False), (8, 8, 0, True), (7, 7, 1, False)]:
                    with self.subTest(script=name, enabled=enabled, epoch=epoch, total=total, rank=rank):
                        save = Mock(return_value="ok")
                        net = SimpleNamespace(state_dict=lambda: {"weight": tensor})
                        scope = {"epoch": epoch, "rank": rank, "global_step": 70,
                                 "hps": SimpleNamespace(name=self.exp, data=SimpleNamespace(exp_dir=str(self.root)),
                                     model=SimpleNamespace(version="v2"),
                                     train=SimpleNamespace(epochs=total, save_every_epoch=4,
                                         if_save_latest=0, learning_rate=1e-4, if_save_every_weights=enabled)),
                                 "net_g": net, "net_d": net, "optim_g": None, "optim_d": None,
                                 "utils": Mock(), "os": os, "logger": Mock(), "savee": save,
                                 "od": OrderedDict, "no_grad_names": set(), "lora_rank": 32,
                                 "save_root": str(self.root)}
                        exec(code, scope)
                        self.assertEqual(save.called, expected)

    def test_gpt_callback_exports_final_epoch_with_both_flag_values(self):
        class Checkpoint:
            def __init__(self, **kwargs):
                self._every_n_epochs = kwargs["every_n_epochs"]
                self.dirpath = kwargs["dirpath"]
            def _should_save_on_train_epoch_end(self, _trainer): return True
            def _monitor_candidates(self, _trainer): return {}
            def _save_topk_checkpoint(self, *_args): pass
            def _save_last_checkpoint(self, *_args): pass
        tree = ast.parse((PAYLOAD / "GPT_SoVITS/s1_train.py").read_text(encoding="utf-8"))
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "my_model_ckpt")
        save = Mock()
        scope = {"ModelCheckpoint": Checkpoint, "OrderedDict": OrderedDict, "os": os, "my_save": save}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), "s1_train.py", "exec"), scope)
        for enabled in (True, False):
            for epoch, total, expected in [(7, 7, True), (4, 7, enabled), (3, 7, False), (8, 8, True)]:
                with self.subTest(enabled=enabled, epoch=epoch, total=total), patch.dict(os.environ, {"LOCAL_RANK": "0"}):
                    save.reset_mock()
                    callback = scope["my_model_ckpt"]({"train": {"epochs": total}}, False, enabled,
                        str(self.weights), self.exp, every_n_epochs=4, dirpath=str(self.weights))
                    trainer = SimpleNamespace(current_epoch=epoch - 1,
                        strategy=SimpleNamespace(_lightning_module=SimpleNamespace(state_dict=lambda: {})))
                    callback.on_train_epoch_end(trainer, None)
                    self.assertEqual(save.called, expected)
                    if expected:
                        self.assertEqual(Path(save.call_args.args[1]).name, f"{self.exp}-e{epoch}.ckpt")

    def test_preparing_payload_reapplies_the_final_export_fix_idempotently(self):
        source = self.root / "GPT_SoVITS"
        source.mkdir()
        for name in ("s1_train.py", "s2_train.py", "s2_train_v3_lora.py"):
            # Reverse just the maintained changes to simulate the pinned upstream source.
            text = (PAYLOAD / "GPT_SoVITS" / name).read_text(encoding="utf-8")
            if name == "s1_train.py":
                text = text.replace('            is_final = trainer.current_epoch + 1 == self.config["train"]["epochs"]\n', "")
                text = text.replace("if is_final or (self._every_n_epochs >= 1 and (trainer.current_epoch + 1) % self._every_n_epochs == 0):",
                                    "if self._every_n_epochs >= 1 and (trainer.current_epoch + 1) % self._every_n_epochs == 0:")
                text = text.replace("if self.if_save_every_weights == True or is_final:", "if self.if_save_every_weights == True:")
            else:
                text = text.replace("(epoch % hps.train.save_every_epoch == 0 or epoch == hps.train.epochs)",
                                    "epoch % hps.train.save_every_epoch == 0")
                text = text.replace("(hps.train.if_save_every_weights == True or epoch == hps.train.epochs)",
                                    "hps.train.if_save_every_weights == True")
            (source / name).write_text(text, encoding="utf-8")
        with patch.object(prepare, "PAYLOAD", self.root):
            prepare.patch_training_exports()
            first = {p.name: p.read_bytes() for p in source.iterdir()}
            prepare.patch_training_exports()
            self.assertEqual(first, {p.name: p.read_bytes() for p in source.iterdir()})
            for name in first:
                self.assertEqual((source / name).read_text(encoding="utf-8"),
                                 (PAYLOAD / "GPT_SoVITS" / name).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
