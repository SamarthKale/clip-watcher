import json
import tempfile
import time
import unittest
from pathlib import Path

from clipwatcher.chat import ALLOWED_COMMANDS, ChatReader, chat_record, parse_irc, read_window
from clipwatcher.config import load_config, normalize_channel
from clipwatcher.db import DB
from clipwatcher.extractor import plan_window
from clipwatcher.media import cut_copy_cmd
from clipwatcher.recorder import build_command
from clipwatcher.transcriber import shift_srt, words_from_whisper_json


class ConfigTests(unittest.TestCase):
    def test_normalize_channel(self):
        for v in ("SomeOne", "#someone", "twitch.tv/someone", "https://www.twitch.tv/someone/videos"):
            self.assertEqual(normalize_channel(v), "someone")
        with self.assertRaises(ValueError):
            normalize_channel("bad name!")

    def test_channel_required_and_not_hardcoded(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.toml"
            cfg_path.write_text("", encoding="utf-8")
            with self.assertRaises(SystemExit):
                load_config(cfg_path, require_channel=True)
            cfg = load_config(cfg_path, {"channel": "Twitch.tv/Abc_123"})
            self.assertEqual(cfg.channel, "abc_123")

    def test_streamlink_command(self):
        cfg = load_config(None, {"channel": "abc", "record": {"quality": "720p60"}})
        cmd = build_command(cfg, Path("rec.ts"))
        self.assertEqual(cmd[1:3], ["twitch.tv/abc", "720p60"])
        self.assertIn("--retry-streams", cmd)
        self.assertEqual(cmd[cmd.index("--retry-streams") + 1], "30")


class ChatTests(unittest.TestCase):
    def test_parse_privmsg_with_tags(self):
        line = ("@display-name=Some\\sOne;id=abc;tmi-sent-ts=1700000000123 "
                ":someone!someone@someone.tmi.twitch.tv PRIVMSG #chan :hello : world")
        msg = parse_irc(line)
        self.assertEqual(msg.command, "PRIVMSG")
        self.assertEqual(msg.params, ["#chan", "hello : world"])
        self.assertEqual(msg.tags["display-name"], "Some One")
        rec = chat_record(msg, 1700000000.5)
        self.assertEqual(rec["user"], "someone")
        self.assertEqual(rec["tmi_ts"], 1700000000.123)
        self.assertEqual(rec["text"], "hello : world")

    def test_read_only_guard(self):
        self.assertNotIn("PRIVMSG", ALLOWED_COMMANDS)
        cfg = load_config(None, {"channel": "abc"})
        reader = ChatReader(cfg, Path("unused.log"))

        class Sock:
            sent = []
            def sendall(self, b):
                self.sent.append(b)
        reader.sock = Sock()
        reader._send("PONG :tmi.twitch.tv")
        with self.assertRaises(PermissionError):
            reader._send("PRIVMSG #abc :hi")
        self.assertEqual(len(Sock.sent), 1)

    def test_read_window_binary_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "chat.log"
            with open(p, "w", encoding="utf-8") as fh:
                for i in range(20000):
                    fh.write(json.dumps({"type": "msg" if i % 2 else "heartbeat", "t": 1000 + i * 0.5,
                                         "text": f"m{i}"}) + "\n")
            msgs = read_window(p, 5000, 5010)
            self.assertTrue(msgs)
            self.assertTrue(all(5000 <= m["t"] < 5010 and m["type"] == "msg" for m in msgs))
            self.assertEqual(len(msgs), 10)


class ExtractTests(unittest.TestCase):
    def test_plan_window(self):
        moment, start, end = plan_window(spike_ts=1100, chat_offset=0, start_wall=1000,
                                         pre=60, post=60, end_wall=None)
        self.assertEqual((moment, start, end), (100, 40, 160))
        # clamped at both ends of the recording
        self.assertEqual(plan_window(1030, 0, 1000, 60, 60, 1050), (30, 0, 50))
        # sync offset shifts the moment
        self.assertEqual(plan_window(1100, -3, 1000, 60, 60, None)[0], 97)

    def test_cut_is_stream_copy(self):
        cmd = cut_copy_cmd("ffmpeg", Path("in.ts"), 40, 120, Path("out.mp4"))
        self.assertLess(cmd.index("-ss"), cmd.index("-i"))
        self.assertEqual(cmd[cmd.index("-c") + 1], "copy")
        self.assertEqual(cmd[cmd.index("-t") + 1], "120.000")


class TranscriptTests(unittest.TestCase):
    def test_shift_srt(self):
        srt = "1\n00:00:01,000 --> 00:00:02,500\nhello\n"
        self.assertIn("00:01:41,000 --> 00:01:42,500", shift_srt(srt, 100))

    def test_words_from_tokens(self):
        data = {"transcription": [{"tokens": [
            {"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}},
            {"text": " Oh", "offsets": {"from": 0, "to": 200}, "p": 0.9},
            {"text": " my", "offsets": {"from": 200, "to": 400}, "p": 0.8},
            {"text": " good", "offsets": {"from": 400, "to": 600}, "p": 0.9},
            {"text": "ness", "offsets": {"from": 600, "to": 800}, "p": 0.7},
            {"text": "!", "offsets": {"from": 800, "to": 850}, "p": 0.95},
        ]}]}
        words = words_from_whisper_json(data)
        self.assertEqual([w["w"] for w in words], ["Oh", "my", "goodness!"])
        self.assertEqual((words[2]["start"], words[2]["end"], words[2]["p"]), (0.4, 0.85, 0.7))


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = DB(Path(self.tmp.name) / "q.db")

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_event_dedup_and_stage_flow(self):
        self.assertTrue(self.db.add_event("c-1", "c", 1.0, 1.0, {}))
        self.assertFalse(self.db.add_event("c-1", "c", 1.0, 1.0, {}))
        job = self.db.claim("extract", 60)
        self.assertEqual(job["event_id"], "c-1")
        self.assertIsNone(self.db.claim("extract", 60))  # leased
        self.db.complete(job["id"], {"ok": 1}, next_stage="transcribe")
        self.assertEqual(self.db.claim("transcribe", 60)["event_id"], "c-1")

    def test_claim_rank_takes_highest_score_first(self):
        scores = {"c-low": 22.0, "c-high": 80.0, "c-mid": 33.0}
        for i, ev in enumerate(scores):
            self.db.add_event(ev, "c", float(i), float(i), {})
        order = [self.db.claim("extract", 60, rank=scores.get)["event_id"] for _ in scores]
        self.assertEqual(order, ["c-high", "c-mid", "c-low"])

    def test_claim_without_rank_stays_oldest_first(self):
        for i, ev in enumerate(("c-a", "c-b")):
            self.db.add_event(ev, "c", float(i), float(i), {})
        self.assertEqual(self.db.claim("extract", 60)["event_id"], "c-a")

    def test_crashed_worker_lease_expires(self):
        self.db.add_event("c-2", "c", 1.0, 1.0, {})
        self.db.claim("extract", -1)  # lease already expired = worker died
        again = self.db.claim("extract", 60)
        self.assertEqual(again["attempts"], 2)

    def test_defer_does_not_burn_attempts_and_fail_retries(self):
        self.db.add_event("c-3", "c", 1.0, 1.0, {})
        job = self.db.claim("extract", 60)
        self.db.defer(job["id"], time.time() - 1, "waiting")
        job = self.db.claim("extract", 60)
        self.assertEqual(job["attempts"], 1)
        self.assertEqual(self.db.fail(job["id"], "boom", max_attempts=2), "pending")
        self.db.conn.execute("UPDATE jobs SET not_before=0")
        job = self.db.claim("extract", 60)
        self.assertEqual(self.db.fail(job["id"], "boom", max_attempts=2), "failed")
        self.assertEqual(self.db.retry("c-3", "extract"), 1)

    def test_session_lookup(self):
        self.db.add_session("s1", "c", "a.ts", "best")
        self.db.set_session_start("s1", 1000)
        self.assertEqual(self.db.session_at("c", 1500)["id"], "s1")  # still recording
        self.db.end_session("s1", 2000)
        self.assertIsNone(self.db.session_at("c", 2500))
        self.assertIsNone(self.db.session_at("c", 900))


if __name__ == "__main__":
    unittest.main()
