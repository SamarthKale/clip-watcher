"""Integration tests that need a real ffmpeg/ffprobe (skipped otherwise).

Looks for ffmpeg on PATH, then in tools/ffmpeg/ (where the README's setup puts it).
"""
import shutil
import tempfile
import unittest
from pathlib import Path

from clipwatcher import media

ROOT = Path(__file__).resolve().parent.parent


def _find(name):
    local = ROOT / "tools" / "ffmpeg" / f"{name}.exe"
    return shutil.which(name) or (str(local) if local.exists() else None)


FFMPEG, FFPROBE = _find("ffmpeg"), _find("ffprobe")


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg/ffprobe not available")
class KeyframeCutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.src = Path(cls.tmp.name) / "src.ts"
        # 30s 30fps test stream with a keyframe exactly every 2s (like Twitch), plus audio.
        media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                   "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
                   "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                   "-t", "30", "-c:v", "libx264", "-g", "60", "-keyint_min", "60",
                   "-sc_threshold", "0", "-c:a", "aac", "-output_ts_offset", "1000",
                   "-f", "mpegts", str(cls.src)])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_keyframe_lookup_is_relative_to_stream_start(self):
        # Times are measured from the file's start (what ffmpeg -ss uses). AAC priming makes
        # audio start ~21ms before video here, so keyframes sit ~0.02s after each 2s mark.
        self.assertAlmostEqual(media.keyframe_at_or_before(FFPROBE, self.src, 13.3), 12.0, delta=0.05)
        self.assertAlmostEqual(media.keyframe_at_or_before(FFPROBE, self.src, 14.1), 14.0, delta=0.05)
        self.assertEqual(media.keyframe_at_or_before(FFPROBE, self.src, 0.5), 0.0)

    def test_aligned_cut_starts_audio_and_video_together(self):
        start = media.keyframe_at_or_before(FFPROBE, self.src, 13.3)
        out = Path(self.tmp.name) / "clip.mp4"
        media.run(media.cut_copy_cmd(FFMPEG, self.src, start, 8.0, out))
        info = media.probe(FFPROBE, out)
        starts = {s["codec_type"]: float(s.get("start_time") or 0) for s in info["streams"]}
        # Unaligned cuts leave up to a whole GOP (~2s) of picture-less audio. Aligned, only
        # codec delay remains (B-frame reorder + AAC priming; 0.03s on real Twitch footage).
        self.assertLess(abs(starts["video"] - starts["audio"]), 0.25)
        self.assertLess(starts["video"], 0.25)
        self.assertAlmostEqual(float(info["format"]["duration"]), 8.0, delta=0.3)



@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg/ffprobe not available")
class ArchiveIntegrationTests(unittest.TestCase):
    """handle_archive with real media: verification, missing drive, rejected edits."""

    def setUp(self):
        from clipwatcher.config import load_config
        from clipwatcher.db import DB
        from clipwatcher.extractor import local_clip_dir
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.overrides = {"channel": "chan", "paths": {"data_dir": str(root / "data")},
                          "extract": {"ffmpeg": FFMPEG, "ffprobe": FFPROBE},
                          "storage": {"raw_clips_dir": str(root / "ext" / "raw"),
                                      "edited_dir": str(root / "edited")}}
        self.cfg = load_config(None, self.overrides)
        self.db = DB(self.cfg.path("db"))
        self.eid = "chan-1794777430"
        self.local = local_clip_dir(self.cfg, self.eid)
        self.local.mkdir(parents=True)
        media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                   "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000",
                   "-t", "3", "-c:v", "libx264", "-c:a", "aac", str(self.local / "clip.mp4")])
        (self.local / "metadata.json").write_text("{}", encoding="utf-8")
        self.db.add_event(self.eid, "chan", 1794777430.0, 1794777430.0, {})
        self.db.enqueue(self.eid, "edit")

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def _run(self, cfg=None):
        from clipwatcher import storage
        self.db.enqueue(self.eid, "archive")
        self.db.retry(self.eid, "archive")
        job = self.db.claim("archive", 60)
        return storage.handle_archive(cfg or self.cfg, self.db, job)

    def test_missing_drive_defers_and_keeps_local(self):
        from clipwatcher.config import load_config
        from clipwatcher.worker import Defer
        cfg = load_config(None, {**self.overrides, "storage": {**self.overrides["storage"],
                                                                "raw_clips_dir": "Q:/not-plugged-in"}})
        self.db.conn.execute("UPDATE jobs SET status='done' WHERE stage='edit'")
        sdir = __import__("clipwatcher.editor", fromlist=["short_dir"]).short_dir(cfg, self.eid)
        sdir.mkdir(parents=True)
        shutil.copy(self.local / "clip.mp4", sdir / "short.mp4")
        out = self._run(cfg)
        self.assertIsInstance(out, Defer)
        self.assertTrue((self.local / "clip.mp4").exists())

    def test_rejected_edit_notes_go_with_raw_clip(self):
        from clipwatcher import storage
        from clipwatcher.editor import short_dir
        self.db.conn.execute("UPDATE jobs SET status='rejected' WHERE stage='edit'")
        sdir = short_dir(self.cfg, self.eid)
        sdir.mkdir(parents=True)
        (sdir / "edit_decisions.json").write_text('{"rejected": true, "reason": "test"}', encoding="utf-8")
        self._run()
        dest = storage.raw_archive_root(self.cfg) / storage.library_subpath(self.eid)
        self.assertFalse(self.local.exists())
        self.assertFalse(sdir.exists())  # Edited Clips holds finished Shorts only
        self.assertIn("test", (dest / "editor_outcome.json").read_text(encoding="utf-8"))
        self.assertEqual(storage.verify_tree(dest), [])

    def test_corrupt_raw_clip_is_never_archived_or_deleted(self):
        self.db.conn.execute("UPDATE jobs SET status='rejected' WHERE stage='edit'")
        data = (self.local / "clip.mp4").read_bytes()
        (self.local / "clip.mp4").write_bytes(data[: len(data) // 3])  # truncated
        with self.assertRaises(media.MediaError):
            self._run()
        self.assertTrue((self.local / "clip.mp4").exists())


if __name__ == "__main__":
    unittest.main()
