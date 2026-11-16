import copy
import json
import tempfile
import unittest
from pathlib import Path

from clipwatcher.config import DEFAULTS
from clipwatcher.detector import SpikeDetector, detect_file

D = copy.deepcopy(DEFAULTS["detect"])
T0 = 1_700_000_000.0  # bucket-aligned (divisible by 10)


def stream(per_bucket, start=T0, hb=5.0, connect=True):
    """chat.log records: `per_bucket[i]` messages spread over bucket i, plus heartbeats."""
    recs = [{"type": "connect", "t": start - 0.5}] if connect else []
    for i, n in enumerate(per_bucket):
        b = start + i * 10
        items = [{"type": "heartbeat", "t": b + k * hb} for k in range(int(10 / hb))]
        items += [{"type": "msg", "t": b + (j + 0.5) * 10 / max(n, 1), "text": "x"} for j in range(n)]
        recs += sorted(items, key=lambda r: r["t"])
    recs.append({"type": "heartbeat", "t": start + len(per_bucket) * 10 + 0.1})
    return recs


def run(recs, **over):
    d = {**D, **over}
    det = SpikeDetector("chan", d)
    out = []
    for r in recs:
        out += det.feed(r)
    return out + det.flush()


class DetectorTests(unittest.TestCase):
    def test_simple_3x_spike(self):
        evs = run(stream([5] * 31 + [20] + [5] * 10))
        self.assertEqual(len(evs), 1)
        ev = evs[0]
        self.assertEqual(ev.spike_ts, T0 + 31 * 10)
        self.assertEqual(ev.stats["first_count"], 20)
        self.assertAlmostEqual(ev.stats["baseline"], 5.0)
        self.assertEqual(ev.event_id, f"chan-{int(T0 + 310)}")

    def test_below_threshold_is_not_a_spike(self):
        self.assertEqual(run(stream([5] * 31 + [14] + [5] * 5)), [])

    def test_exactly_threshold_counts(self):
        self.assertEqual(len(run(stream([5] * 31 + [15] + [5] * 5))), 1)

    def test_bucket_not_in_its_own_baseline(self):
        # Baseline 4.0 from previous buckets only: 12 = 3x -> spike. If the bucket were
        # included the baseline would be ~4.26 and 12 would not reach 3x.
        evs = run(stream([4] * 30 + [12] + [4] * 3), min_spike_messages=1)
        self.assertEqual(len(evs), 1)
        self.assertAlmostEqual(evs[0].stats["baseline"], 4.0)

    def test_insufficient_history_ignored(self):
        # The first bucket after connect is partial and dropped, so 29 valid buckets < 30.
        self.assertEqual(run(stream([5] * 29 + [50] + [5] * 3)), [])

    def test_zero_baseline_is_floored(self):
        # Dead chat then 5 messages: 5 >= 3 * min_baseline but < min_spike_messages.
        self.assertEqual(run(stream([0] * 31 + [5] + [0] * 3)), [])
        evs = run(stream([0] * 31 + [9] + [0] * 3))
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0].stats["first_ratio"], 9.0)

    def test_consecutive_spike_buckets_merge(self):
        evs = run(stream([5] * 31 + [20, 40, 30] + [5] * 5))
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0].stats["run_buckets"], 3)
        self.assertEqual(evs[0].stats["peak_count"], 40)
        self.assertEqual(evs[0].peak_ts, T0 + 32 * 10)

    def test_cooldown_prevents_duplicates(self):
        evs = run(stream([5] * 31 + [30, 5, 5, 30] + [5] * 20))
        self.assertEqual(len(evs), 1)
        evs = run(stream([5] * 31 + [30] + [5] * 10 + [60] + [5] * 3))
        self.assertEqual(len(evs), 2)

    def test_disconnect_resets_history(self):
        recs = stream([5] * 31)
        last = recs[-1]["t"]
        recs.append({"type": "disconnect", "t": last + 1})
        recs += stream([5] * 3 + [40] + [5] * 3, start=last + 59.5)
        self.assertEqual(run(recs), [])

    def test_silent_log_gap_resets_history(self):
        recs = stream([5] * 31)
        last = recs[-1]["t"]  # no heartbeats for 60s = monitoring gap
        recs += stream([5] * 3 + [40] + [5] * 3, start=last + 59.9, connect=False)
        self.assertEqual(run(recs), [])

    def test_threshold_configurable(self):
        self.assertEqual(len(run(stream([5] * 31 + [11] + [5] * 3), threshold=2.0)), 1)

    def test_detect_file_matches_streaming(self):
        recs = stream([5] * 31 + [25] + [5] * 20 + [40] + [5] * 3)
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "chat.log"
            p.write_text("".join(json.dumps(r) + "\n" for r in recs) + '{"type": "msg", "t"',
                         encoding="utf-8")  # torn last line is ignored
            file_events = detect_file(p, "chan", D)
        self.assertEqual([e.event_id for e in file_events], [e.event_id for e in run(recs)])
        self.assertEqual(len(file_events), 2)


if __name__ == "__main__":
    unittest.main()
