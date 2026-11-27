"""The installed app: the pipeline finds the tools and model that ship inside Spikecut."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from clipwatcher import recorder
from clipwatcher.config import load_config


class BundledResourcesTest(unittest.TestCase):
    def test_resolve_falls_back_to_bundled_resources(self):
        with tempfile.TemporaryDirectory() as work, tempfile.TemporaryDirectory() as res:
            cfg_path = Path(work) / "config.toml"
            cfg_path.write_text('channel = "abc"\n', encoding="utf-8")
            bundled = Path(res) / "models" / "ggml-base.en.bin"
            bundled.parent.mkdir()
            bundled.write_bytes(b"x")
            with mock.patch.dict(os.environ, {"CLIPPER_RESOURCES": res}):
                cfg = load_config(cfg_path)
                # only in the bundle: the bundled file
                self.assertEqual(cfg.resolve("models/ggml-base.en.bin"), bundled)
                # present in the work folder too: the work folder wins
                own = Path(work) / "models" / "ggml-base.en.bin"
                own.parent.mkdir()
                own.write_bytes(b"y")
                self.assertEqual(cfg.resolve("models/ggml-base.en.bin"), Path(work).resolve() / "models" / "ggml-base.en.bin")
                # missing everywhere: the work-folder path, as before
                self.assertEqual(cfg.resolve("models/none.bin"), Path(work).resolve() / "models" / "none.bin")
                # absolute paths are untouched
                self.assertEqual(cfg.resolve(str(bundled)), bundled)

    def test_resolve_without_resources_is_unchanged(self):
        with tempfile.TemporaryDirectory() as work:
            cfg_path = Path(work) / "config.toml"
            cfg_path.write_text('channel = "abc"\n', encoding="utf-8")
            env = {k: v for k, v in os.environ.items() if k != "CLIPPER_RESOURCES"}
            with mock.patch.dict(os.environ, env, clear=True):
                cfg = load_config(cfg_path)
                self.assertEqual(cfg.resolve("models/x.bin"), Path(work).resolve() / "models" / "x.bin")


class StreamlinkCommandTest(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config(None, {"channel": "abc"})

    def test_uses_the_binary_on_path(self):
        with mock.patch.object(recorder, "which", return_value=r"C:\bin\streamlink.exe"):
            self.assertEqual(recorder.streamlink_command(self.cfg), [r"C:\bin\streamlink.exe"])

    def test_uses_module_when_not_on_path(self):
        with mock.patch.object(recorder, "which", return_value=None), \
                mock.patch.object(recorder.importlib.util, "find_spec", return_value=object()):
            self.assertEqual(recorder.streamlink_command(self.cfg), [sys.executable, "-m", "streamlink"])
            cmd = recorder.build_command(self.cfg, Path("out.ts"))
            self.assertEqual(cmd[:4], [sys.executable, "-m", "streamlink", "twitch.tv/abc"])

    def test_setup_check_counts_the_bundled_module(self):
        from clipwatcher import cli
        from clipwatcher.cli import tool_status
        with mock.patch.object(recorder, "which", return_value=None), \
                mock.patch.object(cli, "which", return_value=None), \
                mock.patch.object(recorder.importlib.util, "find_spec", return_value=object()):
            row = next(t for t in tool_status(self.cfg) if t["name"] == "streamlink")
        self.assertTrue(row["ok"])
        self.assertEqual(row["path"], f"{sys.executable} -m streamlink")

    def test_none_when_missing_everywhere(self):
        with mock.patch.object(recorder, "which", return_value=None), \
                mock.patch.object(recorder.importlib.util, "find_spec", return_value=None):
            self.assertIsNone(recorder.streamlink_command(self.cfg))


if __name__ == "__main__":
    unittest.main()
