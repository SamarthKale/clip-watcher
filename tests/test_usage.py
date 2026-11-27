import json
import tempfile
import unittest
from pathlib import Path

from clipwatcher import usage
from clipwatcher.db import DB

RUN = json.dumps({
    "total_cost_usd": 0.99, "num_turns": 59, "duration_ms": 220346,
    "usage": {"input_tokens": 90, "cache_creation_input_tokens": 91071,
              "cache_read_input_tokens": 4212064, "output_tokens": 19991},
    "modelUsage": {"claude-sonnet-5-5": {"costUSD": 0.99}},
})


class ParseTests(unittest.TestCase):
    def test_parse_real_shape(self):
        u = usage.parse_run(RUN)
        self.assertEqual(u["cache_read"], 4212064)
        self.assertEqual(u["output_tokens"], 19991)
        self.assertEqual(u["model"], "claude-sonnet-5-5")
        self.assertAlmostEqual(u["cost_usd"], 0.99)
        self.assertEqual(u["turns"], 59)

    def test_garbage_is_none_not_a_crash(self):
        for bad in ("", "not json", "[]", "null", "{}", None):
            self.assertIsNone(usage.parse_run(bad), bad)


class DbTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = DB(Path(tmp.name) / "u.db")
        self.addCleanup(self.db.close)

    def test_failed_attempts_count_and_show_as_waste(self):
        usage.record_attempt(self.db, "ch-1", 1, "invalid", RUN)
        usage.record_attempt(self.db, "ch-1", 2, "invalid", RUN)
        usage.record_attempt(self.db, "ch-1", 3, "done", RUN)
        usage.record_attempt(self.db, "ch-2", 1, "rejected", RUN)
        s = usage.summary(self.db)
        self.assertEqual(s["total"]["attempts"], 4)
        self.assertEqual(s["total"]["videos"], 2)
        self.assertEqual(s["total"]["finished"], 1)
        self.assertAlmostEqual(s["total"]["cost_usd"], 3.96, places=2)
        self.assertAlmostEqual(s["total"]["wasted_usd"], 2.97, places=2)
        # average per finished Short includes the failed attempts that led to it
        self.assertAlmostEqual(s["total"]["avg_per_finished_usd"], 2.97, places=2)
        v = next(v for v in s["videos"] if v["event_id"] == "ch-1")
        self.assertEqual((v["attempts"], v["finished"]), (3, True))
        self.assertEqual(s["per_stream"][0]["channel"], "ch")

    def test_spent_and_no_rows(self):
        self.assertEqual(usage.spent_usd(self.db, "x-1"), 0)
        self.assertEqual(usage.summary(self.db)["total"]["videos"], 0)
        self.assertIsNone(usage.summary(self.db)["total"]["avg_per_finished_usd"])
        usage.record_attempt(self.db, "x-1", 1, "invalid", RUN)
        self.assertAlmostEqual(usage.spent_usd(self.db, "x-1"), 0.99)

    def test_unparseable_output_records_nothing(self):
        self.assertIsNone(usage.record_attempt(self.db, "x-1", 1, "invalid", "crashed"))
        self.assertEqual(self.db.usage_rows(), [])


if __name__ == "__main__":
    unittest.main()
