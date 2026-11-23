"""Catalog mirror compilation; fixtures never touch a release repository."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gsv_build_catalog", Path(__file__).with_name("build_catalog.py"))
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)


def artifact(name, digest):
    return {"name": name, "sha256": digest * 64, "size_bytes": 12}


def sources():
    return {
        "app": {**artifact("setup.exe", "A"), "version": "1.0.0"},
        "runtimes": {"nvidia": {"parts": [artifact("runtime.tar", "b")]},
                     "cpu": {"parts": [artifact("cpu.tar", "c")]}},
        "engine_core": {"packs": [artifact("base.zip", "d")]},
        "extras": {"extra": {"dest": "models", "files": [artifact("extra.pth", "e")]}},
        "gsv-cpp": {"engine": artifact("engine.zip", "f"), "shared": artifact("shared.zip", "1")},
        "roles": [{"id": "role", "pack": "role.zip", **artifact("role", "2")}],
    }


class CatalogMirrorTests(unittest.TestCase):
    def test_all_download_sections_prefer_mapped_hash_and_keep_cnb(self):
        mirrors = {char * 64: f"https://modelscope.cn/models/Kara251/kara-gsv-model/resolve/commit/{char}"
                   for char in "abdef1"}
        rep = bc.Report()
        baseline = bc.build(sources(), rep)
        result = bc.build(sources(), rep, mirrors)
        self.assertEqual(rep.errors, [])
        paths = [
            ("app",), ("runtimes", "nvidia", "parts", 0),
            ("engine_core", "base"), ("extras", "extra", "files", 0),
            ("gsv-cpp", "engine"), ("gsv-cpp", "shared"),
        ]
        for path in paths:
            actual, old = result, baseline
            for key in path:
                actual, old = actual[key], old[key]
            self.assertEqual(actual["urls"], [mirrors[actual["sha256"]], *old["urls"]])
            self.assertEqual(actual["sha256"], old["sha256"])
            self.assertEqual(actual["size_bytes"], old["size_bytes"])
        self.assertEqual(result["runtimes"]["cpu"], baseline["runtimes"]["cpu"])
        self.assertEqual(result["roles"], baseline["roles"])
        self.assertEqual(result["app"]["gui"]["url"], mirrors["a" * 64])
        self.assertEqual(result["manifest_urls"], [
            "https://www.turingmirror.com/releases/gpt-sovits-fabric/index.json",
            f"{bc.CNB_BASE}/-/git/raw/main/index.json",
            f"{bc.CNB_BASE}/-/git/raw/main/catalog/online_catalog.snippet.json",
        ])

    def test_legacy_core_and_reapplying_mapping(self):
        src = sources()
        src["engine_core"] = artifact("legacy.zip", "d")
        mirrors = {"d" * 64: "https://modelscope.cn/models/Kara251/kara-gsv-model/resolve/commit/legacy.zip"}
        result = bc.build(src, bc.Report(), mirrors)
        bc.apply_modelscope(result, mirrors)
        self.assertEqual(result["engine_core"]["urls"], [
            mirrors["d" * 64], bc.asset_url(bc.TAG_CORE, "legacy.zip")
        ])

    def test_cli_loads_mapping_next_to_sources_and_missing_file_is_optional(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "catalog" / "sources.json"
            source.parent.mkdir()
            source.write_text(json.dumps(sources()), encoding="utf-8")
            output = root / "index.json"
            bundled = root / "bundle.json"
            args = ["build_catalog.py", "--sources", str(source), "--out", str(output),
                    "--bundle", str(bundled)]
            mirror = "https://modelscope.cn/models/Kara251/kara-gsv-model/resolve/commit/runtime.tar"
            for mapping in (None, {"repo": "Kara251/kara-gsv-model", "files": {"b" * 64: mirror}}):
                if mapping:
                    (source.parent / "modelscope.json").write_text(json.dumps(mapping), encoding="utf-8")
                with patch.object(sys, "argv", args), patch.object(bc, "loopback"):
                    self.assertEqual(bc.main(), 0)
                result = json.loads(output.read_text(encoding="utf-8"))
                urls = result["runtimes"]["nvidia"]["parts"][0]["urls"]
                expected = [bc.asset_url(bc.TAG_RUNTIME, "runtime.tar")]
                self.assertEqual(urls, [mirror, *expected] if mapping else expected)
                self.assertEqual(json.loads(bundled.read_text(encoding="utf-8"))["runtimes"], result["runtimes"])


if __name__ == "__main__":
    unittest.main()
