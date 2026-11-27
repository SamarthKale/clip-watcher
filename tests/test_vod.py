import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from clipwatcher import vod
from clipwatcher.config import load_config
from clipwatcher.db import DB


def ok(stdout="", stderr="", code=0):
    return SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)


class LinkTests(unittest.TestCase):
    def test_supported_links(self):
        cases = {
            "https://www.twitch.tv/videos/2345678901": ("twitch", "2345678901"),
            "twitch.tv/videos/12345?t=1h2m": ("twitch", "12345"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s": ("youtube", "dQw4w9WgXcQ"),
            "https://youtu.be/dQw4w9WgXcQ": ("youtube", "dQw4w9WgXcQ"),
            "https://www.youtube.com/live/dQw4w9WgXcQ?si=x": ("youtube", "dQw4w9WgXcQ"),
            "https://kick.com/video/6f8f1b0a-1234-4abc-9def-0123456789ab": ("kick", "6f8f1b0a-1234-4abc-9def-0123456789ab"),
            "https://kick.com/somebody/videos/6f8f1b0a-1234-4abc-9def-0123456789ab": ("kick", "6f8f1b0a-1234-4abc-9def-0123456789ab"),
        }
        for url, (plat, vid) in cases.items():
            r = vod.parse_source(url)
            self.assertEqual((r["platform"], r["video_id"]), (plat, vid), url)

    def test_canonical_url_drops_tracking_and_time(self):
        self.assertEqual(vod.parse_source("youtu.be/dQw4w9WgXcQ?t=5")["url"],
                         "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    def test_unsupported_links_explain_why(self):
        for url in ("https://www.twitch.tv/somechannel", "https://www.youtube.com/@name",
                    "https://www.youtube.com/watch", "not a link at all", "", "https://kick.com/somebody"):
            with self.assertRaises(vod.VodError, msg=url):
                vod.parse_source(url)

    def test_channel_slug_is_safe_for_event_ids(self):
        self.assertEqual(vod.channel_slug("@Some-Name.TV"), "some_name_tv")
        self.assertNotIn("-", vod.channel_slug("a-b-c"))
        self.assertEqual(vod.channel_slug("नमस्ते"), "unknown")
        self.assertEqual(vod.channel_slug(""), "unknown")


def replay_lines(burst_at=600.0, base_rate=0.2, burst_msgs=60, duration=1200):
    """A YouTube-style chat replay: steady chat plus one burst."""
    lines, n = [], 0
    t = 0.0
    while t < duration:
        lines.append(t)
        t += 1 / base_rate
    lines += [burst_at + i * 0.2 for i in range(burst_msgs)]
    out = []
    for off in sorted(lines):
        n += 1
        out.append(json.dumps({"replayChatItemAction": {
            "videoOffsetTimeMsec": str(int(off * 1000)),
            "actions": [{"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
                "id": f"m{n}", "authorName": {"simpleText": f"User{n % 40}"},
                "message": {"runs": [{"text": f"message {n} \U0001f62d"}]}}}}}]}}, ensure_ascii=False))
    return "\n".join(out) + "\n"


class ChatReplayTests(unittest.TestCase):
    def test_replay_becomes_a_chat_log_the_detector_finds_the_burst_in(self):
        from clipwatcher.detector import detect_file
        with tempfile.TemporaryDirectory() as tmp:
            rp, out = Path(tmp, "x.live_chat.json"), Path(tmp, "chat.log")
            rp.write_text(replay_lines(), encoding="utf-8")
            n = vod.youtube_chat_to_log(rp, out, start_wall=1_700_000_000.0, duration=1200)
            self.assertGreater(n, 200)
            recs = [json.loads(line) for line in out.read_text("utf-8").splitlines()]
            self.assertEqual(recs[0]["type"], "connect")
            self.assertEqual([r["t"] for r in recs], sorted(r["t"] for r in recs))  # binary search needs order
            self.assertGreater(sum(r["type"] == "heartbeat" for r in recs), 200)
            cfg = load_config(None, {"channel": "abc"})
            events = detect_file(out, "abc", cfg["detect"])
            self.assertEqual(len(events), 1)
            self.assertAlmostEqual(events[0].spike_ts, 1_700_000_000.0 + 600, delta=25)

    def test_garbage_lines_and_out_of_range_offsets_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            rp, out = Path(tmp, "r.json"), Path(tmp, "c.log")
            rp.write_text("not json\n{}\n" + json.dumps({"replayChatItemAction": {"videoOffsetTimeMsec": "99999999",
                          "actions": [{"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
                              "message": {"runs": [{"text": "late"}]}}}}}]}}) + "\n", encoding="utf-8")
            self.assertEqual(vod.youtube_chat_to_log(rp, out, 1000.0, 60), 0)


class Env(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.cfg = load_config(None, {"channel": "abc", "paths": {"data_dir": str(self.tmp / "data")},
                                      "vod": {"ytdlp": "fake-ytdlp", "min_chat_messages": 10}})
        self.db = DB(self.tmp / "t.db")
        self.addCleanup(self.db.close)
        self._which = vod.which
        vod.which = lambda b: b  # pretend yt-dlp is installed
        self.addCleanup(setattr, vod, "which", self._which)


class JobTests(Env):
    def test_same_link_is_never_queued_twice(self):
        a, new_a = vod.add_job(self.db, "https://youtu.be/dQw4w9WgXcQ")
        b, new_b = vod.add_job(self.db, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9")
        self.assertEqual((a, new_a, new_b), (b, True, False))

    def test_ingest_end_to_end_with_a_fake_ytdlp(self):
        info = {"title": "Late night ranked", "uploader_id": "@Some-Streamer", "duration": 1200.0,
                "timestamp": 1_700_000_000, "channel_url": "https://www.youtube.com/@Some-Streamer"}

        def fake(cmd, timeout):
            if "-J" in cmd:
                return ok(json.dumps(info))
            tpl = cmd[cmd.index("-o") + 1]
            if "--skip-download" in cmd:
                Path(tpl.replace("%(ext)s", "live_chat.json")).write_text(replay_lines(), encoding="utf-8")
            else:
                Path(tpl.replace("%(ext)s", "mp4")).write_bytes(b"not really a video")
            return ok()

        vod.add_job(self.db, "https://youtu.be/dQw4w9WgXcQ")
        self.assertTrue(vod.work_one(self.cfg, self.db, run=fake))
        job = self.db.conn.execute("SELECT * FROM vod_jobs").fetchone()
        self.assertEqual((job["status"], job["error"]), ("done", None))
        sess = self.db.session("some_streamer_youtube_dQw4w9WgXcQ")
        self.assertEqual((sess["kind"], sess["platform"], sess["status"]), ("vod", "youtube", "ended"))
        self.assertEqual(sess["channel_url"], "https://www.youtube.com/@Some-Streamer")
        self.assertAlmostEqual(sess["end_wall"] - sess["start_wall"], 1200, delta=1)
        events = self.db.conn.execute("SELECT * FROM events").fetchall()
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["id"].startswith("some_streamer-"))
        self.assertEqual(self.db.conn.execute("SELECT stage FROM jobs").fetchone()["stage"], "extract")
        self.assertTrue((self.cfg.path("chat") / "some_streamer" / f"{sess['id']}.log").exists())
        # nothing left to do, and adding the finished VOD again is harmless
        self.assertFalse(vod.work_one(self.cfg, self.db, run=fake))
        self.assertTrue(vod.ingest(self.cfg, self.db, "https://youtu.be/dQw4w9WgXcQ", fake)["already"])

    def test_live_stream_is_refused_with_a_clear_message(self):
        live = {"title": "x", "duration": None, "is_live": True}
        vod.add_job(self.db, "https://youtu.be/dQw4w9WgXcQ")
        vod.work_one(self.cfg, self.db, run=lambda c, t: ok(json.dumps(live)))
        job = self.db.conn.execute("SELECT * FROM vod_jobs").fetchone()
        self.assertEqual(job["status"], "failed")
        self.assertIn("still live", job["error"])

    def test_yt_dlp_failure_is_reported_not_raised(self):
        vod.add_job(self.db, "https://www.twitch.tv/videos/12345")
        vod.work_one(self.cfg, self.db, run=lambda c, t: ok("", "ERROR: Video unavailable", 1))
        job = self.db.conn.execute("SELECT * FROM vod_jobs").fetchone()
        self.assertEqual(job["status"], "failed")
        self.assertIn("unavailable", job["error"])


class WatchTests(Env):
    def listing(self, *entries):
        return lambda cmd, timeout: ok(json.dumps({"entries": list(entries)}))

    def test_filter_lookback_and_dedupe(self):
        now = time.time()
        vod.add_watch(self.db, "twitch", "abc", keyword="ranked", lookback_hours=24)
        run = self.listing(
            {"id": "111", "url": "https://www.twitch.tv/videos/111", "title": "Ranked grind", "timestamp": now - 3600},
            {"id": "222", "url": "https://www.twitch.tv/videos/222", "title": "Just chatting", "timestamp": now - 3600},
            {"id": "333", "url": "https://www.twitch.tv/videos/333", "title": "Ranked old", "timestamp": now - 90 * 3600},
            {"id": "444", "url": "https://www.twitch.tv/videos/444", "title": "Ranked live", "live_status": "is_live"},
        )
        r = vod.watch_pass(self.cfg, self.db, run, now)
        self.assertEqual((r["queued"], r["filtered"], r["errors"]), (1, 3, []))
        pending = self.db.conn.execute("SELECT url FROM vod_jobs WHERE status='pending'").fetchall()
        self.assertEqual([p["url"] for p in pending], ["https://www.twitch.tv/videos/111"])
        r2 = vod.watch_pass(self.cfg, self.db, run, now)  # nothing new the second time
        self.assertEqual((r2["queued"], r2["filtered"]), (0, 0))

    def test_empty_keyword_takes_everything_recent(self):
        now = time.time()
        vod.add_watch(self.db, "youtube", "@Chan")
        run = self.listing({"id": "dQw4w9WgXcQ", "title": "Anything", "timestamp": now - 60})
        self.assertEqual(vod.watch_pass(self.cfg, self.db, run, now)["queued"], 1)

    def test_listing_error_is_reported_and_other_channels_still_run(self):
        vod.add_watch(self.db, "twitch", "broken")
        vod.add_watch(self.db, "twitch", "fine")
        calls = []

        def run(cmd, timeout):
            calls.append(cmd[-1])
            if "broken" in cmd[-1]:
                return ok("", "ERROR: no such channel", 1)
            return ok(json.dumps({"entries": [{"id": "9", "url": "https://www.twitch.tv/videos/9", "title": "t",
                                               "timestamp": time.time() - 60}]}))
        r = vod.watch_pass(self.cfg, self.db, run, time.time())
        self.assertEqual(r["queued"], 1)
        self.assertEqual(len(r["errors"]), 1)
        self.assertIn("broken", r["errors"][0])

    def test_listing_without_dates_is_filled_in_by_probing_the_one_video(self):
        now = time.time()
        vod.add_watch(self.db, "twitch", "abc", lookback_hours=24)
        calls = []

        def run(cmd, timeout):
            calls.append("-J" in cmd and "--flat-playlist" not in cmd)
            if "--flat-playlist" in cmd:
                return ok(json.dumps({"entries": [
                    {"id": "v1", "url": "https://www.twitch.tv/videos/1", "title": "fresh"},
                    {"id": "v2", "url": "https://www.twitch.tv/videos/2", "title": "stale"}]}))
            ts = now - 3600 if cmd[-1].endswith("/1") else now - 100 * 3600
            return ok(json.dumps({"duration": 600, "timestamp": ts}))
        r = vod.watch_pass(self.cfg, self.db, run, now)
        self.assertEqual((r["queued"], r["filtered"]), (1, 1))
        self.assertEqual(sum(calls), 2)

    def test_bad_watch_input_is_refused(self):
        with self.assertRaises(vod.VodError):
            vod.add_watch(self.db, "tiktok", "x")
        with self.assertRaises(vod.VodError):
            vod.add_watch(self.db, "twitch", "!!!")


if __name__ == "__main__":
    unittest.main()
