import json
import tempfile
import unittest
from pathlib import Path

from clipwatcher import library
from clipwatcher.config import load_config
from clipwatcher.db import DB

URL = "https://www.twitch.tv/abc"


def good_seo(**over):
    seo = {
        "title": "Abc Hits The Impossible Shot In Ranked, Chat Loses It",
        "description": "Abc lines up a shot nobody thought was possible and lands it. "
                       "Chat goes wild in seconds.\n\nStreamer: " + URL,
        "hashtags": ["#shorts", "#abc", "#gaming"],
        "tags": ["abc clips", "ranked highlights"],
        "keywords": ["abc ranked", "impossible shot"],
        "hook_text": "Impossible shot",
        "language": "en",
        "captions": {"tiktok": "He did it", "shorts": "He did it", "reels": "He did it"},
    }
    seo.update(over)
    return seo


class SeoTests(unittest.TestCase):
    def test_good_block_passes(self):
        self.assertEqual(library.seo_problems(good_seo(), URL), [])

    def test_missing_or_wrong_type(self):
        self.assertTrue(library.seo_problems(None, URL))
        self.assertTrue(library.seo_problems("text", URL))

    def test_title_limits_and_links(self):
        self.assertTrue(any("100" in p for p in library.seo_problems(good_seo(title="x" * 101), URL)))
        self.assertTrue(any("link" in p for p in library.seo_problems(good_seo(title="see http://x.co"), URL)))

    def test_description_must_credit_streamer(self):
        bad = library.seo_problems(good_seo(description="y" * 120), URL)
        self.assertTrue(any("credit" in p for p in bad))

    def test_hashtags_shape(self):
        self.assertTrue(library.seo_problems(good_seo(hashtags=["#a b", "#ok", "#fine"]), URL))
        self.assertTrue(library.seo_problems(good_seo(hashtags=["#one", "#two"]), URL))
        self.assertTrue(library.seo_problems(good_seo(hashtags=["#one", "#ONE", "#two"]), URL))

    def test_captions_limits(self):
        caps = {"tiktok": "t", "shorts": "s" * 301, "reels": "r"}
        self.assertTrue(any("shorts" in p for p in library.seo_problems(good_seo(captions=caps), URL)))

    def test_unicode_is_fine_in_text(self):
        seo = good_seo(title="bhai ye dekh \U0001f62d", hook_text="नमस्ते")
        self.assertEqual(library.seo_problems(seo, URL), [])


class SlugTests(unittest.TestCase):
    def test_ascii_only_and_never_empty(self):
        self.assertEqual(library.slugify("He Stole a FERRARI! \U0001f62d"), "he-stole-a-ferrari")
        self.assertEqual(library.slugify("नमस्ते \U0001f62d"), "clip")
        self.assertEqual(library.slugify(""), "clip")

    def test_length_cut_on_word_boundary(self):
        s = library.slugify("word " * 40, 20)
        self.assertLessEqual(len(s), 20)
        self.assertFalse(s.endswith("-"))


def make_env(tmp: str):
    cfg_path = Path(tmp) / "config.toml"
    cfg_path.write_text(
        f'[paths]\ndata_dir = "{Path(tmp, "data").as_posix()}"\n'
        f'[storage]\nedited_dir = "{Path(tmp, "Edited").as_posix()}"\n'
        f'[library]\ndir = "{Path(tmp, "Shorts").as_posix()}"\n', encoding="utf-8")
    cfg = load_config(cfg_path, {"channel": "abc"})
    db = DB(Path(tmp) / "t.db")
    return cfg, db


def make_short(cfg, db, event_id="abc-1795000000", seo=None, session="abc_20261118T110000Z"):
    from clipwatcher.editor import short_dir
    sdir = short_dir(cfg, event_id)
    (sdir / "final").mkdir(parents=True)
    (sdir / "short.mp4").write_bytes(b"video-bytes")
    (sdir / "final" / "cover.jpg").write_bytes(b"cover")
    (sdir / "final" / "thumbnail.jpg").write_bytes(b"thumb")
    dec = {"logline": "x", "highlight_score": {"total": 61}}
    if seo is not None:
        dec["seo"] = seo
    (sdir / "edit_decisions.json").write_text(json.dumps(dec), encoding="utf-8")
    (sdir / "description.txt").write_text(
        f"Title options:\n1. \"Old Style Title\"\n\nDescription:\nHe did a thing.\n\nStreamer: {URL}\n\n"
        "Hashtags: #shorts #abc #gaming\n", encoding="utf-8")
    (sdir / "metadata.json").write_text(json.dumps({
        "event_id": event_id,
        "attribution": {"streamer": "abc", "channel": "abc", "channel_url": URL,
                        "credit_line": f"Streamer: abc - {URL}"},
        "recording_session": session,
        "source_clip": {"source_start": "00:10:00.000", "source_end": "00:12:30.000",
                        "source_start_s": 600.0, "source_end_s": 750.0,
                        "source_start_utc": "2026-11-18T11:13:00+00:00",
                        "source_end_utc": "2026-11-18T11:15:30+00:00"},
        "spike": {"spike_utc": "2026-11-18T11:14:00+00:00",
                  "stats": {"first_count": 20, "baseline": 6.0, "first_ratio": 3.3}},
        "short": {"duration": 52.4}, "highlight_score": 61, "moment_type": "HYPE"}), encoding="utf-8")
    db.add_session(session, "abc", "x.ts", "best")
    return sdir


class PublishTests(unittest.TestCase):
    def setUp(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        self.tmp = tmpdir.name
        self.cfg, self.db = make_env(self.tmp)
        self.addCleanup(self.db.close)  # runs before the folder is removed

    def test_publish_layout_and_idempotence(self):
        cfg, db, tmp = self.cfg, self.db, self.tmp
        make_short(cfg, db, seo=good_seo())
        v1 = library.publish(cfg, db, "abc-1795000000")
        folder = v1.parent
        self.assertTrue(folder.name.endswith("abc__live"))
        self.assertRegex(v1.name, r"^01_[a-z0-9-]+\.mp4$")
        self.assertTrue((folder / (v1.stem + "_cover.jpg")).exists())
        self.assertTrue((folder / (v1.stem + "_thumb.jpg")).exists())
        doc = json.loads((folder / "clips.json").read_text("utf-8"))
        self.assertEqual(doc["schema"], 2)
        clip = doc["clips"][0]
        self.assertEqual(clip["file"], v1.name)
        self.assertEqual(clip["post_title"], good_seo()["title"])
        self.assertEqual(clip["captions"]["tiktok"], "He did it")
        self.assertEqual(clip["attribution"]["channel_url"], URL)
        self.assertEqual(clip["event_id"], "abc-1795000000")
        self.assertIn("POST.md", [p.name for p in folder.iterdir()])
        # second run: same file, one entry, nothing duplicated
        v2 = library.publish(cfg, db, "abc-1795000000")
        self.assertEqual(v1, v2)
        doc = json.loads((folder / "clips.json").read_text("utf-8"))
        self.assertEqual(len(doc["clips"]), 1)
        self.assertEqual(len([p for p in folder.glob("*.mp4")]), 1)

    def test_numbers_increase_per_event(self):
        cfg, db, tmp = self.cfg, self.db, self.tmp
        make_short(cfg, db, "abc-1795000000", good_seo())
        make_short(cfg, db, "abc-1795000100", good_seo(title="Second Clip Title Here"), session="abc_s2")
        a = library.publish(cfg, db, "abc-1795000000")
        b = library.publish(cfg, db, "abc-1795000100")
        self.assertTrue(a.name.startswith("01_") and b.name.startswith("02_"))

    def test_old_shorts_without_seo_are_derived_not_dropped(self):
        cfg, db, tmp = self.cfg, self.db, self.tmp
        make_short(cfg, db)
        v = library.publish(cfg, db, "abc-1795000000")
        clip = json.loads((v.parent / "clips.json").read_text("utf-8"))["clips"][0]
        self.assertEqual(clip["post_title"], "Old Style Title")
        self.assertTrue(clip["seo_derived"])
        self.assertIn(URL, clip["description"])

    def test_unreadable_clips_json_is_kept_not_lost(self):
        cfg, db, tmp = self.cfg, self.db, self.tmp
        make_short(cfg, db, seo=good_seo())
        folder = library.stream_folder(cfg, "abc", "2026-11-18", "live")
        folder.mkdir(parents=True)
        (folder / "clips.json").write_text("{not json", encoding="utf-8")
        library.publish(cfg, db, "abc-1795000000")
        self.assertTrue(list(folder.glob("clips.corrupt-*.json")))
        self.assertEqual(len(json.loads((folder / "clips.json").read_text("utf-8"))["clips"]), 1)

    def test_nothing_published_for_unfinished_edit(self):
        cfg, db, tmp = self.cfg, self.db, self.tmp
        self.assertIsNone(library.publish(cfg, db, "abc-1795000000"))

    def test_bad_names_are_refused(self):
        cfg = self.cfg
        with self.assertRaises(ValueError):
            library.stream_folder(cfg, "../evil", "2026-11-18", "live")
        with self.assertRaises(ValueError):
            library.stream_folder(cfg, "abc", "2026-11-18", "other")


if __name__ == "__main__":
    unittest.main()
