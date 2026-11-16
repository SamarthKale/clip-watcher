import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

from clipwatcher import storage
from clipwatcher.config import load_config
from clipwatcher.db import DB
from clipwatcher.worker import Done, process_one


class CopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.src = self.root / "src"
        (self.src / "frames").mkdir(parents=True)
        (self.src / "clip.mp4").write_bytes(os.urandom(300_000))
        (self.src / "frames" / "a.jpg").write_bytes(b"jpeg")
        (self.src / "metadata.json").write_text("{}", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_copy_tree_verified(self):
        dst = self.root / "ext" / "ev1"
        sums = storage.copy_tree_verified(self.src, dst)
        self.assertEqual(set(sums), {"clip.mp4", "frames/a.jpg", "metadata.json"})
        self.assertEqual((dst / "clip.mp4").read_bytes(), (self.src / "clip.mp4").read_bytes())
        self.assertFalse((self.root / "ext" / "ev1.partial").exists())
        self.assertEqual(storage.verify_tree(dst), [])
        # idempotent re-run with identical content
        storage.copy_tree_verified(self.src, dst)

    def test_refuses_to_overwrite_different_backup(self):
        dst = self.root / "ext" / "ev1"
        storage.copy_tree_verified(self.src, dst)
        (self.src / "clip.mp4").write_bytes(b"different")
        with self.assertRaises(IOError):
            storage.copy_tree_verified(self.src, dst)
        self.assertNotEqual((dst / "clip.mp4").read_bytes(), b"different")

    def test_verify_tree_detects_corruption(self):
        dst = self.root / "ext" / "ev1"
        storage.copy_tree_verified(self.src, dst)
        (dst / "frames" / "a.jpg").write_bytes(b"corrupt")
        self.assertTrue(any("mismatch" in p for p in storage.verify_tree(dst)))

    def test_move_file_verified_removes_source_only_after_copy(self):
        src = self.root / "rec.ts"
        src.write_bytes(os.urandom(500_000))
        os.chmod(src, stat.S_IREAD)  # recordings are read-only
        data = src.read_bytes()
        dst = self.root / "ext" / "rec.ts"
        storage.move_file_verified(src, dst)
        self.assertFalse(src.exists())
        self.assertEqual(dst.read_bytes(), data)
        self.assertTrue((self.root / "ext" / "rec.ts.sha256").exists())


class JanitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cfg = load_config(None, {"channel": "chan", "paths": {"data_dir": str(root / "data")},
                                      "storage": {"raw_clips_dir": str(root / "ext" / "raw"),
                                                  "recordings_archive_dir": str(root / "ext" / "rec"),
                                                  "edited_dir": str(root / "edited"),
                                                  "offload_below_gb": 0}})
        self.db = DB(self.cfg.path("db"))
        self.rec = self.cfg.path("recordings") / "chan" / "chan_s1.ts"
        self.rec.parent.mkdir(parents=True)
        self.rec.write_bytes(b"x" * 1000)
        self.db.add_session("s1", "chan", str(self.rec), "best")
        self.db.set_session_start("s1", 1000.0)
        self.db.end_session("s1", 5000.0)  # long ago -> settled

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def sess(self):
        return self.db.session("s1")

    def _event(self, ts, extract="done", archive=None, archived_folder=True):
        eid = f"chan-{ts}"
        self.db.add_event(eid, "chan", float(ts), float(ts), {})
        self.db.conn.execute("UPDATE jobs SET status=? WHERE event_id=? AND stage='extract'", (extract, eid))
        if archive:
            self.db.enqueue(eid, "archive")
            self.db.conn.execute("UPDATE jobs SET status=? WHERE event_id=? AND stage='archive'", (archive, eid))
        if archived_folder:
            folder = storage.raw_archive_root(self.cfg) / storage.library_subpath(eid)
            folder.mkdir(parents=True)
            (folder / "clip.mp4").write_bytes(b"c")
            (folder / "checksums.sha256").write_text("x  clip.mp4\n", encoding="utf-8")
        return eid

    def test_recently_ended_waits(self):
        self.db.end_session("s1", time.time())
        self.assertEqual(storage.session_state(self.cfg, self.db, self.sess())[0], "wait")

    def test_pending_extraction_waits(self):
        self._event(2000, extract="pending", archived_folder=False)
        self.assertEqual(storage.session_state(self.cfg, self.db, self.sess())[0], "wait")

    def test_failed_extraction_holds_forever(self):
        self._event(2000, extract="failed", archived_folder=False)
        self.assertEqual(storage.session_state(self.cfg, self.db, self.sess())[0], "hold")
        storage.janitor_pass(self.cfg, self.db)
        self.assertTrue(self.rec.exists())

    def test_not_backed_up_waits(self):
        self._event(2000, archive="pending", archived_folder=False)
        self.assertEqual(storage.session_state(self.cfg, self.db, self.sess())[0], "wait")

    def test_backup_folder_missing_holds(self):
        self._event(2000, archive="done", archived_folder=False)
        self.assertEqual(storage.session_state(self.cfg, self.db, self.sess())[0], "hold")

    def test_deletes_only_when_everything_backed_up(self):
        self._event(2000, archive="done")
        self._event(3000, archive="pending")
        storage.janitor_pass(self.cfg, self.db)
        self.assertTrue(self.rec.exists())
        self.db.conn.execute("UPDATE jobs SET status='done' WHERE stage='archive'")
        storage.janitor_pass(self.cfg, self.db)
        self.assertFalse(self.rec.exists())
        self.assertEqual(self.sess()["disposition"], "deleted")
        log = self.db.conn.execute("SELECT action FROM storage_log").fetchall()
        self.assertEqual([r["action"] for r in log], ["delete_recording"])

    def test_events_outside_session_dont_count(self):
        self._event(9000, extract="pending", archived_folder=False)  # after the session ended
        self.assertEqual(storage.session_state(self.cfg, self.db, self.sess())[0], "archive_clipless")

    def test_clipless_recording_is_moved_and_kept(self):
        self._event(2000, extract="skipped", archived_folder=False)
        storage.janitor_pass(self.cfg, self.db)
        self.assertFalse(self.rec.exists())
        moved = storage.recordings_archive_root(self.cfg) / "chan" / "chan_s1.ts"
        self.assertTrue(moved.exists())
        self.assertEqual(self.sess()["disposition"], "archived")
        self.assertEqual(self.sess()["path"], str(moved))
        storage.janitor_pass(self.cfg, self.db)  # never deleted afterwards
        self.assertTrue(moved.exists())

    def test_no_archive_configured_never_deletes(self):
        cfg = load_config(None, {"channel": "chan", "paths": {"data_dir": str(self.cfg.data_dir)}})
        self._event(2000, archive="done", archived_folder=False)
        self.assertEqual(storage.session_state(cfg, self.db, self.sess())[0], "hold")


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = load_config(None, {"channel": "chan", "paths": {"data_dir": self.tmp.name},
                                      "queue": {"max_attempts": 1}})
        self.db = DB(self.cfg.path("db"))
        self.db.add_event("chan-1", "chan", 1.0, 1.0, {})

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def _stages(self):
        return {r["stage"]: r["status"] for r in self.db.conn.execute("SELECT * FROM jobs")}

    def test_rejected_edit_is_archived(self):
        self.db.enqueue("chan-1", "edit")
        process_one(self.cfg, self.db, "edit", lambda c, d, j: Done({}, status="rejected"), 60)
        self.assertEqual(self._stages()["archive"], "pending")

    def test_failed_edit_is_still_archived(self):
        self.db.enqueue("chan-1", "edit")
        def boom(c, d, j):
            raise RuntimeError("claude crashed")
        process_one(self.cfg, self.db, "edit", boom, 60)
        self.assertEqual(self._stages()["edit"], "failed")
        self.assertEqual(self._stages()["archive"], "pending")

    def test_failed_transcription_still_gets_edited(self):
        self.db.enqueue("chan-1", "transcribe")
        def boom(c, d, j):
            raise RuntimeError("whisper missing")
        process_one(self.cfg, self.db, "transcribe", boom, 60)
        self.assertEqual(self._stages()["edit"], "pending")

    def test_manual_edit_is_not_archived_yet(self):
        self.db.enqueue("chan-1", "edit")
        process_one(self.cfg, self.db, "edit", lambda c, d, j: Done({}, status="manual"), 60)
        self.assertNotIn("archive", self._stages())


class PathTests(unittest.TestCase):
    def test_library_subpath(self):
        p = storage.library_subpath("some_streamer-1794777430")
        self.assertEqual(p.parts[0], "some_streamer")
        self.assertRegex(p.parts[1], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(p.parts[2], "some_streamer-1794777430")


if __name__ == "__main__":
    unittest.main()


class OffloadTests(JanitorTests):
    def test_low_disk_offloads_recording_with_pending_work(self):
        self.cfg.raw["storage"]["offload_below_gb"] = 10 ** 9  # pretend the drive is always low
        self._event(2000, extract="pending", archived_folder=False)
        storage.janitor_pass(self.cfg, self.db)
        moved = storage.recordings_archive_root(self.cfg) / "chan" / "chan_s1.ts"
        self.assertFalse(self.rec.exists())
        self.assertTrue(moved.exists())
        self.assertEqual(self.sess()["disposition"], "offloaded")
        self.assertEqual(self.db.session_at("chan", 2000.0)["path"], str(moved))  # extraction reads from here
        # once its clips are backed up, the offloaded copy is deleted too
        self.db.conn.execute("UPDATE jobs SET status='done' WHERE stage='extract'")
        self.db.enqueue("chan-2000", "archive")
        self.db.conn.execute("UPDATE jobs SET status='done' WHERE stage='archive'")
        folder = storage.raw_archive_root(self.cfg) / storage.library_subpath("chan-2000")
        folder.mkdir(parents=True)
        (folder / "clip.mp4").write_bytes(b"c")
        (folder / "checksums.sha256").write_text("x  clip.mp4\n", encoding="utf-8")
        storage.janitor_pass(self.cfg, self.db)
        self.assertFalse(moved.exists())
        self.assertEqual(self.sess()["disposition"], "deleted")
