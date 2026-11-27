import json
import threading
import tempfile
import time
import unittest
from pathlib import Path

from clipwatcher import ui
import urllib.request
from http.server import ThreadingHTTPServer
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


class ApiTests(unittest.TestCase):
    """The pipeline API the desktop app talks to, over real HTTP on a throwaway port."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dash = make_dash(tmp.name)
        ui.Handler.dash = self.dash
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), ui.Handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def call(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method="POST" if body is not None else "GET",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_health_and_paths(self):
        self.assertEqual(self.call("/api/health")[1]["ok"], True)
        paths = self.call("/api/paths")[1]
        self.assertTrue(paths["library"].endswith("Shorts") and "data" in paths)

    def test_vod_links_are_queued_once_and_bad_ones_explained(self):
        st, r = self.call("/api/vod/add", {"url": "https://youtu.be/dQw4w9WgXcQ  https://example.com/x"})
        self.assertEqual((st, r["ok"]), (200, True))
        self.assertEqual([("error" in x) for x in r["results"]], [False, True])
        _, again = self.call("/api/vod/add", {"url": "https://youtu.be/dQw4w9WgXcQ"})
        self.assertFalse(again["results"][0]["queued"])
        listing = self.call("/api/vod")[1]
        self.assertEqual(len(listing["jobs"]), 1)
        self.assertFalse(self.call("/api/vod/add", {"url": "   "})[1]["ok"])
        self.assertFalse(self.call("/api/vod/add", {"url": "https://example.com/x"})[1]["ok"])

    def test_watch_list_add_remove_and_bad_input(self):
        self.assertTrue(self.call("/api/watch/add", {"platform": "twitch", "channel": "abc", "keyword": "ranked"})[1]["ok"])
        self.assertEqual(self.call("/api/watch")[1]["watch"][0]["keyword"], "ranked")
        self.assertFalse(self.call("/api/watch/add", {"platform": "tiktok", "channel": "abc"})[1]["ok"])
        self.assertTrue(self.call("/api/watch/remove", {"platform": "twitch", "channel": "abc"})[1]["ok"])
        self.assertFalse(self.call("/api/watch/remove", {"platform": "twitch", "channel": "abc"})[1]["ok"])

    def test_storage_plan_and_run_refuse_unsafe_deletes(self):
        from pathlib import Path as P
        ed = P(self.dash.cfg.raw["storage"]["edited_dir"]) / "abc" / "2026-11-18" / "abc-1795000000"
        ed.mkdir(parents=True)
        (ed / "short.mp4").write_bytes(b"x" * 10)
        t = time.time() - 40 * 86400
        import os
        os.utime(ed / "short.mp4", (t, t))
        os.utime(ed, (t, t))
        plan = self.call("/api/storage/plan", {"older_than_days": 30, "kinds": ["short"]})[1]
        self.assertEqual((len(plan["delete"]), len(plan["blocked"])), (0, 1))  # not uploaded yet
        item = plan["blocked"][0]
        run = self.call("/api/storage/run", {"ids": [item["id"]]})[1]
        self.assertEqual((run["deleted"], len(run["refused"])), ([], 1))
        self.assertTrue(ed.exists())
        self.assertEqual(self.call("/api/storage/plan", {"older_than_days": "abc"})[1]["ok"], False)

    def test_foreign_host_header_is_refused(self):
        req = urllib.request.Request(self.base + "/api/health", headers={"Host": "evil.example"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(cm.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
