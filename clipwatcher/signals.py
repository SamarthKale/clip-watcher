"""Highlight signals for a raw clip: what the audio, the picture and chat say happened.

The chat spike only says *roughly when* chat reacted. These signals help the
editor (and the triage score) find the actual moment and what kind it is:

  audio   - momentary loudness (EBU R128 M, 400 ms window) every 0.5 s, the loud
            peaks above the clip's own median (screams, explosions, gunfire bursts),
            and silences (natural cut points)
  picture - scene changes (hard cuts, killcams, death screens, menus)
  chat    - what chat is *saying*: emote/keyword categories (funny, hype, play,
            fail, rage, shock, wholesome), "clip it" calls, message rate over time

Everything here is ffmpeg + the standard library. Nothing is modified: the raw
clip is only read. The combined score is a triage hint, not a verdict; Claude
still decides from the footage.

    signals.json = analyze(ffmpeg, ffprobe, clip, chat_context, spike_t, peak_t)
"""
from __future__ import annotations

import math
import re
import statistics
import subprocess
from collections import Counter
from pathlib import Path

from . import media

VERSION = 1

# ---------------------------------------------------------------- chat lexicon
# Twitch emotes are case-sensitive tokens; words are matched case-insensitively.
EMOTES: dict[str, set[str]] = {
    "funny": {"KEKW", "LUL", "LULW", "OMEGALUL", "ICANT", "KEKL", "KEKWait", "pepeLaugh", "LMAO",
              "LMFAO", "xD", "XD", "Kappa", "4Head", "EleGiggle", "KEKHeim", "Clueless"},
    "hype": {"Pog", "PogChamp", "POGGERS", "PogU", "POG", "POGGIES", "PagMan", "PagChomp", "EZ",
             "EZClap", "Clap", "LETSGO", "GIGACHAD", "Chad", "catJAM", "HYPERS", "W", "WW", "WWW"},
    "fail": {"Sadge", "PepeHands", "F", "L", "LL", "LLL", "BibleThump", "NotLikeThis", "FailFish",
             "Copium", "COPIUM", "OMEGADANCE"},
    "rage": {"Madge", "MALDING", "Malding", "ANGERY", "SwiftRage", "DansGame", "BabyRage", "WeirdChamp"},
    "shock": {"monkaS", "monkaW", "monkaGIGA", "D:", "WAYTOODANK", "HUH", "Stare", "WutFace", "NOWAY",
              "WTF", "WHAT", "pepeMeltdown", "Susge"},
    "wholesome": {"<3", "peepoHappy", "FeelsGoodMan", "widepeepoHappy", "peepoLove", "HeyGuys",
                  "VirtualHug", "bleedPurple"},
}
WORDS: dict[str, tuple[str, ...]] = {
    "funny": (r"\blo+l\b", r"\blmf?a+o+\b", r"\b(?:ha){2,}h?\b", r"\bdead\b", r"\bcrying\b",
              r"\bi can'?t\b", r"😂", r"🤣", r"💀"),
    "hype": (r"\binsane\b", r"\bholy\b", r"\blets? ?go+\b", r"\bgg\b", r"\bgoated\b", r"\bcracked\b",
             r"\bno way\b", r"🔥"),
    # what kind of *play* it was - kills, aces, clutches (shooters, MOBAs, battle royales)
    "play": (r"\bclutch\w*", r"\bace[ds]?\b", r"\b1 ?v ?[2-5]\b", r"\bhead ?shot\w*", r"\bone ?tap\w*",
             r"\b1 ?tap\w*", r"\b(?:double|triple|quadra?|penta)(?: ?kill)?\b", r"\bmulti ?kill\b",
             r"\bteam ?wipe\w*", r"\b[2-5] ?k\b", r"\bno ?scope\w*", r"\bflick\w*", r"\baim ?bot\b",
             r"\bdiff\b", r"\bwiped?\b", r"\bnade\b", r"\bsnipe[ds]?\b", r"\bkill\w*", r"\bwon\b",
             r"\bwin\b", r"\bdub\b", r"\bvictory\b", r"\bchicken dinner\b"),
    "fail": (r"\bunlucky\b", r"\bthrow\w*", r"\bthrew\b", r"\brip\b", r"\bbruh\b", r"\bnoob\b",
             r"\bbot\b", r"\bwhiff\w*", r"\bchoke\w*", r"\bdied\b", r"\bfail\w*"),
    "rage": (r"\btilt\w*", r"\bmald\w*", r"\brag(?:e|ing)\b", r"\bmad\b", r"\bangry\b", r"\bslam\w*"),
    "shock": (r"\bwtf\b", r"\bomg\b", r"\bhuh\b", r"\bbro what\b", r"😱", r"😳", r"\?{3,}"),
    "wholesome": (r"\bwholesome\b", r"\baw+\b", r"\bcute\b", r"\blove (?:this|him|her|u|you)\b",
                  r"❤", r"♥", r"\bty\b", r"\bthank you\b"),
}
CATEGORIES = ("funny", "hype", "play", "fail", "rage", "shock", "wholesome")
STOPWORDS = {"the", "a", "an", "is", "are", "was", "of", "and", "or", "to", "in", "on", "it", "i", "you",
             "u", "ur", "he", "she", "they", "we", "my", "his", "this", "that", "for", "with", "be", "so",
             "at", "me", "just", "its", "it's", "im", "i'm", "do", "not", "no", "yes", "but", "have", "has"}
CLIP_CALL = re.compile(r"\bclip(?:\s*(?:it|that|this))?\b|\bclipped\b", re.I)
_WORD_RES = {cat: [re.compile(p, re.I) for p in pats] for cat, pats in WORDS.items()}

# chat category -> suggested moment type (the playbook's taxonomy)
CATEGORY_TO_MOMENT = {"funny": "FUNNY", "hype": "HYPE", "play": "PLAY", "fail": "FAIL",
                      "rage": "RAGE", "shock": "REACTION", "wholesome": "WHOLESOME"}


def classify_message(text: str) -> set[str]:
    """Categories one chat message votes for (each category at most once)."""
    cats: set[str] = set()
    tokens = text.split()
    for cat, emotes in EMOTES.items():
        if any(tok in emotes for tok in tokens):
            cats.add(cat)
    for cat, res in _WORD_RES.items():
        if cat not in cats and any(r.search(text) for r in res):
            cats.add(cat)
    return cats


def chat_profile(messages: list[dict], spike_t: float, before: float = 5.0, after: float = 25.0,
                 bin_seconds: float = 2.0) -> dict:
    """What chat says in the reaction window [spike-before, spike+after] (clip seconds)."""
    window = [m for m in messages if spike_t - before <= float(m.get("clip_t", -1e9)) <= spike_t + after]
    votes: Counter[str] = Counter()
    tokens: Counter[str] = Counter()
    clip_calls = 0
    for m in window:
        text = str(m.get("text", ""))
        for c in classify_message(text):
            votes[c] += 1
        if CLIP_CALL.search(text):
            clip_calls += 1
        for tok in set(text.split()):
            if tok.startswith("@") or tok.lower() in STOPWORDS:
                continue
            if len(tok) > 1 or tok in ("W", "L", "F"):
                tokens[tok] += 1
    n = len(window)
    shares = {c: round(votes[c] / n, 3) for c in CATEGORIES} if n else {c: 0.0 for c in CATEGORIES}
    ranked = sorted(((s, c) for c, s in shares.items() if s > 0), reverse=True)
    dominant = ranked[0][1] if ranked and ranked[0][0] >= 0.15 else None
    rate = Counter(int((float(m["clip_t"]) - (spike_t - before)) // bin_seconds) for m in window)
    nbins = int(math.ceil((before + after) / bin_seconds))
    return {
        "window_s": [round(spike_t - before, 2), round(spike_t + after, 2)],
        "messages": n,
        "category_share": shares,
        "dominant": dominant,
        "suggested_moment": CATEGORY_TO_MOMENT.get(dominant) if dominant else None,
        "clip_calls": clip_calls,
        "top_tokens": [t for t, _ in tokens.most_common(12)],
        "rate_per_bin": [rate.get(i, 0) for i in range(nbins)],
        "bin_seconds": bin_seconds,
    }


# ---------------------------------------------------------------- audio
_EBUR_LINE = re.compile(r"\bt:\s*([\d.]+)\s+TARGET:.*?\bM:\s*(-?[\d.]+|-inf)")
_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*(-?[\d.]+)")
_PTS_TIME = re.compile(r"pts_time:\s*([\d.]+)")


def parse_ebur128(text: str) -> list[tuple[float, float]]:
    """(t, momentary LUFS) pairs from ffmpeg's ebur128 log (one line per 100 ms)."""
    out = []
    for m in _EBUR_LINE.finditer(text):
        val = m.group(2)
        out.append((float(m.group(1)), -120.0 if val == "-inf" else max(-120.0, float(val))))
    return out


def parse_silences(text: str, total: float | None = None) -> list[tuple[float, float]]:
    out, start = [], None
    for line in text.splitlines():
        if (m := _SIL_START.search(line)):
            start = max(0.0, float(m.group(1)))
        elif (m := _SIL_END.search(line)) and start is not None:
            out.append((round(start, 2), round(float(m.group(1)), 2)))
            start = None
    if start is not None and total is not None:
        out.append((round(start, 2), round(total, 2)))
    return out


def audio_scan(ffmpeg: str, path: Path, start: float | None = None, dur: float | None = None,
               silence_db: float = -38.0, silence_min: float = 0.35,
               timeout: float = 900) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """One decode pass: momentary loudness series + silences. Times are relative to `start`."""
    cmd = [ffmpeg, "-hide_banner", "-nostdin"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    if dur:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-i", str(path), "-vn", "-sn", "-af",
            f"ebur128,silencedetect=noise={silence_db}dB:d={silence_min}", "-f", "null", "-"]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout)
    if proc.returncode != 0:
        raise media.MediaError(f"audio scan failed for {path}: {(proc.stderr or '')[-800:]}")
    series = parse_ebur128(proc.stderr)
    total = series[-1][0] if series else None
    return series, parse_silences(proc.stderr, total)


def downsample(series: list[tuple[float, float]], step: float = 0.5) -> list[tuple[float, float]]:
    """Max loudness per `step` seconds (peaks matter more than averages here)."""
    buckets: dict[int, float] = {}
    for t, v in series:
        k = int(t // step)
        buckets[k] = max(buckets.get(k, -120.0), v)
    return [(round(k * step, 2), round(v, 1)) for k, v in sorted(buckets.items())]


def loud_peaks(series: list[tuple[float, float]], rise_lu: float = 8.0, floor_lufs: float = -30.0,
               merge_s: float = 1.5, limit: int = 8) -> tuple[float, list[dict]]:
    """Peaks at least `rise_lu` above the clip's median loudness. Returns (median, peaks)."""
    audible = [v for _, v in series if v > -70]
    if not audible:
        return -120.0, []
    med = statistics.median(audible)
    cand = [(t, v) for t, v in series if v >= med + rise_lu and v >= floor_lufs]
    peaks: list[dict] = []
    for t, v in cand:
        if peaks and t - peaks[-1]["end"] <= merge_s:
            p = peaks[-1]
            p["end"] = t
            if v > p["lufs"]:
                p["t"], p["lufs"] = t, v
        else:
            peaks.append({"t": t, "start": t, "end": t, "lufs": v})
    for p in peaks:
        p["rise_lu"] = round(p["lufs"] - med, 1)
        p["duration_s"] = round(p["end"] - p["start"] + 0.5, 2)
        for k in ("t", "start", "end", "lufs"):
            p[k] = round(p[k], 2)
    peaks.sort(key=lambda p: p["rise_lu"], reverse=True)
    return round(med, 1), peaks[:limit]


# ---------------------------------------------------------------- picture
def scene_changes(ffmpeg: str, path: Path, threshold: float = 0.32, timeout: float = 900) -> list[float]:
    """Times (s) of hard visual changes: cuts, killcams, death/menus screens, big flashes."""
    vf = f"scale=320:-2,setpts=PTS-STARTPTS,select='gt(scene\\,{threshold})',showinfo"
    proc = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(path), "-an", "-sn",
                           "-vf", vf, "-f", "null", "-"], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)
    if proc.returncode != 0:
        raise media.MediaError(f"scene scan failed for {path}: {(proc.stderr or '')[-800:]}")
    return [round(float(m.group(1)), 2) for line in proc.stderr.splitlines()
            if "Parsed_showinfo" in line and (m := _PTS_TIME.search(line))]


# ---------------------------------------------------------------- combine
def moment_guess(spike_t: float, peaks: list[dict], lookback: float = 20.0, lookahead: float = 4.0) -> dict:
    """Best guess at when the moment itself happened. Chat reacts 2-10 s late, so look
    for the strongest loud peak shortly *before* the spike; else assume ~4 s before it."""
    near = [p for p in peaks if spike_t - lookback <= p["t"] <= spike_t + lookahead]
    if near:
        best = max(near, key=lambda p: p["rise_lu"] - 0.15 * abs(spike_t - 4 - p["t"]))
        return {"t": best["t"], "basis": "loudest audio peak before the chat spike",
                "rise_lu": best["rise_lu"]}
    return {"t": round(max(0.0, spike_t - 4.0), 2), "basis": "no audio peak; chat-lag estimate"}


def triage_score(chat_stats: dict, profile: dict, peaks: list[dict], guess: dict) -> dict:
    """0-100 heuristic: how strong do the signals say this moment is? A hint, not a verdict."""
    ratio = float(chat_stats.get("peak_ratio") or chat_stats.get("first_ratio") or 0)
    chat = min(1.0, math.log2(ratio) / 3) if ratio > 1 else 0.0          # 3x -> 0.53, 8x -> 1.0
    rise = float(guess.get("rise_lu") or 0)
    audio = min(1.0, rise / 15.0)
    shares = profile.get("category_share") or {}
    reaction = min(1.0, 2 * max(shares.values(), default=0))
    calls = min(1.0, profile.get("clip_calls", 0) / 3)
    parts = {"chat_spike": round(chat, 2), "audio_peak": round(audio, 2),
             "chat_reaction": round(reaction, 2), "clip_calls": round(calls, 2)}
    score = 100 * (0.40 * chat + 0.30 * audio + 0.20 * reaction + 0.10 * calls)
    return {"score": round(score), "parts": parts,
            "weights": {"chat_spike": 0.40, "audio_peak": 0.30, "chat_reaction": 0.20, "clip_calls": 0.10}}


def analyze(ffmpeg: str, clip: Path, chat_messages: list[dict], spike_t: float, peak_t: float,
            chat_stats: dict | None = None, scenes: bool = True) -> dict:
    """Compute signals.json for a raw clip (read-only)."""
    series, silences = audio_scan(ffmpeg, clip)
    curve = downsample(series, 0.5)
    median, peaks = loud_peaks(curve)
    profile = chat_profile(chat_messages, spike_t)
    guess = moment_guess(spike_t, peaks)
    out = {
        "version": VERSION,
        "spike_in_clip_s": round(spike_t, 2),
        "peak_in_clip_s": round(peak_t, 2),
        "moment_guess": guess,
        "suggested_moment": profile["suggested_moment"],
        "triage": triage_score(chat_stats or {}, profile, peaks, guess),
        "chat": profile,
        "audio": {"median_lufs": median, "peaks": peaks, "silences": silences,
                  "loudness_curve_step_s": 0.5, "loudness_curve": [v for _, v in curve]},
        "scene_changes": [],
        "note": "Heuristic signals. Chat lags the moment by 2-10 s; audio peaks are often the moment "
                "itself (a scream, a gunshot burst, an explosion). Confirm everything from the frames.",
    }
    if scenes:
        try:
            out["scene_changes"] = scene_changes(ffmpeg, clip)
        except media.MediaError as e:
            out["scene_changes_error"] = str(e)[:300]
    return out


def summary_lines(sig: dict) -> list[str]:
    """Short human/LLM-readable digest for EDIT_JOB.md."""
    g, c, a = sig.get("moment_guess", {}), sig.get("chat", {}), sig.get("audio", {})
    shares = ", ".join(f"{k} {v:.0%}" for k, v in sorted((c.get("category_share") or {}).items(),
                                                         key=lambda kv: -kv[1]) if v > 0) or "none"
    peaks = ", ".join(f"{p['t']:.1f}s (+{p['rise_lu']} LU)" for p in (a.get("peaks") or [])[:5]) or "none"
    cuts = sig.get("scene_changes") or []
    return [
        f"- Triage score: **{sig.get('triage', {}).get('score', '?')}/100** "
        f"(parts: {sig.get('triage', {}).get('parts')}) - a hint, not a verdict",
        f"- Moment guess: **{g.get('t', '?')}s** ({g.get('basis', '')})",
        f"- Chat says: {shares}; dominant: {c.get('dominant') or '-'} -> suggested type "
        f"{sig.get('suggested_moment') or '-'}; 'clip it' calls: {c.get('clip_calls', 0)}; "
        f"top tokens: {' '.join(c.get('top_tokens', [])[:8])}",
        f"- Loud audio peaks (clip median {a.get('median_lufs')} LUFS): {peaks}",
        f"- Scene changes: {', '.join(f'{t:.1f}' for t in cuts[:20]) or 'none'}"
        + (" ..." if len(cuts) > 20 else ""),
    ]
