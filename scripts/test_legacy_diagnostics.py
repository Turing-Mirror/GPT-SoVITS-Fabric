"""CPU-only checks for the legacy UI's per-operation evidence boundary."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fabric_errors", ROOT / "app/src-tauri/engine-payload/tools/fabric_errors.py")
errors = importlib.util.module_from_spec(spec)
spec.loader.exec_module(errors)


class LegacyEvidenceTests(unittest.TestCase):
    def test_successful_fallback_and_previous_runs_are_excluded(self):
        @errors.operation("training", "gpt")
        def run(batch_size):
            errors.Popen([sys.executable, "-c", "print('CUDA out of memory')"]).wait()
            child = errors.Popen([sys.executable, "-c", "print('ValueError: this run'); raise SystemExit(1)"])
            child.wait()
            yield errors.diagnose("exit 1")
        with patch.dict(errors.os.environ, {"FABRIC_DIAGNOSTICS_EXE": ""}):
            diagnostic = next(run(12))
        self.assertNotIn("CUDA out of memory", diagnostic["detail"]["text"])
        self.assertIn("ValueError: this run", diagnostic["detail"]["text"])
        self.assertIsNone(errors._run.get())

    def test_html_hides_raw_evidence_and_copy_includes_it(self):
        with patch.dict(errors.os.environ, {"FABRIC_DIAGNOSTICS_EXE": ""}):
            view = errors.failure_html("<script>bad()</script>\nValueError: exit 1", "separation")
        self.assertNotIn("<script>", view)
        self.assertIn("data-copy=", view)
        self.assertIn("<details>", view)
        self.assertNotIn("ValueError", view.split("<button")[0])
        self.assertIn("ValueError", view.split("<pre")[1])


if __name__ == "__main__":
    unittest.main()
