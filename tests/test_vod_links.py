"""Any video link: ordinary uploads, podcasts and other sites yt-dlp supports, not only finished streams."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from clipwatcher import vod
from clipwatcher.config import load_config
from clipwatcher.db import DB


def ok(stdout="", stderr="", code=0):
    return SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)


class AnyLinkTests(unittest.TestCase):
    def test_youtube_shorts_links_are_youtube_videos(self):
        r = vod.parse_source("https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share")
        self.assertEqual((r["platform"], r["video_id"], r["url"]),
                         ("youtube", "dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))

    def test_other_sites_are_accepted_as_web_links(self):
        r = vod.parse_source("https://media.example.org/episodes/42-the-long-talk?ref=feed#t=30")
        self.assertEqual(r["platform"], "web")
        self.assertIsNone(r["video_id"])
        self.assertEqual(r["url"], "https://media.example.org/episodes/42-the-long-talk?ref=feed")
        self.assertEqual(vod.parse_source("clips.twitch.tv/SomeClipSlug")["platform"], "web")

    def test_channel_pages_and_non_links_are_refused(self):
        for url in ("https://www.twitch.tv/somechannel", "https://www.youtube.com/@name", "https://kick.com/somebody",
                    "ftp://example.org/file.mp4", "just words", ""):
            with self.assertRaises(vod.VodError, msg=url):
                vod.parse_source(url)


class Env(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.tmp = Path(d.name)
        self.cfg = load_config(None, {"channel": "someone", "paths": {"data_dir": str(self.tmp / "data")},
                                      "vod": {"ytdlp": "fake-ytdlp", "min_chat_messages": 10},
                                      "scout": {"enabled": False}})
        self.db = DB(self.tmp / "t.db")
        self.addCleanup(self.db.close)
        old = vod.which
        vod.which = lambda b: b
        self.addCleanup(setattr, vod, "which", old)


class JobTests(Env):
    def test_shorts_per_link_is_stored_and_clamped(self):
        jid, _ = vod.add_job(self.db, "https://youtu.be/dQw4w9WgXcQ", max_shorts=8)
        jid2, _ = vod.add_job(self.db, "https://media.example.org/a", max_shorts=500)
        jid3, _ = vod.add_job(self.db, "https://media.example.org/b")
        got = {r["id"]: r["max_shorts"] for r in self.db.conn.execute("SELECT id, max_shorts FROM vod_jobs")}
        self.assertEqual(got, {jid: 8, jid2: 20, jid3: 5})

    def test_playlist_is_refused_with_a_clear_message(self):
        vod.add_job(self.db, "https://media.example.org/list")
        vod.work_one(self.cfg, self.db, run=lambda c, t: ok(json.dumps({"_type": "playlist", "entries": []})))
        job = self.db.conn.execute("SELECT * FROM vod_jobs").fetchone()
        self.assertEqual(job["status"], "failed")
        self.assertIn("one video", job["error"])

    def test_web_link_uses_the_sites_own_id_and_spikes_are_capped(self):
        info = {"id": "ep-42/x", "title": "Episode 42", "uploader": "Some Show", "duration": 3000.0,
                "extractor_key": "Generic", "webpage_url": "https://media.example.org/episodes/42"}

        def fake(cmd, timeout):
            if "-J" in cmd:
                return ok(json.dumps(info))
            Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "mp4")).write_bytes(b"x")
            return ok()

        loud = [{"spike_ts": 1000.0 + 300 * i, "peak_ts": 1001.0 + 300 * i, "strength": float(i),
                 "event_id": f"some_show-{i}", "stats": {"source": "audio"}} for i in range(6)]
        old = vod.loud_candidates
        vod.loud_candidates = lambda cfg, sess: loud
        self.addCleanup(setattr, vod, "loud_candidates", old)
        vod.add_job(self.db, "https://media.example.org/episodes/42", max_shorts=2)
        self.assertTrue(vod.work_one(self.cfg, self.db, run=fake))
        job = self.db.conn.execute("SELECT * FROM vod_jobs").fetchone()
        self.assertEqual((job["status"], job["error"], job["events"]), ("done", None, 2))
        sess = self.db.conn.execute("SELECT * FROM sessions").fetchone()
        self.assertEqual((sess["platform"], sess["id"]), ("web", "some_show_web_ep-42_x"))
        self.assertEqual(sess["channel_url"], "https://media.example.org/episodes/42")
        ids = sorted(r["id"] for r in self.db.conn.execute("SELECT id FROM events"))
        self.assertEqual(ids, ["some_show-4", "some_show-5"])  # the two strongest


if __name__ == "__main__":
    unittest.main()


class ScoutPathTests(Env):
    def setUp(self):
        super().setUp()
        self.cfg.raw["scout"]["enabled"] = True
        self.info = {"id": "abc", "title": "Episode", "uploader": "Some Show", "duration": 3000.0, "timestamp": 1_700_000_000}

    def fake(self, cmd, timeout):
        if "-J" in cmd:
            return ok(json.dumps(self.info))
        Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "mp4")).write_bytes(b"x")
        return ok()

    def patch(self, mod, name, value):
        old = getattr(mod, name)
        setattr(mod, name, value)
        self.addCleanup(setattr, mod, name, old)

    def test_a_video_without_chat_goes_to_the_scout(self):
        from clipwatcher import scout
        seen = {}

        def find(cfg, video, duration, n, **kw):
            seen["n"] = n
            return [{"start": 600.0, "end": 645.0, "score": 80, "title": "reveal", "why": "w", "kind": "story", "hook": ""},
                    {"start": 100.0, "end": 130.0, "score": 70, "title": "joke", "why": "w", "kind": "funny", "hook": ""}]
        self.patch(scout, "find_moments", find)
        self.patch(vod, "loud_candidates", lambda cfg, sess: self.fail("loudness should not run"))
        vod.add_job(self.db, "https://media.example.org/ep", max_shorts=4)
        vod.work_one(self.cfg, self.db, run=self.fake)
        self.assertEqual(seen["n"], 4)
        evs = self.db.conn.execute("SELECT id, stats FROM events ORDER BY spike_ts").fetchall()
        self.assertEqual([e["id"] for e in evs], ["some_show-1700000100", "some_show-1700000600"])
        self.assertEqual(json.loads(evs[1]["stats"])["window"], {"start": 600.0, "end": 645.0})
        self.assertEqual(self.db.kv_get("vod:some_show_web_abc")["detectors"], ["scout"])

    def test_scout_failure_falls_back_to_loudness(self):
        from clipwatcher import scout

        def find(*a, **kw):
            raise scout.ScoutError("no speech to read")
        self.patch(scout, "find_moments", find)
        self.patch(vod, "loud_candidates", lambda cfg, sess: [{"event_id": "some_show-1", "spike_ts": 1.0, "peak_ts": 2.0,
                                                               "strength": 9.0, "stats": {"source": "audio"}}])
        vod.add_job(self.db, "https://media.example.org/ep2")
        vod.work_one(self.cfg, self.db, run=self.fake)
        job = self.db.conn.execute("SELECT * FROM vod_jobs").fetchone()
        self.assertEqual((job["status"], job["events"]), ("done", 1))
