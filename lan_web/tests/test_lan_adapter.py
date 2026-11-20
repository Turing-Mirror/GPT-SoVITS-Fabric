"""Filesystem and API contract regression tests; never touches production data."""
import os
import subprocess
import sys
import time
import io
import json
import zipfile
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from lan_web import server as lan

from fastapi.testclient import TestClient


class LanAdapter(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.patch = patch.multiple(
            lan, ROOT=self.root, USER_DATA=self.root / "User_Data", CHARACTERS=self.root / "User_Data/characters",
            TRAIN_ROOT=self.root / "User_Data/train", OUTPUTS=self.root / "User_Data/outputs",
            CONFIG_FILE=self.root / "User_Data/app_config.json", train_jobs={}, train_processes={},
        )
        self.patch.start()
        self.addCleanup(self.patch.stop)
        client_context = TestClient(lan.app, base_url="http://127.0.0.1:8790")
        self.client = client_context.__enter__()
        self.addCleanup(client_context.__exit__, None, None, None)

    def make(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def invoke(self, command, **args):
        response = self.client.post("/api/invoke", json={"command": command, "args": args})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]

    def test_private_bind_is_explicit_and_wildcard_is_rejected(self):
        self.assertEqual(lan._listen_origin("127.0.0.1", 8790, False), "http://127.0.0.1:8790")
        with self.assertRaises(ValueError):
            lan._listen_origin("10.0.0.2", 8790, False)
        self.assertEqual(lan._listen_origin("10.0.0.2", 8790, True), "http://10.0.0.2:8790")
        with self.assertRaises(ValueError):
            lan._listen_origin("0.0.0.0", 8790, True)

    def test_only_same_origin_api_and_managed_media_are_available(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        self.assertEqual(self.client.get("/api/health", headers={"host": "foreign.example.test"}).status_code, 403)
        self.assertEqual(self.client.post("/api/invoke", headers={"origin": "http://foreign.example.test"}, json={"command":"config_get"}).status_code, 403)
        from starlette.websockets import WebSocketDisconnect
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect("ws://127.0.0.1:8790/api/events", headers={"origin": "http://foreign.example.test"}):
                self.fail("cross-origin connection was accepted")
        config = self.make("User_Data/lan_web_config.json", b"{}")
        ref = self.make("User_Data/characters/voice/reference.wav", b"fixture audio")
        self.assertEqual(self.client.get("/api/file", params={"path": str(config)}).status_code, 403)
        self.assertEqual(self.client.get("/api/file", params={"path": str(ref)}).content, b"fixture audio")

    def test_disk_is_real_and_group_totals_are_disjoint(self):
        self.make("User_Data/characters/role/gpt.ckpt", b"12")
        self.make("User_Data/train/example/weights/model.pth", b"1234")
        self.make("User_Data/outputs/role/voice.wav", b"123")
        self.make("Runtime/fixture", b"1")
        self.make("GPT_SoVITS/pretrained_models/fixture", b"12345")
        self.make("User_Data/app_config.json", b"{}")
        usage = self.invoke("storage_usage")
        self.assertEqual({r["name"]:r["bytes"] for r in usage["items"]}, {
            "characters": 2, "training": 4, "outputs": 3, "runtime": 1, "pretrained": 5, "other": 2,
        })
        self.assertEqual(usage["total_bytes"], 17)
        self.assertGreater(usage["free_bytes"], 0)

    def test_scan_lists_residue_but_does_not_classify_final_models_or_logs_as_residue(self):
        self.make("User_Data/train/example/logs_s2_v5turbo/latest.pth", b"12345")
        self.make("User_Data/train/example/3-bert/encoded.pt", b"123")
        self.make("User_Data/train/example/2-name2text.txt", b"12")
        model = self.make("User_Data/train/example/weights/final.pth", b"should be retained")
        self.make("User_Data/train/example/stage.log", b"should be retained")
        self.make("User_Data/train/mute/5-wav32k/example.wav", b"not an experiment")
        self.assertEqual(self.invoke("train_cleanup_scan"), [{
            "exp": "example", "total_bytes": 10,
            "kinds": {"checkpoints": {"bytes": 5, "files": 1}, "dataset": {"bytes": 5, "files": 2}},
        }])
        blocked = self.client.post("/api/invoke", json={"command": "train_cleanup_apply", "args": {"exp": "example", "kinds": ["dataset"]}})
        self.assertEqual(blocked.status_code, 501)
        self.assertTrue(model.exists())
        self.assertTrue((self.root / "User_Data/train/example/2-name2text.txt").exists())

    def test_history_returns_seconds_wav_duration_and_flac_metadata(self):
        wav = self.make("User_Data/outputs/role/test.wav", b"")
        with wave.open(str(wav), "wb") as audio:
            audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\0\0" * 4000)
        flac = self.make("User_Data/outputs/role/export.flac", b"sample")
        self.make("User_Data/outputs/role/export.json", b'{"audio_sec": 2, "text": "a sample"}')
        os.utime(wav, (1_700_000_000, 1_700_000_000))
        os.utime(flac, (1_700_000_001, 1_700_000_001))
        rows = self.invoke("synth_recent", limit=2)
        self.assertEqual([row["name"] for row in rows], ["export.flac", "test.wav"])
        self.assertEqual(rows[0]["record"]["text"], "a sample")
        self.assertEqual(rows[1]["record"]["audio_sec"], 0.5)
        self.assertEqual(rows[1]["mtime"], 1_700_000_000)
        self.assertEqual(len(self.invoke("synth_recent", limit=1)), 1)

    def test_diagnostics_summary_reports_real_facts_without_paths(self):
        self.make("Runtime/python.exe", b"fixture")
        with patch.object(lan, "_gpu_names", return_value=["GPU fixture"]):
            text = self.invoke("diagnostics_summary_text")
        self.assertIn("Fabric Runtime: Present", text)
        self.assertIn("Synthesis worker: Missing", text)
        self.assertIn("NVIDIA GPU: GPU fixture", text)
        self.assertIn("Turbo resources: 5 missing", text)
        self.assertRegex(text, r"Free disk space: [0-9.]+ GiB")
        self.assertNotIn(str(self.root), text)

    def test_self_check_flags_missing_components_and_rejects_desktop_maintenance(self):
        findings = self.invoke("diagnostics_self_check")
        self.assertEqual({finding["code"] for finding in findings if finding["level"] == "error"}, {
            "lan.runtime_missing", "lan.worker_missing", "lan.train_worker_missing", "lan.turbo_resources",
        })
        for command in ("diagnostics_build", "legacy_open_panel", "legacy_open_webui", "reveal_user_dir", "engine_force_kill"):
            response = self.client.post("/api/invoke", json={"command": command})
            self.assertEqual(response.status_code, 501, command)

    def test_config_write_matches_ui_contract_and_persists(self):
        result = self.invoke("config_set", patch={"theme_mode": "dark"})
        self.assertEqual(result["config"]["theme_mode"], "dark")
        self.assertEqual(result["needs_restart"], [])
        self.assertEqual(self.invoke("config_get")["theme_mode"], "dark")

    def test_unconnected_picker_and_mutations_do_not_claim_success(self):
        for cmd in ("train_pick_dataset", "annot_pick", "role_update", "role_delete", "plaza_fetch", "pick_wallpaper", "synth_cancel"):
            self.assertEqual(self.client.post("/api/invoke", json={"command": cmd}).status_code, 501, cmd)

    def fixture_worker(self, kind, code):
        self.make(f"tools/{kind}_worker.py", code.encode("utf-8"))
        popen = subprocess.Popen
        def launch(argv, *args, **kwargs):
            if argv[0] == str(lan.ROOT / "Runtime/python.exe"):
                argv = [sys.executable, *argv[1:]]
            return popen(argv, *args, **kwargs)
        return patch.object(lan.subprocess, "Popen", side_effect=launch)

    def wait_state(self, job_id, target):
        end = time.monotonic() + 12
        while time.monotonic() < end:
            job = next(j for j in self.invoke("train_queue_list")["jobs"] if j["id"] == job_id)
            if job["state"] == target:
                return job
            time.sleep(.02)
        self.fail(f"expected {target}: {job}")

    def synth_role(self):
        self.make("User_Data/characters/role/config.json", b'{"id":"role","name":"Fixture"}')

    def test_synthesis_progress_is_sent_before_result_and_logs_cannot_block(self):
        self.synth_role()
        # A synthetic worker waits for the test to see the first real WebSocket
        # chunk before writing any audio. Old buffered behavior times out here.
        code = """import json, sys, time
from pathlib import Path
_ = sys.stdin.readline(); req = json.loads(sys.stdin.readline())
sys.stderr.write('log' * 200000); sys.stderr.flush()
print(json.dumps({'event':'chunk', 'job':req['job']}),flush=True)
end=time.monotonic()+4
while not Path('continue').exists():
    if time.monotonic()>end: raise RuntimeError('Progress was never delivered')
    time.sleep(.01)
print(json.dumps({'event':'chunk', 'job':req['job']}),flush=True)
out = Path(req['out_dir'])/'fixture.wav'; out.write_bytes(b'audio fixture')
print(json.dumps({'event':'done', 'job':req['job'], 'out':str(out), 'audio_sec':1.5}),flush=True)
"""
        # Deadline also bounds websocket receive if the worker fails before an event.
        from concurrent.futures import ThreadPoolExecutor
        with self.fixture_worker("synth", code), ThreadPoolExecutor() as pool, self.client.websocket_connect("ws://127.0.0.1:8790/api/events") as ws:
            progress = "a" * 32
            result = pool.submit(self.invoke, "synth_start", roleId="role", text="example", progressId=progress)
            event = pool.submit(ws.receive_json).result(timeout=6)
            self.assertEqual(event, {"event": "synth-chunk", "payload": {"progressId": progress, "seq": 0}})
            self.assertFalse(result.done())
            self.make("continue", b"")
            response = result.result(timeout=6)
            self.assertEqual(response["chunks"], 2)
            self.assertEqual(response["audio_sec"], 1.5)
            self.assertTrue(Path(response["out"]).with_suffix(".json").is_file())

    def test_synthesis_missing_output_and_timeout_release_gate(self):
        self.synth_role()
        with self.fixture_worker("synth", "import time; time.sleep(30)"), patch.object(lan, "SYNTH_TIMEOUT", .25):
            response = self.client.post("/api/invoke", json={"command":"synth_start","args":{"roleId":"role","text":"x"}})
            self.assertEqual(response.status_code, 504, response.text)
            self.assertFalse(lan.synth_lock.locked())
        with self.fixture_worker("synth", "print('{\"event\":\"bye\"}')"):
            response = self.client.post("/api/invoke", json={"command":"synth_start","args":{"roleId":"role","text":"x"}})
            self.assertEqual(response.status_code, 500, response.text)

    def test_upload_edit_save_reload_with_backup_and_stale_guard(self):
        audio = self.make("User_Data/outputs/readback.wav", b"fixture")
        path = self.invoke("annot_upload", name="example.list", text=f"{audio}|speaker|ZH|before\n")
        contents = Path(path).read_bytes()
        self.assertIn(path, [item["path"] for item in self.invoke("annot_catalog")])
        loaded = self.invoke("annot_load", path=path)
        self.assertEqual(loaded["bad"], 0)
        self.assertEqual(loaded["speakers"], ["speaker"])
        loaded["rows"][0]["text"] = "after | UTF-8 校对"
        args = {"path": path, "rows": loaded["rows"], "revision": loaded["revision"]}
        self.assertEqual(self.invoke("annot_save", **args), {"written": 1, "backup": True})
        self.assertEqual(self.invoke("annot_load", path=path)["rows"][0]["text"], "after | UTF-8 校对")
        self.assertEqual(Path(path).with_suffix(".list.bak").read_bytes(), contents)
        stale = self.client.post("/api/invoke", json={"command": "annot_save", "args": args})
        self.assertEqual(stale.status_code, 409)

    def test_lan_imports_keep_weights_only_enabled_in_worker(self):
        self.make("User_Data/characters/role/config.json", b'{"id":"role","name":"Fixture","lan_imported":true}')
        wav = self.make("User_Data/outputs/role/fixture.wav", b"fixture")
        with patch.object(lan, "_synth_worker", return_value=(0, {"out": str(wav)}, 1)) as run:
            self.invoke("synth_start", roleId="role", text="example")
            self.assertEqual(run.call_args.args[2]["TORCH_FORCE_WEIGHTS_ONLY_LOAD"], "1")
            self.assertIn(lan._SAFE_SYNTH_ENTRY, run.call_args.args[0])

    def test_train_dataset_reports_real_wav_metadata_and_missing_rows(self):
        audio = self.make("User_Data/train_inputs/clip.wav", b"")
        with wave.open(str(audio), "wb") as samples:
            samples.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            samples.writeframes(b"\0\0" * 6000)
        path = self.make("User_Data/train_inputs/data.list", b"clip.wav|voice|ZH|ready\nmissing.wav|voice|ZH|missing\n")
        response = self.invoke("train_dataset_stats", path=str(path))
        self.assertEqual({k: v for k, v in response["scan"].items() if k != "issue"}, {"files": 1, "other_files": 1, "total_bytes": audio.stat().st_size})
        self.assertIn("第 2 行", response["scan"]["issue"])
        self.assertAlmostEqual(response["inspect"]["median_seconds"], 0.75)
        self.assertNotIn("mean_volume_db", response["inspect"])
        blocked = self.client.post("/api/invoke", json={"command": "train_queue_add", "args": {"req": {"dataset": str(path), "exp": "fixture"}}})
        self.assertEqual(blocked.status_code, 422)

    def training_list(self, lines="ref.wav| fixture | ZH | Sample voice\n", bom=False):
        self.make("User_Data/train_inputs/ref.wav", b"stub reference")
        return self.make("User_Data/train_inputs/samples.list", lines.encode("utf-8-sig" if bom else "utf-8"))

    def test_training_preflight_rejects_duplicate_or_ambiguous_worker_input(self):
        self.make("User_Data/train_inputs/nested/REF.wav", b"stub")
        path = self.training_list("ref.wav|v|zh|hi\nnested/REF.wav|v|zh|bye\n")
        scan = self.invoke("train_dataset_stats", path=str(path))["scan"]
        self.assertEqual(scan["other_files"], 1)
        self.assertIn("文件名重复", scan["issue"])
        bad = self.client.post("/api/invoke", json={"command":"train_queue_add","args":{"req":{"exp":"fixture","dataset":str(path)}}})
        self.assertEqual(bad.status_code, 422)
        self.assertFalse(lan.train_jobs)
        path = self.training_list("ref.wav|v|zh|bad | pipe\n")
        self.assertIn("分隔符", self.invoke("train_dataset_stats", path=str(path))["scan"]["issue"])

    def test_training_rejects_an_interval_that_never_saves(self):
        path = self.training_list()
        req = {"exp": "no-checkpoint", "dataset": str(path), "gpt_epoch": 2, "gpt_save_every": 5}
        result = self.client.post("/api/invoke", json={"command":"train_queue_add", "args":{"req":req}})
        self.assertEqual(result.status_code, 422)
        self.assertIn("保存间隔", result.json()["detail"])
        self.assertFalse(lan.TRAIN_ROOT.exists())

    def test_synthesis_does_not_silently_substitute_cuda_for_vulkan(self):
        self.synth_role()
        result = self.client.post("/api/invoke", json={"command":"synth_start", "args":{"roleId":"role", "opts":{"backend":"vulkan"}}})
        self.assertEqual(result.status_code, 422)
        self.assertFalse(lan.OUTPUTS.exists())

    def test_training_launch_error_releases_queue_retry_and_clear_preserve_files(self):
        path = self.training_list()
        req = {"exp":"launch", "dataset":str(path)}
        with patch.object(lan.subprocess, "Popen", side_effect=FileNotFoundError("fixture runtime missing")):
            first = self.invoke("train_queue_add", req=req)["id"]
            self.assertIn("fixture runtime missing", self.wait_state(first, "failed")["error"])
            self.assertFalse(self.invoke("train_status")["busy"])
            retry = self.invoke("train_queue_action", id=first, action="retry")["id"]
            self.assertNotEqual(first, retry)
            self.wait_state(retry, "failed")
        self.assertEqual(self.invoke("train_queue_action", id=first, action="remove"), {"removed":1})
        self.assertEqual(self.invoke("train_queue_action", action="clear"), {"removed":1})
        self.assertEqual(self.invoke("train_queue_list"), {"jobs":[]})
        self.assertTrue((lan.TRAIN_ROOT / "launch/lan-request.json").is_file())
        self.assertTrue((lan.TRAIN_ROOT / f"launch-retry-{retry}/lan-request.json").is_file())
        self.assertTrue(path.is_file())

    def test_training_cancels_queued_or_running_jobs(self):
        path = self.training_list()
        actual = lan._run_train
        ready = threading.Event()
        resume = threading.Event()
        def hold(*args):
            ready.set(); resume.wait(timeout=5); actual(*args)
        with patch.object(lan, "_run_train", side_effect=hold):
            queued = self.invoke("train_queue_add", req={"exp":"queued", "dataset":str(path)})["id"]
            try:
                self.assertTrue(ready.wait(3))
                self.assertTrue(self.invoke("train_status")["busy"])
                self.assertEqual(self.invoke("train_queue_action", id=queued, action="cancel")["state"], "cancelling")
            finally:
                resume.set()
            self.wait_state(queued, "cancelled")
            self.assertFalse((lan.TRAIN_ROOT / "queued").exists())
        # Child would leave a marker after a delay if only its parent was killed.
        code = """import subprocess,sys,time
from pathlib import Path
subprocess.Popen([sys.executable,'-c','import time; from pathlib import Path; time.sleep(2); Path("orphan").touch()'])
Path('started').touch()
time.sleep(20)
"""
        with self.fixture_worker("train", code):
            running = self.invoke("train_queue_add", req={"exp":"running", "dataset":str(path)})["id"]
            try:
                end = time.monotonic() + 5
                while not (self.root / "started").is_file() and time.monotonic() < end:
                    time.sleep(.02)
                self.assertTrue((self.root / "started").is_file())
                self.invoke("train_queue_action", id=running, action="cancel")
                self.wait_state(running, "cancelled")
            finally:
                proc = lan.train_processes.get(running)
                if proc and proc.poll() is None: lan._stop_train_process(proc)
            time.sleep(2.1)
            self.assertFalse((self.root / "orphan").exists())
        self.assertFalse(self.invoke("train_status")["busy"])

    def test_training_bom_and_unicode_display_name_publishes_usable_role(self):
        path = self.training_list(bom=True)
        raw = path.read_bytes()
        code = """import json,sys,shutil
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
line=Path(r['dataset']).read_text(encoding='utf-8').strip()
audio,speaker,lang,text=line.split('|'); assert Path(audio).is_file() and lang=='zh' and speaker=='fixture'
d=Path(r['role_dir']); (d/'models').mkdir(parents=True); (d/'dataset').mkdir()
for filename in ('sovits.pth','gpt.ckpt'): (d/'models'/filename).write_text('test fixture')
shutil.copy2(audio, d/'dataset/ref.wav'); (d/'dataset/refs.list').write_text('ref.wav|fixture|zh|voice',encoding='utf-8')
(d/'config.json').write_text(json.dumps({'id':d.name,'name':r['exp'],'lists':[{'file':'dataset/refs.list'}]}),encoding='utf-8')
print(json.dumps({'phase':'done','weights':{'role_id':d.name}}),flush=True)
"""
        self.assertEqual(self.invoke("train_dataset_stats", path=str(path))["scan"]["other_files"], 0)
        with self.fixture_worker("train", code):
            job = self.invoke("train_queue_add", req={"exp":"爱弥斯试验", "dataset":str(path)})["id"]
            state = self.wait_state(job, "completed")
        role = self.invoke("synth_characters")["roles"][0]
        self.assertEqual(role["name"], "爱弥斯试验")
        self.assertEqual(role["id"], state["role_id"])
        self.assertEqual(lan._role_id(role["id"]), role["id"])
        self.assertEqual(lan._pack_role_dir(role["id"]).name, role["id"])
        exported = self.client.get(f"/api/role-package/{role['id']}")
        self.assertEqual(exported.status_code, 200, exported.text[:100] if exported.status_code != 200 else "")
        self.assertEqual(path.read_bytes(), raw)
        self.assertFalse((lan.TRAIN_ROOT / "爱弥斯试验" / "role-stage" / role["id"]).exists())

    def pack(self):
        scratch = io.BytesIO()
        with zipfile.ZipFile(scratch, "w") as archive:
            for path, data in {"config.json": json.dumps({"id":"test-role", "name":"Test Role", "lists":[{"file":"dataset/voice.list"}]}),
                               "models/sovits.pth": b"sovits-fixture", "models/gpt.ckpt": b"gpt-fixture",
                               "dataset/voice.list": "audios/a.wav|test|zh|Reference\n", "dataset/audios/a.wav":b"ri-fixture"}.items():
                archive.writestr("wrapper/" + path, data)
        return scratch.getvalue()

    def test_character_package_roundtrip_and_no_overwrite(self):
        with patch.object(lan, "_inspect_pack_weights", return_value="v5turbo") as validate:
            req = dict(content=self.pack(), headers={"content-type": "application/zip"})
            first = self.client.post("/api/role-package?name=fixture.zip", **req)
            self.assertEqual(first.status_code, 200, first.text)
            validate.assert_called_once()
            self.assertEqual(first.json()["result"]["id"], "test-role")
            self.assertEqual(self.client.post("/api/role-package?name=fixture.zip", **req).status_code, 409)
        role = self.invoke("synth_characters")["roles"][0]
        self.assertTrue(role["lists"][0]["rows"][0]["exists"])
        response = self.client.get("/api/role-package/test-role")
        self.assertEqual(response.status_code, 200, response.text[:150] if response.status_code != 200 else None)
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read("models/gpt.ckpt"), b"gpt-fixture")
            self.assertIn(b"audios/00001.wav|test|zh|Reference", archive.read("dataset/references-01.list"))
            self.assertNotIn(str(self.root).encode(), archive.read("config.json"))

    def test_cache_confirm_and_scope(self):
        cover = self.make("User_Data/cover_cache/a.jpg", b"cover")
        catalog = self.make("User_Data/lan_community_cache/page.json", b"catalog")
        protected = self.make("User_Data/characters/role/models/sovits.pth", b"fixture")
        annotation = self.make("User_Data/train_inputs/doc.list", b"fixture")
        log = self.make("User_Data/logs/latest.log", b"fixture")
        self.assertEqual(self.invoke("cache_status")["files"], 2)
        self.assertEqual(self.client.post("/api/invoke",json={"command":"cache_clear"}).status_code, 400)
        self.assertTrue(cover.is_file())
        cleared = self.invoke("cache_clear", confirm=True)
        self.assertEqual(cleared["removed_files"], 2)
        self.assertEqual(cleared["freed_bytes"], 12)
        self.assertFalse(cover.exists())
        self.assertFalse(catalog.exists())
        self.assertTrue(protected.exists() and annotation.exists() and log.exists())
        self.assertEqual(self.invoke("cache_status")["files"], 0)

    def test_diagnostics_zip_has_only_shareable_reports(self):
        response = self.client.get("/api/diagnostics.zip")
        self.assertEqual(response.headers["content-type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(set(archive.namelist()), {"environment.txt", "checks.json"})
            self.assertNotIn(str(self.root).encode(), archive.read("environment.txt"))
            self.assertTrue(json.loads(archive.read("checks.json"))["findings"])

    def test_catalog_fallback_and_download_metadata(self):
        sha = "a" * 64
        item = {"id":"asset","title":"Example","compatibleVersion":{"id":"version","package":{"id":"file","sha256":sha,"sizeBytes":120}}}
        with patch.object(lan, "_get_public_json", return_value={"items":[item],"nextCursor":"next"}):
            first = self.invoke("lan_community_catalog")
        self.assertEqual(first["source"], "remote")
        self.assertEqual(first["items"][0]["title"], "Example")
        with patch.object(lan, "_get_public_json", side_effect=OSError("unavailable")):
            self.assertEqual(self.invoke("lan_community_catalog")["source"], "cache")
        with patch.object(lan, "_get_public_json", return_value={"origin":{"assetId":"asset","versionId":"version"},"sizeBytes":120,"sha256":sha,"url":"https://example.test/model.zip"}):
            self.assertEqual(self.invoke("lan_community_download",fileId="file",id="asset",versionId="version",sha256=sha,bytes=120), "https://example.test/model.zip")
            resp = self.client.post("/api/invoke",json={"command":"lan_community_download","args":{"fileId":"file"}})
            self.assertEqual(resp.status_code, 409)

    def test_worker_thread_can_push_to_connected_browser(self):
        with self.client.websocket_connect("ws://127.0.0.1:8790/api/events") as socket:
            worker = threading.Thread(target=lan.hub.broadcast_threadsafe, args=("lan-test", {"seq": 1}))
            worker.start()
            worker.join(timeout=3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(socket.receive_json(), {"event": "lan-test", "payload": {"seq": 1}})


if __name__ == "__main__":
    unittest.main()
