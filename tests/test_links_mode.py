"""Adding a video link starts the work by itself: no Start button, no Twitch channel needed."""
import tempfile
from contextlib import closing
import unittest
from pathlib import Path

from clipwatcher import cli, ui
from clipwatcher.config import load_config


class FakeRunner:
    def __init__(self, running=False, channel=None):
        self.running, self.channel, self.calls = running, channel, []

    def owned_running(self):
        return self.running

    def start_links(self):
        self.calls.append("links")
        self.running, self.channel = True, ""
        return "started"


def make_dash(tmp: str, channel: str = "") -> ui.Dashboard:
    cfg_path = Path(tmp) / "config.toml"
    cfg_path.write_text(f'[paths]\ndata = "{Path(tmp, "data").as_posix()}"\n', encoding="utf-8")
    cfg = load_config(cfg_path, {"channel": channel} if channel else None)
    return ui.Dashboard(cfg, str(cfg_path))


class StagesTests(unittest.TestCase):
    def test_links_only_runs_just_the_stages_a_link_needs(self):
        cfg = load_config(None, {})
        self.assertEqual(cli.stages_for(cfg, links_only=True), ["extract", "transcribe", "edit", "storage", "vodwork"])
        full = cli.stages_for(cfg, links_only=False)
        self.assertIn("record", full)
        self.assertIn("vodwork", full)
        self.assertNotIn("audiodetect", full)  # still opt-in

    def test_links_only_run_needs_no_channel(self):
        args = cli.build_parser().parse_args(["run", "--links-only"])
        self.assertTrue(args.links_only)
        self.assertFalse(cli.needs_channel(args))
        self.assertTrue(cli.needs_channel(cli.build_parser().parse_args(["run"])))


class AutoStartTests(unittest.TestCase):
    def test_adding_a_link_starts_the_links_pipeline_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp)
            d.runner = FakeRunner()
            r = d.add_links("https://youtu.be/dQw4w9WgXcQ https://media.example.org/ep/1", 3)
            self.assertTrue(r["ok"])
            self.assertEqual(d.runner.calls, ["links"])
            self.assertIn("started", r["message"])
            d.add_links("https://media.example.org/ep/2", 3)  # already running: not started again
            self.assertEqual(d.runner.calls, ["links"])
            with closing(d.db()) as db:
                shorts = [row["max_shorts"] for row in db.conn.execute("SELECT max_shorts FROM vod_jobs")]
            self.assertEqual(shorts, [3, 3, 3])

    def test_bad_links_alone_start_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp)
            d.runner = FakeRunner()
            r = d.add_links("https://www.youtube.com/@channel", 5)
            self.assertFalse(r["ok"])
            self.assertEqual(d.runner.calls, [])

    def test_a_running_live_pipeline_takes_new_links_itself(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp, "somestreamer")
            d.runner = FakeRunner(running=True, channel="somestreamer")
            d.add_links("https://youtu.be/dQw4w9WgXcQ", 5)
            self.assertEqual(d.runner.calls, [])

    def test_pending_links_resume_when_the_app_opens(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp)
            d.runner = FakeRunner()
            self.assertFalse(d.resume_links())  # nothing waiting
            from clipwatcher import vod
            with closing(d.db()) as db:
                vod.add_job(db, "https://youtu.be/dQw4w9WgXcQ")
            self.assertTrue(d.resume_links())
            self.assertEqual(d.runner.calls, ["links"])

    def test_status_says_which_mode_is_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp)
            d.runner = FakeRunner(running=True, channel="")
            self.assertEqual(d.pipeline_status("")["mode"], "links")
            d.runner = FakeRunner(running=True, channel="somestreamer")
            self.assertEqual(d.pipeline_status("somestreamer")["mode"], "live")
            d.runner = FakeRunner()
            self.assertIsNone(d.pipeline_status("")["mode"])


class RunnerSwitchTests(unittest.TestCase):
    def test_starting_a_channel_while_links_only_runs_switches_over(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = make_dash(tmp)
            started = []

            class Proc:
                def __init__(self, cmd, **kw):
                    started.append(cmd)
                    self.code = None

                def poll(self):
                    return self.code

                def send_signal(self, sig):
                    self.code = 0

                def wait(self, timeout=None):
                    return self.code

                def kill(self):
                    self.code = -9

            old = ui.subprocess.Popen
            ui.subprocess.Popen = Proc
            self.addCleanup(setattr, ui.subprocess, "Popen", old)
            r = d.runner
            self.assertEqual(r.start_links(), "started")
            self.assertIn("--links-only", started[0])
            self.assertNotIn("--channel", started[0])
            self.assertEqual(r.start("somestreamer"), "started")
            self.assertEqual(len(started), 2)
            self.assertEqual(started[1][started[1].index("--channel") + 1], "somestreamer")
            self.assertEqual(r.start_links(), "already running for somestreamer")


if __name__ == "__main__":
    unittest.main()
