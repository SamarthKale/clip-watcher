"""Follow the speaker: speaker turns -> a 9:16 crop that moves to whoever is talking."""
import io
import unittest
from contextlib import redirect_stdout

from clipwatcher import editkit, reframe


class SpeakerPathTests(unittest.TestCase):
    def test_keys_are_parsed_sorted_and_clamped(self):
        self.assertEqual(editkit.parse_speaker_keys("6.5:0.72, 0:0.3 ,12:1.4"),
                         [(0.0, 0.3), (6.5, 0.72), (12.0, 1.0)])
        with self.assertRaises(ValueError):
            editkit.parse_speaker_keys("0:left")
        with self.assertRaises(ValueError):
            editkit.parse_speaker_keys("")

    def test_first_key_is_moved_to_zero(self):
        self.assertEqual(editkit.parse_speaker_keys("2:0.3,5:0.7")[0], (0.0, 0.3))

    def test_cli_prints_the_crop_expression(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            editkit.main(["speakerpath", "--size", "1920x1080", "--keys", "0:0.3,6.5:0.72", "--ease", "0"])
        out = buf.getvalue()
        win = reframe._fit_crop(1920, 1080, reframe.OUT_W / reframe.OUT_H)
        self.assertIn(reframe.x_expression([(0.0, 0.3), (6.5, 0.72)], 1920, win.w, ease=0), out)
        self.assertIn("reframe", out)


if __name__ == "__main__":
    unittest.main()
