"""STEP 5 - Transcribe raw clips with whisper.cpp (editing context, not final captions).

Reference:  whisper-cli -m models/ggml-medium.en.bin -f raw_clips/clip.mp4 -osrt

The clip's audio is converted to 16 kHz mono WAV first (whisper.cpp's native
input), then whisper-cli writes an SRT plus its full JSON (token timestamps).
From those this stage writes, next to clip.mp4:

  transcript.srt            segment timings relative to clip.mp4
  transcript.recording.srt  the same, shifted onto the original recording's timeline
  transcript.json           whisper.cpp's full output (tokens, probabilities)
  words.json                word-level timings (clip- and recording-relative)

Nothing is burned into video here; the editor decides how captions look.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

from . import media
from .config import Config
from .db import DB
from .extractor import clip_dir
from .util import read_json, which, write_json
from .worker import Done, Skip

log = logging.getLogger("transcribe")

_SRT_TIME = re.compile(r"(\d+):(\d\d):(\d\d)[,.](\d{3})")


def _srt_to_s(ts: str) -> float:
    h, m, s, ms = map(int, _SRT_TIME.match(ts.strip()).groups())
    return h * 3600 + m * 60 + s + ms / 1000


def _s_to_srt(t: float) -> str:
    t = max(0.0, t)
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def shift_srt(text: str, offset: float) -> str:
    def repl(line: str) -> str:
        if "-->" not in line:
            return line
        a, b = line.split("-->")
        return f"{_s_to_srt(_srt_to_s(a) + offset)} --> {_s_to_srt(_srt_to_s(b) + offset)}"
    return "\n".join(repl(line) for line in text.splitlines()) + "\n"


def words_from_whisper_json(data: dict) -> list[dict]:
    """Merge whisper.cpp tokens into words with start/end seconds (clip-relative)."""
    words: list[dict] = []
    for seg in data.get("transcription", []):
        for tok in seg.get("tokens", []):
            text = tok.get("text", "")
            if not text or text.startswith("[_") or text.strip() in ("", "[BLANK_AUDIO]"):
                continue
            off = tok.get("offsets") or {}
            t0, t1 = off.get("from", 0) / 1000, off.get("to", 0) / 1000
            p = tok.get("p")
            # A leading space starts a new word; anything else (sub-word pieces,
            # punctuation) is glued onto the previous word.
            if text.startswith(" ") or not words:
                words.append({"w": text.strip(), "start": round(t0, 3), "end": round(t1, 3),
                              "p": round(p, 3) if p is not None else None})
            else:
                w = words[-1]
                w["w"] += text
                w["end"] = round(max(w["end"], t1), 3)
                if p is not None and w["p"] is not None:
                    w["p"] = round(min(w["p"], p), 3)
    return [w for w in words if w["w"]]


def handle(cfg: Config, db: DB, job) -> Done | Skip:
    tr, x = cfg["transcribe"], cfg["extract"]
    out_dir = clip_dir(cfg, job["event_id"])
    clip = out_dir / "clip.mp4"
    meta_path = out_dir / "metadata.json"
    if not clip.exists() or not meta_path.exists():
        return Skip("raw clip missing; re-run the extract stage")
    if (out_dir / "words.json").exists() and (out_dir / "transcript.srt").exists():
        return Done({"srt": str(out_dir / "transcript.srt")}, next_stage="edit")

    binary = tr["whisper_cli"]
    if which(binary) is None:
        raise RuntimeError(f"whisper-cli not found ({binary!r}); install whisper.cpp or set "
                           "transcribe.whisper_cli / transcribe.enabled=false")
    model = cfg.resolve(tr["model"])
    if not model.exists():
        raise RuntimeError(f"whisper model not found: {model} (download ggml-medium.en.bin from "
                           "https://huggingface.co/ggerganov/whisper.cpp)")

    wav = out_dir / "audio16k.wav"
    media.run(media.wav_cmd(x["ffmpeg"], clip, wav), timeout=600)
    prefix = out_dir / "transcript"
    cmd = [binary, "-m", str(model), "-f", str(wav), "-l", tr["language"],
           "-t", str(tr["threads"]), "-osrt", "-oj", "-ojf", "-of", str(prefix),
           *[str(a) for a in tr.get("extra_args", [])]]
    try:
        media.run(cmd, timeout=3600)
    finally:
        wav.unlink(missing_ok=True)

    srt_path, json_path = Path(f"{prefix}.srt"), Path(f"{prefix}.json")
    if not srt_path.exists():
        raise RuntimeError("whisper-cli finished but produced no .srt")
    meta = read_json(meta_path)
    src_start = float(meta["clip"]["source_start_s"])
    srt = srt_path.read_text(encoding="utf-8", errors="replace")
    (out_dir / "transcript.recording.srt").write_text(shift_srt(srt, src_start), encoding="utf-8")

    words: list[dict] = []
    if json_path.exists():
        try:
            words = words_from_whisper_json(read_json(json_path))
        except (ValueError, KeyError) as e:
            log.warning("could not parse word timings: %s", e)
    for w in words:
        w["rec_start"] = round(w["start"] + src_start, 3)
        w["rec_end"] = round(w["end"] + src_start, 3)
    write_json(out_dir / "words.json", {
        "event_id": job["event_id"],
        "model": str(tr["model"]),
        "language": tr["language"],
        "clip_source_start_s": src_start,
        "note": "start/end are seconds in clip.mp4; rec_start/rec_end are seconds in the source recording",
        "words": words,
    })
    meta["transcript"] = {"srt": "transcript.srt", "recording_srt": "transcript.recording.srt",
                          "words": "words.json", "word_count": len(words), "model": str(tr["model"])}
    write_json(meta_path, meta)
    log.info("transcribed %s: %d words", job["event_id"], len(words))
    return Done({"srt": str(srt_path), "words": len(words)}, next_stage="edit")
