import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from clipwatcher import cleanup, storage
from clipwatcher.config import load_config
from clipwatcher.db import DB

DAY = 86400


class Env(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.cfg = load_config(None, {
            "channel": "abc",
            "paths": {"data_dir": str(self.root / "data")},
            "storage": {"edited_dir": str(self.root / "Edited"), "raw_clips_dir": str(self.root / "RawBackup"),
                        "recordings_archive_dir": str(self.root / "RecArchive"),
                        "delete_recordings_after_backup": True, "settle_minutes": 1},
            "library": {"dir": str(self.root / "Shorts")}})
        self.db = DB(self.root / "t.db")
        self.addCleanup(self.db.close)

    def age(self, path: Path, days: float):
        t = time.time() - days * DAY
        for p in [path, *path.rglob("*")] if path.is_dir() else [path]:
            os.utime(p, (t, t))

    # --- builders
    def short(self, ev="abc-1795000000", status=None, days=40):
        d = storage.edited_root(self.cfg) / storage.library_subpath(ev)
        d.mkdir(parents=True)
        (d / "short.mp4").write_bytes(b"s" * 1000)
        self.age(d, days)
        self.lib_clip(ev, status)
        return d

    def lib_clip(self, ev, status, file="01_a.mp4", folder="abc__live"):
        d = self.root / "Shorts" / "2026-11-18" / folder
        d.mkdir(parents=True, exist_ok=True)
        doc = json.loads((d / "clips.json").read_text("utf-8")) if (d / "clips.json").exists() else {"clips": []}
        c = {"file": file, "event_id": ev}
        if status:
            c["upload"] = {"status": status}
        doc["clips"].append(c)
        (d / "clips.json").write_text(json.dumps(doc), encoding="utf-8")
        (d / file).write_bytes(b"v" * 500)
        self.age(d, 40)
        return d

    def find(self, kind, label_part=""):
        return [i for i in cleanup.scan(self.cfg, self.db) if i.kind == kind and label_part in i.label]


class ShortTests(Env):
    def test_uploaded_short_is_safe_and_deletion_is_logged(self):
        d = self.short(status="published")
        item = [i for i in cleanup.scan(self.cfg, self.db) if i.kind == "short"][0]
        self.assertTrue(item.safe, item.reason)
        r = cleanup.run(self.cfg, self.db, [item.id])
        self.assertEqual((len(r["deleted"]), r["refused"]), (1, []))
        self.assertFalse(d.exists())
        log = self.db.conn.execute("SELECT action FROM storage_log").fetchall()
        self.assertEqual([x["action"] for x in log], ["manual_delete"])

    def test_not_uploaded_is_refused_unless_overridden_by_name(self):
        d = self.short(status=None)
        item = [i for i in cleanup.scan(self.cfg, self.db) if i.kind == "short"][0]
        self.assertFalse(item.safe)
        self.assertTrue(item.overridable)
        r = cleanup.run(self.cfg, self.db, [item.id])
        self.assertTrue(r["refused"] and not r["deleted"])
        self.assertTrue(d.exists())
        r = cleanup.run(self.cfg, self.db, [item.id], override_ids=[item.id])
        self.assertEqual(len(r["deleted"]), 1)
        self.assertFalse(d.exists())

    def test_queued_and_uploading_count_as_not_done(self):
        for st in ("queued", "needs_attention"):
            with self.subTest(st):
                self.short(ev=f"abc-17950{len(st)}", status=st)
        items = [i for i in cleanup.scan(self.cfg, self.db) if i.kind == "short"]
        self.assertTrue(items and all(not i.safe for i in items))

    def test_discarded_counts_as_done(self):
        self.short(status="discarded")
        self.assertTrue([i for i in cleanup.scan(self.cfg, self.db) if i.kind == "short"][0].safe)

    def test_state_is_rechecked_at_delete_time(self):
        d = self.short(status="published")
        item = [i for i in cleanup.scan(self.cfg, self.db) if i.kind == "short"][0]
        p = self.root / "Shorts" / "2026-11-18" / "abc__live" / "clips.json"
        doc = json.loads(p.read_text("utf-8"))
        doc["clips"][0]["upload"] = {"status": "needs_attention"}  # changed after the plan was shown
        p.write_text(json.dumps(doc), encoding="utf-8")
        r = cleanup.run(self.cfg, self.db, [item.id])
        self.assertTrue(r["refused"])
        self.assertTrue(d.exists())

    def test_unknown_or_vanished_ids_are_refused_not_crashed(self):
        r = cleanup.run(self.cfg, self.db, ["nope"])
        self.assertEqual(r["deleted"], [])
        self.assertEqual(r["refused"][0]["reason"], "no longer exists")


class LibraryTests(Env):
    def test_stream_folder_needs_every_short_done(self):
        self.lib_clip("abc-1", "published", "01_a.mp4")
        self.lib_clip("abc-2", None, "02_b.mp4")
        it = self.find("library")[0]
        self.assertFalse(it.safe)
        self.assertIn("1 Short", it.reason)
        d = Path(it.path)
        doc = json.loads((d / "clips.json").read_text("utf-8"))
        doc["clips"][1]["upload"] = {"status": "uploaded"}
        (d / "clips.json").write_text(json.dumps(doc), encoding="utf-8")
        self.assertTrue(self.find("library")[0].safe)

    def test_folder_without_readable_clips_json_is_left_out(self):
        d = self.root / "Shorts" / "2026-11-18" / "x__live"
        d.mkdir(parents=True)
        (d / "clips.json").write_text("{bad", encoding="utf-8")
        self.assertEqual(self.find("library"), [])


class RawClipTests(Env):
    def raw(self, ev, where):
        d = where / ev if where == self.cfg.path("raw_clips") else where / storage.library_subpath(ev)
        d.mkdir(parents=True)
        (d / "clip.mp4").write_bytes(b"c" * 2000)
        self.age(d, 40)
        return d

    def test_local_raw_clip_without_verified_backup_is_never_deletable(self):
        d = self.raw("abc-1", self.cfg.path("raw_clips"))
        it = self.find("raw_clip")[0]
        self.assertFalse(it.safe)
        self.assertFalse(it.overridable)
        r = cleanup.run(self.cfg, self.db, [it.id], override_ids=[it.id])
        self.assertTrue(r["refused"] and d.exists())

    def test_backup_of_a_never_edited_clip_is_the_only_copy(self):
        self.raw("abc-2", storage.raw_archive_root(self.cfg))
        it = self.find("raw_backup")[0]
        self.assertFalse(it.safe)
        self.assertTrue(it.overridable)

    def test_backup_of_an_uploaded_short_can_go(self):
        self.raw("abc-1795000000", storage.raw_archive_root(self.cfg))
        self.short("abc-1795000000", status="published")
        it = self.find("raw_backup")[0]
        self.assertTrue(it.safe, it.reason)


class RecordingTests(Env):
    def session(self, sid="abc_s1", status="ended", ended_days=10):
        rec = self.root / "data" / "recordings" / "abc" / f"{sid}.ts"
        rec.parent.mkdir(parents=True, exist_ok=True)
        rec.write_bytes(b"r" * 5000)
        self.age(rec, ended_days)
        now = time.time()
        self.db.add_session(sid, "abc", str(rec), "best")
        self.db.set_session_start(sid, now - ended_days * DAY - 3600)
        if status == "ended":
            self.db.end_session(sid, now - ended_days * DAY)
        return rec, now - ended_days * DAY - 1800

    def test_a_recording_in_progress_is_blocked(self):
        self.session(status="recording")
        it = self.find("recording")[0]
        self.assertEqual((it.safe, it.reason), (False, "still recording"))

    def test_clipless_recording_is_the_only_copy_but_overridable(self):
        self.session()
        it = self.find("recording")[0]
        self.assertFalse(it.safe)
        self.assertTrue(it.overridable)

    def test_recording_with_unextracted_clip_is_blocked_for_good(self):
        _, spike = self.session()
        self.db.add_event("abc-1", "abc", spike, spike, {})
        it = self.find("recording")[0]
        self.assertFalse(it.safe)
        self.assertFalse(it.overridable)
        self.assertIn("not extracted", it.reason)

    def test_recording_with_all_clips_backed_up_can_go(self):
        rec, spike = self.session()
        self.db.add_event("abc-2", "abc", spike, spike, {})
        for stage in ("extract", "archive"):
            self.db.enqueue("abc-2", stage)
            self.db.conn.execute("UPDATE jobs SET status='done' WHERE event_id='abc-2' AND stage=?", (stage,))
        bk = storage.raw_archive_root(self.cfg) / storage.library_subpath("abc-2")
        bk.mkdir(parents=True)
        (bk / "clip.mp4").write_bytes(b"c")
        (bk / "checksums.sha256").write_text("", encoding="utf-8")
        it = self.find("recording")[0]
        self.assertTrue(it.safe, it.reason)
        r = cleanup.run(self.cfg, self.db, [it.id])
        self.assertEqual(len(r["deleted"]), 1)
        self.assertFalse(rec.exists())
        self.assertEqual(self.db.session("abc_s1")["disposition"], "deleted")


class PlanTests(Env):
    def test_age_filter_and_free_space_count_only_safe_items(self):
        self.short("abc-1795000000", "published", days=40)
        self.short("abc-1795000100", None, days=40)           # not uploaded: blocked
        self.short("abc-1795000200", "published", days=2)     # too young
        p = cleanup.plan(self.cfg, self.db, older_than_days=30, kinds=["short"])
        self.assertEqual([i["event_id"] for i in p["delete"]], ["abc-1795000000"])
        self.assertEqual([i["event_id"] for i in p["blocked"]], ["abc-1795000100"])
        self.assertEqual(p["free_bytes"], 1000)

    def test_unknown_kinds_are_ignored(self):
        p = cleanup.plan(self.cfg, self.db, kinds=["everything", "short"])
        self.assertEqual(p["kinds"], ["short"])

    def test_summary_lists_sizes_per_kind(self):
        self.short("abc-1795000000", "published")
        s = cleanup.summary(self.cfg, self.db)
        self.assertEqual(s["by_kind"]["short"], 1000)
        self.assertGreater(s["total_bytes"], 1000)


if __name__ == "__main__":
    unittest.main()
