"""Integration tests that need a real ffmpeg/ffprobe (skipped otherwise).

Looks for ffmpeg on PATH, then in tools/ffmpeg/ (where the README's setup puts it).
"""
import json
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


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg/ffprobe not available")
class GamingMediaTests(unittest.TestCase):
    """The gaming pack's ffmpeg paths on synthetic footage."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.src = d / "game.mp4"
        # 12 s 1920x1080: test pattern, then a hard cut to red at 6 s; quiet tone with a loud burst 4-5 s.
        media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                   "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=6",
                   "-f", "lavfi", "-i", "color=red:size=1920x1080:rate=30:duration=6",
                   "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=12",
                   "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];"
                   "[2:a]volume=0.02,volume=enable='between(t,4,5)':volume=30[a]",
                   "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast",
                   "-pix_fmt", "yuv420p", "-c:a", "aac", str(cls.src)])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _dims(self, path):
        v = media.summarize(media.probe(FFPROBE, path))["video"]
        return v["width"], v["height"]

    def test_signals_find_the_burst_and_the_cut(self):
        from clipwatcher import signals
        sig = signals.analyze(FFMPEG, self.src, [], spike_t=8.0, peak_t=8.0)
        peaks = sig["audio"]["peaks"]
        self.assertTrue(peaks)
        self.assertTrue(3.5 <= peaks[0]["t"] <= 5.5, peaks)
        self.assertTrue(3.5 <= sig["moment_guess"]["t"] <= 5.5)
        self.assertTrue(any(abs(t - 6.0) < 0.2 for t in sig["scene_changes"]), sig["scene_changes"])
        self.assertEqual(len(sig["audio"]["loudness_curve"]), 24)

    def test_every_layout_renders_1080x1920(self):
        from clipwatcher import reframe
        cam = reframe.Rect(1460, 40, 420, 236)
        layouts = {
            "stack": reframe.stack(1920, 1080, cam),
            "fullcam": reframe.fullcam(1920, 1080, cam),
            "crop_expr": reframe.crop(1920, 1080, x="if(lt(t,0.2),100,900)"),
            "blurfill_inset": reframe.with_insets(reframe.blurfill(1920, 1080, zoom=1.2),
                                                  [reframe.Inset.parse("1500,80,400,160@40,200,500")], 1920, 1080),
        }
        for name, graph in layouts.items():
            out = Path(self.tmp.name) / f"{name}.mp4"
            media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(self.src),
                       "-filter_complex", "[0:v]trim=0:0.5,setpts=PTS-STARTPTS[vcut];" + graph,
                       "-map", "[vlay]", "-c:v", "libx264", "-preset", "ultrafast", str(out)])
            self.assertEqual(self._dims(out), (1080, 1920), name)

    def test_track_follows_a_moving_object(self):
        from clipwatcher import reframe
        mov = Path(self.tmp.name) / "moving.mp4"
        media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                   "-f", "lavfi", "-i", "color=black:size=640x360:rate=30:duration=6",
                   "-f", "lavfi", "-i", "color=white:size=60x60:rate=30:duration=6",
                   "-filter_complex", "[0][1]overlay=x='20+t*95':y=150", "-c:v", "libx264",
                   "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(mov)])
        res = reframe.track(FFMPEG, str(mov), 0, 6, 640, 360, fps=4)
        centres = [c for _, c in res["keys"]]
        self.assertGreaterEqual(len(centres), 3)
        self.assertEqual(centres, sorted(centres))  # left to right
        self.assertGreater(centres[-1], 0.6)

    def test_thumbnail_and_cover(self):
        from clipwatcher import thumbs
        for size in ((1280, 720), (1080, 1920)):
            out = Path(self.tmp.name) / f"thumb_{size[0]}.jpg"
            thumbs.render(FFMPEG, self.src, 2.0, out, size, text="1 HP *ACE*")
            self.assertEqual(thumbs.check(FFPROBE, out, size), [])
        self.assertTrue(thumbs.check(FFPROBE, Path(self.tmp.name) / "thumb_1280.jpg", (1080, 1920)))

    def test_qa_scan_catches_black_open(self):
        bad = Path(self.tmp.name) / "black_open.mp4"
        media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                   "-f", "lavfi", "-i", "color=black:size=320x568:rate=30:duration=1",
                   "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=2",
                   "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
                   "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
                   "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(bad)])
        qa = media.qa_scan(FFMPEG, bad, 3.0)
        self.assertTrue(qa["black"] and qa["black"][0][0] < 0.05, qa)
        self.assertIn("lufs", qa)


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg/ffprobe not available")
class FinishPipelineTests(unittest.TestCase):
    """finish(): QA + thumbnail + cover + platform files for a synthetic Short."""

    def setUp(self):
        from clipwatcher.config import load_config
        from clipwatcher.editor import short_dir
        from clipwatcher.extractor import local_clip_dir
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cfg = load_config(None, {"channel": "chan", "paths": {"data_dir": str(root / "data")},
                                      "extract": {"ffmpeg": FFMPEG, "ffprobe": FFPROBE},
                                      "storage": {"edited_dir": str(root / "edited")}})
        self.eid = "chan-1794777430"
        raw = local_clip_dir(self.cfg, self.eid)
        raw.mkdir(parents=True)
        media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                   "testsrc2=size=1280x720:rate=30:duration=6", "-c:v", "libx264", "-preset", "ultrafast",
                   "-pix_fmt", "yuv420p", str(raw / "clip.mp4")])
        (raw / "metadata.json").write_text(json.dumps({
            "event_id": self.eid,
            "attribution": {"streamer": "chan", "channel": "chan", "channel_url": "https://www.twitch.tv/chan",
                            "credit_line": "Streamer: chan - https://www.twitch.tv/chan"},
            "recording": {"session_id": "s1"},
            "clip": {"source_start": "0:01:00", "source_end": "0:01:06", "source_start_s": 60,
                     "source_end_s": 66, "source_start_utc": "x", "source_end_utc": "y"},
            "spike": {"spike_in_clip_s": 3.0, "peak_in_clip_s": 3.0, "stats": {}},
        }), encoding="utf-8")
        self.sdir = short_dir(self.cfg, self.eid)
        self.sdir.mkdir(parents=True)
        media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                   "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=5",
                   "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.3:duration=5:sample_rate=48000",
                   "-af", "loudnorm=I=-14:TP=-1.5", "-c:v", "libx264", "-preset", "ultrafast",
                   "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                   "-shortest", str(self.sdir / "short.mp4")])
        (self.sdir / "description.txt").write_text("Title\nStreamer: chan - https://www.twitch.tv/chan\n",
                                                   encoding="utf-8")
        (self.sdir / "edit_decisions.json").write_text(json.dumps({
            "moment_type": "ACE", "highlight_score": {"total": 70}, "audio_assets": [],
            "thumbnail": {"raw_t": 2.0, "text": "TEST *ACE*", "cover_t": 0.5}}), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_finish_makes_final_folder(self):
        from clipwatcher.editor import finish
        self.assertEqual(finish(self.cfg, None, self.eid), [])
        final = self.sdir / "final"
        meta = json.loads((self.sdir / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["final"]["thumbnail"], "final/thumbnail.jpg")
        self.assertEqual(meta["final"]["cover"], "final/cover.jpg")
        self.assertEqual(meta["moment_type"], "ACE")
        plats = meta["final"]["platforms"]
        self.assertEqual(plats["youtube_shorts"], {"status": "ok", "file": "../short.mp4"})
        self.assertEqual(plats["instagram_reels"]["file"], "instagram_reels.mp4")
        reels = media.summarize(media.probe(FFPROBE, final / "instagram_reels.mp4"))
        self.assertLessEqual(reels["audio"]["bit_rate"], 130_000)
        self.assertTrue((final / "UPLOAD.txt").exists())
        # idempotent: a second finish re-uses everything
        mtime = (final / "instagram_reels.mp4").stat().st_mtime
        self.assertEqual(finish(self.cfg, None, self.eid), [])
        self.assertEqual((final / "instagram_reels.mp4").stat().st_mtime, mtime)

    def test_black_open_fails_finish(self):
        from clipwatcher.editor import finish
        media.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                   "-f", "lavfi", "-i", "color=black:size=1080x1920:rate=30:duration=1",
                   "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=4",
                   "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.3:duration=5:sample_rate=48000",
                   "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]loudnorm=I=-14:TP=-1.5[a]",
                   "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast",
                   "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(self.sdir / "short.mp4")])
        problems = finish(self.cfg, None, self.eid)
        self.assertTrue(any("black frame" in p for p in problems), problems)
        self.assertFalse((self.sdir / "final").exists())


if __name__ == "__main__":
    unittest.main()
