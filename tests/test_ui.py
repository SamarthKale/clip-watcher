import json
import tempfile
import time
import unittest
from pathlib import Path

from clipwatcher import ui
from clipwatcher.config import load_config


def make_dash(tmp: str) -> ui.Dashboard:
    cfg_path = Path(tmp) / "config.toml"
    cfg_path.write_text(
        f'[paths]\ndata = "{Path(tmp, "data").as_posix()}"\n'
        f'[storage]\nedited_dir = "{Path(tmp, "Edited").as_posix()}"\n', encoding="utf-8")
    cfg = load_config(cfg_path, {"channel": "abc"})
    return ui.Dashboard(cfg, str(cfg_path))


class HelperTests(unittest.TestCase):
    def test_event_state_labels(self):
        job = lambda status, attempts=0: {"status": status, "attempts": attempts}  # noqa: E731
        self.assertEqual(ui._event_state({"edit": job("done")}), ("Short ready", "ok"))
        self.assertEqual(ui._event_state({"edit": job("running")}), ("Editing", "live"))
        self.assertEqual(ui._event_state({"edit": job("pending", 0)}), ("Queued to edit", "wait"))
        self.assertEqual(ui._event_state({"edit": job("pending", 2)}), ("Retrying edit", "wait"))
        self.assertEqual(ui._event_state({"edit": job("failed", 4)}), ("Edit failed", "bad"))
        self.assertEqual(ui._event_state({"transcribe": job("running")}), ("Transcribing", "live"))
        self.assertEqual(ui._event_state({"extract": job("pending")}), ("Cutting clip", "wait"))

    def test_tail_lines_incremental_and_partial_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "a.log"
            f.write_bytes(b"one\ntwo\nthr")  # last line not finished yet
            lines, off = ui._tail_lines(f, None)
            self.assertEqual(lines, ["one", "two"])
            with open(f, "ab") as fh:
                fh.write(b"ee\nfour\n")
            lines, off2 = ui._tail_lines(f, off)
            self.assertEqual(lines, ["three", "four"])
            self.assertEqual(ui._tail_lines(f, off2)[0], [])
            f.write_bytes(b"x\n")  # file replaced: restart from the beginning
            self.assertEqual(ui._tail_lines(f, off2)[0], ["x"])

    def test_log_line_regex(self):
        m = ui.LOG_LINE.match("2026-11-17 00:24:50,945 INFO    [detect] SPIKE syndicate-1 at x")
        self.assertEqual((m.group(2), m.group(3)), ("INFO", "detect"))


class DashboardTests(unittest.TestCase):
    def test_logs_merge_stages_in_time_order_and_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp)
            logs = d.cfg.path("logs")
            logs.mkdir(parents=True)
            (logs / "record.log").write_text("2026-11-17 00:00:02,000 INFO    [record] live\n", "utf-8")
            (logs / "chat.log").write_text("2026-11-17 00:00:01,000 INFO    [chat] joined\n"
                                           "2026-11-17 00:00:03,000 WARNING [chat] slow\n  continuation\n", "utf-8")
            first = d.logs(None)
            self.assertEqual([l["stage"] for l in first["lines"]], ["chat", "record", "chat", "chat"])
            self.assertEqual(first["lines"][3]["msg"], "  continuation")
            with open(logs / "record.log", "a", encoding="utf-8") as fh:
                fh.write("2026-11-17 00:00:09,000 ERROR   [record] boom\n")
            second = d.logs(first["offsets"])
            self.assertEqual([l["msg"] for l in second["lines"]], ["boom"])

    def test_media_path_whitelist_and_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp)
            ev = Path(tmp, "Edited", "abc", "2026-11-17", "abc-1")
            (ev / "final").mkdir(parents=True)
            (ev / "short.mp4").write_bytes(b"v")
            (ev / "secret.txt").write_text("no", "utf-8")
            self.assertEqual(d.media_path("abc-1", "short.mp4"), ev / "short.mp4")
            self.assertIsNone(d.media_path("abc-1", "secret.txt"))
            self.assertIsNone(d.media_path("abc-1", "../short.mp4"))
            self.assertIsNone(d.media_path("..", "short.mp4"))
            self.assertIsNone(d.media_path("abc-1/../abc-1", "short.mp4"))

    def test_chat_buckets_and_threshold(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp)
            log = ui.chat_log_path(d.cfg, "abc")
            log.parent.mkdir(parents=True)
            now = time.time()
            recs = [{"type": "connect", "t": now - 400}]
            recs += [{"type": "msg", "t": now - 300 + i * 5, "user": "u", "name": "U", "text": f"m{i}"}
                     for i in range(50)]
            recs += [{"type": "heartbeat", "t": now - 1}]
            log.write_text("\n".join(json.dumps(r) for r in recs) + "\n", "utf-8")
            res = d.chat("abc")
            self.assertTrue(res["connected"])
            self.assertEqual(len(res["buckets"]), 60)
            self.assertEqual(sum(res["buckets"]), 50)
            self.assertGreaterEqual(res["threshold"], 8)  # never below min_spike_messages
            self.assertEqual(res["messages"][-1]["text"], "m49")

    def test_dashboard_has_no_publish_or_upload_routes(self):
        src = Path(ui.__file__).read_text("utf-8")
        for word in ("upload(", "publish(", "youtube.com/upload", "requests."):
            self.assertNotIn(word, src)


if __name__ == "__main__":
    unittest.main()
