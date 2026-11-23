import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import cnb_release as release
from test_build_catalog import sources


class LocalCatalogTests(unittest.TestCase):
    def test_same_version_migrates_urls_without_duplicate_changelog(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            (repo / "catalog").mkdir()
            source = sources()
            source["app"]["sha256"] = "a" * 64
            release.write_json(repo / "catalog/sources.json", source)
            release.write_json(repo / "changelog.json", {"entries": [{"version": "1.0.0"}]})
            signed = dict(name=release.setup_name("1.0.0"), sha256="a" * 64, size_bytes=12,
                          signature="signature", pub_date="2026-11-24T00:00:00Z")
            for _ in range(2):
                release.prepare_catalog(repo, "1.0.0", signed, ["Change"])
            updater = release.read_json(repo / "updater.json")
            app = release.read_json(repo / "index.json")["app"]
            self.assertEqual(app["gui"]["url"], updater["platforms"]["windows-x86_64"]["url"])
            self.assertNotIn("cnb.cool", json.dumps(app))
            self.assertEqual(len(release.read_json(repo / "changelog.json")["entries"]), 1)
            with self.assertRaisesRegex(ValueError, "differs"):
                release.prepare_catalog(repo, "1.0.0", {**signed, "sha256": "b" * 64}, ["Change"])

    def test_publish_uses_local_checkout_and_never_clones_or_pushes(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            (repo / ".git").mkdir()
            with patch.object(sys, "argv", ["release", "--publish", "--version", "1.0.0", "--catalog", str(repo)]), \
                 patch.object(release, "release_notes", return_value=["Change"]), \
                 patch.object(release, "verify_release", return_value={}), \
                 patch.object(release, "prepare_catalog", return_value=["index.json"]) as prepare, \
                 patch.object(release, "mirror_setup") as mirror, \
                 patch.object(release, "run", side_effect=["", None, "index.json", None]) as run:
                release.main()
            self.assertEqual(prepare.call_args.args[0], repo.resolve())
            mirror.assert_called_once()
            commands = [call.args for call in run.call_args_list]
            self.assertFalse(any("clone" in command or "push" in command for command in commands))
            self.assertTrue(any("commit" in command for command in commands))

    def test_dry_run_leaves_local_checkout_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            (repo / ".git").mkdir()
            (repo / "index.json").write_text("original")
            def prepare(target, *args):
                self.assertNotEqual(target, repo)
                (target / "index.json").write_text("changed")
                return ["index.json"]
            with patch.object(sys, "argv", ["release", "--version", "1.0.0", "--catalog", str(repo)]), \
                 patch.object(release, "release_notes", return_value=["Change"]), \
                 patch.object(release, "verify_release", return_value={}), \
                 patch.object(release, "prepare_catalog", side_effect=prepare), \
                 patch.object(release, "mirror_setup") as mirror, \
                 patch.object(release, "run", return_value=""):
                release.main()
            self.assertEqual((repo / "index.json").read_text(), "original")
            mirror.assert_not_called()
