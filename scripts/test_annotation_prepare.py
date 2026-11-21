"""Exercise annotation preparation with subprocess fixtures, without downloading models."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


PAYLOAD = Path(__file__).resolve().parents[1] / "app/src-tauri/engine-payload"
spec = importlib.util.spec_from_file_location("train_worker", PAYLOAD / "tools/train_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class AnnotationPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "录音 voice"
        self.source.mkdir()
        self.datasets = self.root / "User_Data/datasets"
        tools = self.root / "tools"
        (tools / "asr").mkdir(parents=True)
        (tools / "slice_audio.py").write_text(
            "import pathlib, shutil, sys\n"
            "source, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])\n"
            "shutil.copyfile(source, output / (source.stem + '_000.wav'))\n",
            encoding="utf-8",
        )
        self.asr = tools / "asr/fasterwhisper_asr.py"
        self.asr.write_text(
            "import json, os, pathlib, sys\n"
            "args = dict(zip(sys.argv[1::2], sys.argv[2::2]))\n"
            "source, output = pathlib.Path(args['-i']), pathlib.Path(args['-o'])\n"
            "(output / 'asr-options.json').write_text(json.dumps({\n"
            "    'precision': args['-p'], 'cuda': os.environ.get('CUDA_VISIBLE_DEVICES')\n"
            "}))\n"
            "rows = [f'{clip.resolve()}|speaker|EN|{clip.read_text()}'\n"
            "    for clip in sorted(source.glob('*.wav')) if clip.read_text() != 'skip']\n"
            "(output / (source.name + '.list')).write_text('\\n'.join(rows), encoding='utf-8')\n",
            encoding="utf-8",
        )
        self.root_patch = patch.object(worker, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def recording(self, name, text):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_creation_keeps_duplicate_names_and_relative_paths_ready_for_training(self):
        first = self.recording("a/voice.wav", "First sentence")
        second = self.recording("b/voice.wav", "Second sentence")
        self.recording("silence.wav", "skip")

        annotation = worker.create_annotation(self.source, self.datasets, "cpu")

        rows = worker.parse_list(annotation)
        self.assertEqual(len(rows), 3)
        self.assertEqual(len({row["wav"].casefold() for row in rows}), 3)
        self.assertTrue(all(not Path(row["wav"]).is_absolute() for row in rows))
        self.assertTrue(all(Path(row["abs"]).is_file() for row in rows))
        self.assertEqual({row["text"] for row in rows}, {"First sentence", "Second sentence", ""})
        self.assertEqual(first.read_text(), "First sentence")
        self.assertEqual(second.read_text(), "Second sentence")
        options = json.loads((annotation.parent / "asr-options.json").read_text())
        self.assertEqual(options, {"precision": "float32", "cuda": ""})
        with patch.object(worker, "transcribe_audio") as transcribe:
            self.assertEqual(worker.stage_prepare({"dataset": str(annotation)}, self.root), annotation)
            transcribe.assert_not_called()

    def test_repeated_creation_keeps_previous_dataset(self):
        self.recording("voice.wav", "Original")
        first = worker.create_annotation(self.source, self.datasets, "cpu")
        self.recording("voice.wav", "Updated")
        second = worker.create_annotation(self.source, self.datasets, "cpu")
        self.assertNotEqual(first.parent, second.parent)
        self.assertEqual(worker.parse_list(first)[0]["text"], "Original")
        self.assertEqual(worker.parse_list(second)[0]["text"], "Updated")

    def test_asr_failure_cleans_incomplete_dataset_and_allows_retry(self):
        source = self.recording("voice.wav", "Original")
        original_script = self.asr.read_text()
        self.asr.write_text("raise RuntimeError('transcription failed')\n")
        with self.assertRaises(worker.Fail):
            worker.create_annotation(self.source, self.datasets, "cpu")
        self.assertEqual(list(self.datasets.iterdir()), [])
        self.assertEqual(source.read_text(), "Original")
        self.asr.write_text(original_script)
        self.assertTrue(worker.create_annotation(self.source, self.datasets, "cpu").is_file())

    def test_empty_audio_or_no_speech_does_not_create_an_unusable_dataset(self):
        with self.assertRaises(worker.Fail):
            worker.create_annotation(self.source, self.datasets, "cpu")
        self.recording("silence.wav", "skip")
        with self.assertRaises(worker.Fail):
            worker.create_annotation(self.source, self.datasets, "cpu")
        self.assertEqual(list(self.datasets.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
