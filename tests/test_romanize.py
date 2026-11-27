import json
import tempfile
import unittest
from pathlib import Path

from clipwatcher import romanize
from clipwatcher.editkit import apply_latin
from clipwatcher.transcriber import REPLACEMENT_CHAR, words_from_whisper_json


class TransliterationTests(unittest.TestCase):
    def test_common_hinglish_spellings(self):
        cases = {
            "भाई ये देख": "bhai ye dekh",
            "मुझे नहीं पता क्या हो रहा है": "mujhe nahi pata kya ho raha hai",
            "बहुत मज़ा आया": "bahut maza aya",
            "समझ": "samajh",
            "नमस्ते": "namaste",
        }
        for dev, latin in cases.items():
            self.assertEqual(romanize.to_latin(dev), latin, dev)

    def test_latin_and_digits_pass_through(self):
        self.assertEqual(romanize.to_latin("1v3 clutch, bro!"), "1v3 clutch, bro!")
        self.assertEqual(romanize.to_latin("Wait 3 बजे"), "Wait 3 baje")
        self.assertEqual(romanize.to_latin(""), "")

    def test_never_leaves_devanagari_behind(self):
        text = "ऑफिस क्षति ग्राहक ड़ैश"
        self.assertFalse(romanize.has_devanagari(romanize.to_latin(text)))


class ClassifyTests(unittest.TestCase):
    def test_english(self):
        self.assertEqual(romanize.classify_language("en", "so I went to the store".split()), "en")

    def test_pure_hindi(self):
        self.assertEqual(romanize.classify_language("hi", "मुझे नहीं पता क्या हो रहा है".split()), "hi")

    def test_mixed_scripts_are_hinglish(self):
        self.assertEqual(romanize.classify_language("hi", "bro ये game बहुत crazy है yaar".split()), "hinglish")

    def test_latin_hinglish_is_hinglish(self):
        self.assertEqual(romanize.classify_language("en", "bhai ye kya hai yaar nahi pata".split()), "hinglish")

    def test_empty_is_safe(self):
        self.assertEqual(romanize.classify_language(None, []), "en")
        self.assertEqual(romanize.classify_language("hi", []), "hi")


class CaptionTextTests(unittest.TestCase):
    WORDS = [{"w": "भाई", "start": 0, "end": 1}, {"w": "game", "start": 1, "end": 2},
             {"w": "देख", "start": 2, "end": 3, "latin": "dekh"}]

    def test_default_is_latin(self):
        self.assertEqual([w["w"] for w in apply_latin(self.WORDS)], ["bhai", "game", "dekh"])

    def test_romanized_json_wins_by_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "romanized.json"
            f.write_text(json.dumps({"0": "bhaiya", "2": "dekh le"}), encoding="utf-8")
            self.assertEqual([w["w"] for w in apply_latin(self.WORDS, str(f))], ["bhaiya", "game", "dekh le"])
            f.write_text(json.dumps({"words": ["bhaiii", "", ""]}), encoding="utf-8")
            self.assertEqual(apply_latin(self.WORDS, str(f))[0]["w"], "bhaiii")

    def test_missing_override_file_is_ignored(self):
        self.assertEqual(apply_latin(self.WORDS, "does-not-exist.json")[0]["w"], "bhai")

    def test_timings_and_other_fields_survive(self):
        out = apply_latin(self.WORDS)
        self.assertEqual((out[2]["start"], out[2]["end"]), (2, 3))


class BrokenTokenTests(unittest.TestCase):
    def test_half_written_characters_fall_back_to_segment_text(self):
        seg = {"offsets": {"from": 0, "to": 4000}, "text": " भाई ये देख",
               "tokens": [{"text": " " + REPLACEMENT_CHAR, "offsets": {"from": 0, "to": 1000}, "p": 0.9},
                          {"text": REPLACEMENT_CHAR, "offsets": {"from": 1000, "to": 2000}, "p": 0.9}]}
        words = words_from_whisper_json({"transcription": [seg]})
        self.assertEqual([w["w"] for w in words], ["भाई", "ये", "देख"])
        self.assertTrue(all(0 <= w["start"] <= w["end"] <= 4 for w in words))
        self.assertEqual(words[0]["start"], 0)

    def test_normal_tokens_still_merge_into_words(self):
        seg = {"offsets": {"from": 0, "to": 2000}, "text": " hello world",
               "tokens": [{"text": " hel", "offsets": {"from": 0, "to": 500}, "p": 0.9},
                          {"text": "lo", "offsets": {"from": 500, "to": 900}, "p": 0.8},
                          {"text": " world", "offsets": {"from": 1000, "to": 2000}, "p": 0.9}]}
        words = words_from_whisper_json({"transcription": [seg]})
        self.assertEqual([w["w"] for w in words], ["hello", "world"])


if __name__ == "__main__":
    unittest.main()
