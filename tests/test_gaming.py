"""Gaming & livestream skill pack: signals, audio detector, reframing, exports, QA rules."""
import json
import tempfile
import unittest
from pathlib import Path

from clipwatcher import export, reframe, signals
from clipwatcher.audio_detector import AudioSpikeDetector, per_second
from clipwatcher.config import load_config
from clipwatcher.db import DB
from clipwatcher.editkit import snap_segments
from clipwatcher.editor import _qa_rules


class ChatSignalTests(unittest.TestCase):
    def test_classify_emotes_and_words(self):
        self.assertIn("funny", signals.classify_message("KEKW KEKW"))
        self.assertIn("hype", signals.classify_message("PogChamp what a play"))
        self.assertIn("play", signals.classify_message("that was a 1v3 clutch"))
        self.assertIn("play", signals.classify_message("ACED them"))
        self.assertIn("fail", signals.classify_message("he threw so hard"))
        self.assertIn("shock", signals.classify_message("WTF"))
        self.assertEqual(signals.classify_message("you'll see"), set())  # no "L" false positive
        self.assertEqual(signals.classify_message("what game is this"), set())

    def test_profile_window_votes_and_clip_calls(self):
        msgs = [{"clip_t": 61 + i * 0.5, "text": t} for i, t in enumerate(
            ["KEKW", "LMAO", "clip it", "KEKW clip that", "the", "@bob hi", "ACE"])]
        msgs.append({"clip_t": 10, "text": "KEKW"})  # outside the window
        p = signals.chat_profile(msgs, spike_t=60)
        self.assertEqual(p["messages"], 7)
        self.assertEqual(p["dominant"], "funny")
        self.assertEqual(p["suggested_moment"], "FUNNY")
        self.assertEqual(p["clip_calls"], 2)
        self.assertIn("play", p["category_share"])
        self.assertNotIn("the", p["top_tokens"])
        self.assertFalse(any(t.startswith("@") for t in p["top_tokens"]))


class AudioSignalTests(unittest.TestCase):
    SAMPLE = """[Parsed_ebur128_0 @ 0x1] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x1] t: 0.199979   TARGET:-23 LUFS    M: -24.5 S:-120.7     I: -24.5 LUFS       LRA:   0.0 LU
[silencedetect @ 0x2] silence_start: 1.5
[silencedetect @ 0x2] silence_end: 2.25 | silence_duration: 0.75
[Parsed_ebur128_0 @ 0x1] t: 0.299979   TARGET:-23 LUFS    M: -inf S:-120.7     I: -24.5 LUFS       LRA:   0.0 LU
"""

    def test_parse_ebur128_and_silence(self):
        self.assertEqual(signals.parse_ebur128(self.SAMPLE),
                         [(0.0999792, -120.0), (0.199979, -24.5), (0.299979, -120.0)])
        self.assertEqual(signals.parse_silences(self.SAMPLE), [(1.5, 2.25)])
        self.assertEqual(signals.parse_silences("silence_start: 3.0", total=5.0), [(3.0, 5.0)])

    def test_loud_peaks_merge_and_rank(self):
        curve = [(t / 2, -30.0) for t in range(120)]
        for t in (20.0, 20.5, 21.0):
            curve[int(t * 2)] = (t, -14.0)
        curve[90] = (45.0, -18.0)
        med, peaks = signals.loud_peaks(curve, rise_lu=8)
        self.assertEqual(med, -30.0)
        self.assertEqual([p["t"] for p in peaks], [20.0, 45.0])
        self.assertEqual(peaks[0]["rise_lu"], 16.0)
        self.assertEqual(peaks[0]["duration_s"], 1.5)

    def test_moment_guess_prefers_peak_before_spike(self):
        peaks = [{"t": 30.0, "rise_lu": 12}, {"t": 70.0, "rise_lu": 20}]
        self.assertEqual(signals.moment_guess(40.0, peaks)["t"], 30.0)  # 70 s is after the reaction
        self.assertEqual(signals.moment_guess(40.0, [])["t"], 36.0)

    def test_triage_score_is_bounded(self):
        hi = signals.triage_score({"peak_ratio": 50}, {"category_share": {"funny": 1.0}, "clip_calls": 9},
                                  [], {"rise_lu": 40})
        lo = signals.triage_score({}, {"category_share": {}}, [], {})
        self.assertEqual(hi["score"], 100)
        self.assertEqual(lo["score"], 0)


DET = {"window_seconds": 300, "min_history_seconds": 60, "rise_lu": 10, "floor_lufs": -24,
       "min_seconds": 2, "max_run_seconds": 10, "cooldown_seconds": 90, "gap_seconds": 5}


class AudioDetectorTests(unittest.TestCase):
    def feed(self, det, start, values):
        out = []
        for i, v in enumerate(values):
            out += det.feed(start + i, v)
        return out

    def test_sustained_rise_is_one_event_with_deterministic_id(self):
        det = AudioSpikeDetector("chan", DET, chat_offset=2.0)
        evs = self.feed(det, 1000, [-30.0] * 100 + [-15.0, -12.0, -14.0] + [-30.0] * 5)
        self.assertEqual(len(evs), 1)
        ev = evs[0]
        self.assertEqual(ev.event_id, "chan-1098")  # first loud second (1100) minus the sync offset
        self.assertEqual(ev.stats["source"], "audio")
        self.assertEqual(ev.stats["run_seconds"], 3)
        self.assertEqual(ev.stats["peak_lufs"], -12.0)
        self.assertEqual(ev.stats["baseline_lufs"], -30.0)

    def test_single_loud_second_and_insufficient_history_are_ignored(self):
        det = AudioSpikeDetector("chan", DET)
        self.assertEqual(self.feed(det, 0, [-30.0] * 30 + [-10.0] * 3), [])  # < min history
        det = AudioSpikeDetector("chan", DET)
        self.assertEqual(self.feed(det, 0, [-30.0] * 100 + [-10.0] + [-30.0] * 3), [])  # 1 s only

    def test_quiet_rise_below_floor_and_silence_do_not_trigger(self):
        det = AudioSpikeDetector("chan", DET)
        # -50 baseline, -35 is +15 LU but under the -24 floor
        self.assertEqual(self.feed(det, 0, [-50.0] * 100 + [-35.0] * 4 + [-50.0]), [])
        det = AudioSpikeDetector("chan", DET)
        # muted mic doesn't drag the baseline down, so normal talk afterwards isn't a "spike"
        self.assertEqual(self.feed(det, 0, [-22.0] * 100 + [-120.0] * 200 + [-20.0] * 5 + [-22.0]), [])

    def test_cooldown_and_gap_reset(self):
        det = AudioSpikeDetector("chan", DET)
        loud = [-12.0] * 3 + [-30.0] * 3
        evs = self.feed(det, 0, [-30.0] * 100 + loud + loud)
        self.assertEqual(len(evs), 1)  # the second burst is inside the cooldown
        det = AudioSpikeDetector("chan", DET)
        self.feed(det, 0, [-30.0] * 100)
        self.assertEqual(self.feed(det, 1000, [-10.0] * 3 + [-30.0]), [])  # gap: history reset

    def test_per_second_takes_loudest(self):
        series = [(0.1, -30.0), (0.5, -20.0), (0.9, -25.0), (1.2, -40.0), (2.5, -10.0)]
        self.assertEqual(per_second(series, skip_before=0.2), [(0, -20.0), (1, -40.0), (2, -10.0)])


class EventMergeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = DB(Path(self.tmp.name) / "db.sqlite")

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_audio_spike_near_chat_spike_is_recorded_on_it(self):
        self.assertTrue(self.db.add_event("c-1000", "c", 1000.0, 1000.0, {"first_count": 20}))
        self.assertFalse(self.db.add_event("c-990", "c", 990.0, 992.0,
                                           {"source": "audio", "rise_lu": 14}, merge_window=45))
        self.assertIsNone(self.db.event("c-990"))
        stats = json.loads(self.db.event("c-1000")["stats"])
        self.assertEqual(stats["also_detected_by"][0]["source"], "audio")
        self.assertEqual(stats["also_detected_by"][0]["rise_lu"], 14)
        # repeated delivery doesn't duplicate the note
        self.db.add_event("c-990", "c", 990.0, 992.0, {"source": "audio"}, merge_window=45)
        self.assertEqual(len(json.loads(self.db.event("c-1000")["stats"])["also_detected_by"]), 1)
        jobs = self.db.conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()["n"]
        self.assertEqual(jobs, 1)  # one clip, not two

    def test_same_detector_never_merges_and_far_events_insert(self):
        self.db.add_event("c-1000", "c", 1000.0, 1000.0, {})
        self.assertTrue(self.db.add_event("c-1030", "c", 1030.0, 1030.0, {}, merge_window=45))
        self.assertTrue(self.db.add_event("c-2000", "c", 2000.0, 2000.0, {"source": "audio"}, merge_window=45))


class ReframeTests(unittest.TestCase):
    def test_rect_parse(self):
        self.assertEqual(reframe.Rect.parse("1460, 40, 420,236"), reframe.Rect(1460, 40, 420, 236))
        for bad in ("1,2,3", "a,b,c,d", "0,0,0,10"):
            with self.assertRaises(ValueError):
                reframe.Rect.parse(bad)
        ins = reframe.Inset.parse("1500,80,400,160@560,250,500")
        self.assertEqual((ins.src.w, ins.x, ins.y, ins.width), (400, 560, 250, 500))

    def test_stack_and_insets_graph(self):
        g = reframe.stack(1920, 1080, reframe.Rect(1460, 40, 420, 236), split=0.4)
        self.assertTrue(g.startswith("[vcut]split=2"))
        self.assertIn("scale=1080:768:", g)
        self.assertIn("scale=1080:1152:", g)
        self.assertTrue(g.endswith("[vlay]"))
        g2 = reframe.with_insets(g, [reframe.Inset.parse("1500,80,400,160@40,800,500")], 1920, 1080)
        self.assertTrue(g2.startswith("[vcut]split=2[_main][_i0]"))
        self.assertEqual(g2.count("[vlay]"), 1)
        with self.assertRaises(ValueError):
            reframe.stack(1920, 1080, reframe.Rect(0, 0, 100, 100), split=0.9)

    def test_fit_crop_is_916_and_inside(self):
        r = reframe._fit_crop(1920, 1080, 1080 / 1920, cx=0.99)
        self.assertEqual((r.w, r.h), (606, 1080))
        self.assertLessEqual(r.x + r.w, 1920)

    def test_smooth_path_deadband_and_hold(self):
        times = [i * 0.25 for i in range(40)]
        xs = [0.5] * 10 + [0.53] * 10 + [0.8] * 20  # small wobble ignored, real move followed
        keys = reframe.smooth_path(times, xs, deadband=0.08, alpha=1.0, min_hold=1.0)
        self.assertEqual(keys[0][1], 0.5)
        self.assertEqual(len(keys), 2)
        self.assertAlmostEqual(keys[1][1], 0.8)

    def test_x_expression(self):
        e = reframe.x_expression([(0.0, 0.5), (3.0, 0.8)], 1920, 606, ease=0)
        self.assertEqual(e, "if(lt(t,3.000),656,1232)")
        self.assertIn("min(1,max(0,(t-3.000)/0.400))", reframe.x_expression([(0, 0.5), (3, 0.8)], 1920, 606))
        self.assertEqual(reframe.dedupe_keys([(0, 0.5), (2, 0.5), (3, 0.6)]), [(0, 0.5), (3, 0.6)])


class SnapTests(unittest.TestCase):
    WORDS = [{"w": "so", "start": 1.0, "end": 1.4}, {"w": "he", "start": 1.5, "end": 1.9},
             {"w": "aced", "start": 2.0, "end": 2.6}, {"w": "them", "start": 2.7, "end": 3.2}]

    def test_edges_move_off_words(self):
        segs, notes = snap_segments([(1.6, 2.3)], self.WORDS)
        self.assertEqual(segs, [(1.46, 2.64)])  # start of "he", end of "aced"
        self.assertEqual(len(notes), 1)

    def test_gaps_untouched_and_no_overlap(self):
        segs, notes = snap_segments([(1.45, 1.95), (1.96, 3.3)], self.WORDS)
        self.assertEqual(segs, [(1.45, 1.95), (1.96, 3.3)])
        self.assertEqual(notes, [])


class ExportPlanTests(unittest.TestCase):
    def info(self, **kw):
        v = {"codec": "h264", "width": 1080, "height": 1920, "fps": "30/1", "pix_fmt": "yuv420p",
             "bit_rate": 9_000_000}
        a = {"codec": "aac", "bit_rate": 192_000}
        v.update(kw.pop("video", {}))
        a.update(kw.pop("audio", {}))
        return {"duration": kw.get("duration", 25.0), "video": v, "audio": a, "bytes": kw.get("bytes", 30_000_000)}

    def test_master_reused_when_in_spec(self):
        self.assertEqual(export.plan(self.info(), export.SPECS["youtube_shorts"])["action"], "use_master")
        self.assertEqual(export.plan(self.info(), export.SPECS["tiktok"])["action"], "use_master")

    def test_reels_only_reencodes_audio(self):
        p = export.plan(self.info(), export.SPECS["instagram_reels"])
        self.assertEqual((p["action"], p["video"], p["audio"]), ("encode", False, True))

    def test_too_long_is_skipped_not_trimmed(self):
        p = export.plan(self.info(duration=200), export.SPECS["youtube_shorts"])
        self.assertEqual(p["action"], "skip")

    def test_out_of_spec_video(self):
        p = export.plan(self.info(video={"fps": "120/1"}), export.SPECS["youtube_shorts"])
        self.assertTrue(p["video"])
        p = export.plan(self.info(video={"bit_rate": 40_000_000}), export.SPECS["instagram_reels"])
        self.assertTrue(p["video"])

    def test_config_overrides_specs(self):
        cfg = load_config(None, {"export": {"specs": {"tiktok": {"max_seconds": 10}}}})
        self.assertEqual(export.specs(cfg)["tiktok"]["max_seconds"], 10)
        self.assertEqual(export.SPECS["tiktok"]["max_seconds"], 600)  # defaults untouched


class QARuleTests(unittest.TestCase):
    def base(self, **qa):
        return {"video": {"width": 1080, "height": 1920, "codec": "h264", "pix_fmt": "yuv420p", "fps": "30/1"},
                "qa": {"black": [], "frozen": [], "silent": [], **qa}}

    def test_clean_render_passes(self):
        self.assertEqual(_qa_rules(self.base()), ([], []))

    def test_black_open_and_long_freeze_fail(self):
        p, _ = _qa_rules(self.base(black=[[0.0, 0.4]], frozen=[[5.0, 8.0]]))
        self.assertEqual(len(p), 2)

    def test_soft_issues_are_warnings(self):
        p, w = _qa_rules(self.base(black=[[4.0, 4.2]], frozen=[[3.0, 4.2]], silent=[[6.0, 8.0]]))
        self.assertEqual(p, [])
        self.assertEqual(len(w), 3)

    def test_format_problems(self):
        info = self.base()
        info["video"].update(width=720, height=1280, pix_fmt="yuv444p", codec="hevc", fps="120/1")
        self.assertEqual(len(_qa_rules(info)[0]), 4)


if __name__ == "__main__":
    unittest.main()
