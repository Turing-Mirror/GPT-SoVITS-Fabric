"""Synthetic worker protocol regressions; no GPU or upstream engine is started."""
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("diagnostic_train_worker", ROOT / "app/src-tauri/engine-payload/tools/train_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class TrainingEvidenceTests(unittest.TestCase):
    def test_oom_uses_the_failed_stage_batch_and_retains_the_whole_step(self):
        for stage, batch in [("sovits", 4), ("gpt", 12)]:
            worker._CURRENT.clear()
            worker._CURRENT.update(sovits_batch=4, gpt_batch=12)
            text = "torch.cuda.OutOfMemoryError: CUDA out of memory\n" + "cleanup frame\n" * 64
            process = SimpleNamespace(stdout=io.StringIO(text), wait=lambda: 1)
            with patch.object(worker.subprocess, "Popen", return_value=process), patch("sys.stderr", io.StringIO()):
                with self.assertRaises(worker.Fail) as raised:
                    worker.run_step(["python", "training.py"], {}, stage=stage, label="training")
            self.assertEqual(raised.exception.params["batch"], str(batch))
            self.assertEqual(raised.exception.params["stage"], stage)
            self.assertIn("torch.cuda.OutOfMemoryError", raised.exception.fallback)
            self.assertEqual(raised.exception.fallback.count("cleanup frame"), 64)

    def test_exit_one_is_not_oom(self):
        process = SimpleNamespace(stdout=io.StringIO("unknown failure\n"), wait=lambda: 1)
        with patch.object(worker.subprocess, "Popen", return_value=process), patch("sys.stderr", io.StringIO()):
            with self.assertRaises(worker.Fail) as raised:
                worker.run_step(["python"], {}, stage="gpt", label="training")
        self.assertEqual(raised.exception.code, "train.step_failed")

if __name__ == "__main__":
    unittest.main()
