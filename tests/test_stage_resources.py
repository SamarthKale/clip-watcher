"""The installer's staging check: no source files, nothing required missing."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "stage_resources", Path(__file__).resolve().parents[1] / "app" / "scripts" / "stage_resources.py")
stage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stage)


def _make_complete(root: Path) -> None:
    for rel in stage.REQUIRED:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")


class VerifyTest(unittest.TestCase):
    def test_complete_tree_has_no_problems(self):
        with tempfile.TemporaryDirectory() as d:
            _make_complete(Path(d))
            self.assertEqual(stage.verify(Path(d), run=False), [])

    def test_a_python_source_file_is_a_problem(self):
        with tempfile.TemporaryDirectory() as d:
            _make_complete(Path(d))
            (Path(d) / "pipeline" / "clipwatcher" / "secret.py").write_text("x = 1\n", encoding="utf-8")
            problems = stage.verify(Path(d), run=False)
            self.assertEqual(len(problems), 1)
            self.assertIn("secret.py", problems[0])

    def test_a_missing_required_file_is_a_problem(self):
        with tempfile.TemporaryDirectory() as d:
            _make_complete(Path(d))
            (Path(d) / "models" / "ggml-base.bin").unlink()
            self.assertEqual(stage.verify(Path(d), run=False), ["missing: models/ggml-base.bin"])

    def test_both_multilingual_models_ship(self):
        self.assertIn("models/ggml-large-v3-turbo-q5_0.bin", stage.REQUIRED)
        self.assertIn("models/ggml-base.bin", stage.REQUIRED)
        self.assertNotIn("models/ggml-base.en.bin", stage.REQUIRED)


if __name__ == "__main__":
    unittest.main()
