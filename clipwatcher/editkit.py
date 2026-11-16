"""Editing helpers for Claude (and humans) building Shorts.

    python -m clipwatcher.editkit captions  --words words.json --segments 13.6-17.2,17.6-33 --out work/captions.ass
    python -m clipwatcher.editkit audiomix  --source clip.mp4 --segments 13.6-33 --music music/silly --sfx sfx/impact_boom@4.2 --out work/mix.wav
    python -m clipwatcher.editkit trimgraph --segments 13.6-17.2,17.6-33
    python -m clipwatcher.editkit inspect   short.mp4 --sheet work/inspect.jpg
    python -m clipwatcher.editkit library   [--type sfx|music] [--tag comedy]

`--segments` is the keep-list in raw-clip seconds. Using the same list for the
video trim, the captions and the audio mix keeps all three in sync after jump cuts.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from . import media
from .config import load_config
from .soundlib import ASSETS_DIR, load_library, usable_items

# Words masked in captions (first letter kept). Slurs only; ordinary swearing is left alone.
CENSOR = {"nigger", "nigga", "faggot", "fag", "retard", "retarded", "tranny", "chink", "spic", "kike"}


def _cfg():
    path = os.environ.get("CLIPWATCHER_CONFIG") or ("config.toml" if Path("config.toml").exists() else None)
    return load_config(path)


def parse_segments(spec: str | None, total: float | None = None) -> list[tuple[float, float]]:
    if not spec:
        if total is None:
            raise SystemExit("--segments is required here")
        return [(0.0, total)]
    segs = []
    for part in spec.split(","):
        a, b = part.strip().split("-")
        a, b = float(a), float(b)
        if b <= a:
            raise SystemExit(f"bad segment {part!r}: end must be after start")
        segs.append((a, b))
    for (a1, b1), (a2, b2) in zip(segs, segs[1:]):
        if a2 < b1:
            raise SystemExit("segments must be in order and must not overlap")
    return segs


def remap(t: float, segs: list[tuple[float, float]]) -> float | None:
    """Raw-clip time -> output time (None if t falls in a removed part)."""
    acc = 0.0
    for a, b in segs:
        if a <= t < b:
            return acc + (t - a)
        acc += b - a
    return None


# ---------------------------------------------------------------- captions
def _ass_color(hex_rgb: str, alpha: int = 0) -> str:
    h = hex_rgb.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _t(sec: float) -> str:
    sec = max(0.0, sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def _clean(word: str, upper: bool, replacements: dict[str, str]) -> str:
    core = re.sub(r"[^\w'*-]", "", word).lower()
    if core in replacements:
        word = replacements[core]
    if core in CENSOR:
        word = word[0] + "*" * (len(core) - 1)
    word = word.replace("{", "(").replace("}", ")")
    if upper:
        word = word.upper()
    if not upper or word.endswith("..."):
        return word
    return re.sub(r"[.,;:]+$", "", word)  # drop trailing '.' ',' etc.; keep '?', '!' and '...'


def _core(word: str) -> str:
    return re.sub(r"[^\w']", "", word).lower()


def build_chunks(words: list[dict], segs, max_words: int, max_chars: int,
                 emphasis: set[str] = frozenset()) -> list[list[dict]]:
    out_words = []
    for w in words:
        s, e = remap(w["start"], segs), remap(max(w["start"], w["end"] - 1e-3), segs)
        if s is None:
            continue
        out_words.append({**w, "s": s, "e": e if e is not None else s + 0.2})
    chunks: list[list[dict]] = []
    cur: list[dict] = []
    for w in out_words:
        if cur:
            gap = w["s"] - cur[-1]["e"]
            chars = sum(len(x["w"]) + 1 for x in cur) + len(w["w"])
            # keep an emphasis phrase ("MASTER DEBATER") on one card
            phrase = _core(cur[-1]["w"]) in emphasis and _core(w["w"]) in emphasis
            full = (len(cur) >= max_words or chars > max_chars) and not (phrase and len(cur) <= max_words)
            if (full or gap > 0.35 or re.search(r"[.?!]$", cur[-1]["w"])
                    or (len(cur) >= 2 and cur[-1]["w"].endswith(","))):
                chunks.append(cur)
                cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


def cmd_captions(a) -> None:
    data = json.loads(Path(a.words).read_text(encoding="utf-8"))
    words = data["words"] if isinstance(data, dict) else data
    total = max((w["end"] for w in words), default=0) + 1
    segs = parse_segments(a.segments, total)
    replacements = {}
    for r in a.replace or []:
        k, _, v = r.partition("=")
        replacements[k.strip().lower()] = v.strip()
    emphasis = {e.strip().lower() for e in (a.emphasis or "").split(",") if e.strip()}
    chunks = build_chunks(words, segs, a.max_words, a.max_chars, emphasis)

    white, accent = _ass_color("#FFFFFF"), _ass_color(a.accent)
    lines = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920",
        "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Cap,{a.font},{a.size},{white},{white},&H00000000,&H96000000,0,0,0,0,100,100,1,0,1,"
        f"{a.outline},{a.shadow},5,60,60,0,1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    pos = f"\\pos(540,{a.y})"
    pop = "\\fscx72\\fscy72\\t(0,90,\\fscx108\\fscy108)\\t(90,150,\\fscx100\\fscy100)"
    report = []
    for ci, chunk in enumerate(chunks):
        start = chunk[0]["s"]
        end = chunk[-1]["e"]
        if ci + 1 < len(chunks) and chunks[ci + 1][0]["s"] - end < 0.3:
            end = chunks[ci + 1][0]["s"]
        end = max(end, start + 0.25)
        texts = [_clean(w["w"], not a.no_upper, replacements) for w in chunk]
        is_emph = [re.sub(r"[^\w']", "", w["w"]).lower() in emphasis for w in chunk]

        def render(active: int | None) -> str:
            parts = []
            for i, (txt, em) in enumerate(zip(texts, is_emph)):
                if em:
                    parts.append(f"{{\\c{accent}\\fscx115\\fscy115}}{txt}{{\\c{white}\\fscx100\\fscy100}}")
                elif active is not None and i == active:
                    parts.append(f"{{\\c{accent}}}{txt}{{\\c{white}}}")
                else:
                    parts.append(txt)
            return " ".join(parts)

        if a.style == "karaoke":
            for i, w in enumerate(chunk):
                ws = start if i == 0 else w["s"]
                we = chunk[i + 1]["s"] if i + 1 < len(chunk) else end
                anim = pop if i == 0 else ""
                lines.append(f"Dialogue: 0,{_t(ws)},{_t(max(we, ws + 0.05))},Cap,,0,0,0,,{{{pos}{anim}}}{render(i)}")
        else:
            anim = pop if a.style == "pop" else ""
            lines.append(f"Dialogue: 0,{_t(start)},{_t(end)},Cap,,0,0,0,,{{{pos}{anim}}}{render(None)}")
        report.append(f"{start:6.2f}-{end:6.2f}  {' '.join(texts)}")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {a.out}: {len(chunks)} caption groups (times are OUTPUT seconds)")
    print("\n".join(report))


# ---------------------------------------------------------------- audio mix
def _resolve_asset(ref: str, lib: dict) -> tuple[Path, dict]:
    items = {it["id"]: it for it in lib.get("items", [])}
    usable = {it["id"] for it in usable_items(lib)}
    key = ref if "/" in ref else next((i for i in items if i.split("/", 1)[1] == ref), ref)
    if key not in items:
        raise SystemExit(f"{ref!r} is not in assets/library.json - only licensed library audio may be used")
    if key not in usable:
        raise SystemExit(f"{key!r} has no known license in assets/library.json - fill it in first")
    return ASSETS_DIR / items[key]["file"], items[key]


def cmd_audiomix(a) -> None:
    cfg = _cfg()
    ff = cfg["extract"]["ffmpeg"]
    total = media.duration(cfg["extract"]["ffprobe"], Path(a.source))
    segs = parse_segments(a.segments, total)
    out_len = sum(b - s for s, b in segs)
    lib = load_library()
    inputs = ["-i", a.source]
    used = []
    graph = []
    for k, (s, b) in enumerate(segs):
        graph.append(f"[0:a]atrim=start={s:.3f}:end={b:.3f},asetpts=PTS-STARTPTS,"
                     f"afade=t=in:d=0.012,afade=t=out:st={max(0, b - s - 0.012):.3f}:d=0.012[v{k}]")
    graph.append("".join(f"[v{k}]" for k in range(len(segs))) + f"concat=n={len(segs)}:v=0:a=1,"
                 f"highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=150:makeup=2,"
                 f"volume={a.voice_gain}dB[voice]")
    mix_inputs = ["[vmain]"]
    idx = 1
    if a.music:
        path, item = _resolve_asset(a.music, lib)
        used.append(item)
        inputs += ["-stream_loop", "-1", "-i", str(path)]
        fade_out = min(1.5, out_len / 3)
        chain = (f"[{idx}:a]atrim=start={a.music_start:.3f}:duration={out_len:.3f},asetpts=PTS-STARTPTS,"
                 f"volume={a.music_gain}dB,afade=t=in:d=0.6,afade=t=out:st={out_len - fade_out:.3f}:d={fade_out:.3f}")
        for spec in a.music_mute or []:  # music drop-outs (OUTPUT seconds), e.g. right before a punchline
            ms_, me_ = (float(x) for x in spec.split("-"))
            chain += f",volume=enable='between(t,{ms_:.3f},{me_:.3f})':volume=0"
        if a.no_duck:
            graph.append("[voice]anull[vmain]")
            graph.append(chain + "[mus]")
        else:
            graph.append("[voice]asplit=2[vmain][vsc]")
            graph.append(chain + "[mraw]")
            graph.append("[mraw][vsc]sidechaincompress=threshold=0.012:ratio=8:attack=25:release=450[mus]")
        mix_inputs.append("[mus]")
        idx += 1
    else:
        graph.append("[voice]anull[vmain]")
    for k, spec in enumerate(a.sfx or []):
        m = re.match(r"^(.+?)@([\d.]+)(?::(-?[\d.]+))?$", spec)
        if not m:
            raise SystemExit(f"bad --sfx {spec!r}; use ID@SECONDS[:GAIN_DB]")
        path, item = _resolve_asset(m.group(1), lib)
        used.append(item)
        at, gain = float(m.group(2)), float(m.group(3) or a.sfx_gain)
        inputs += ["-i", str(path)]
        ms = int(at * 1000)
        graph.append(f"[{idx}:a]aformat=channel_layouts=stereo,volume={gain}dB,adelay={ms}|{ms}[s{k}]")
        mix_inputs.append(f"[s{k}]")
        idx += 1
    graph.append("".join(mix_inputs) + f"amix=inputs={len(mix_inputs)}:normalize=0:duration=first,"
                 f"loudnorm=I={a.target}:TP=-1.5:LRA=11,aresample=48000[out]")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *inputs,
           "-filter_complex", ";".join(graph), "-map", "[out]", "-t", f"{out_len:.3f}",
           "-c:a", "pcm_s16le", a.out]
    media.run(cmd, timeout=600)
    credits = sorted({it["credit"] for it in used if it.get("credit")})
    side = {"segments": segs, "duration": round(out_len, 3),
            "assets": [{"id": it["id"], "license": it["license"], "credit": it.get("credit", "")} for it in used],
            "credits": credits}
    Path(a.out + ".json").write_text(json.dumps(side, indent=2), encoding="utf-8")
    print(f"wrote {a.out} ({out_len:.2f}s, loudness target {a.target} LUFS)")
    print(f"assets: {[it['id'] for it in used]}")
    if credits:
        print("CREDITS REQUIRED in description.txt:\n  " + "\n  ".join(credits))


# ---------------------------------------------------------------- misc
def cmd_trimgraph(a) -> None:
    segs = parse_segments(a.segments)
    parts = [f"[0:v]trim=start={s:.3f}:end={b:.3f},setpts=PTS-STARTPTS[t{k}]" for k, (s, b) in enumerate(segs)]
    parts.append("".join(f"[t{k}]" for k in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=0[vcut]")
    print(";".join(parts))
    print(f"# output length {sum(b - s for s, b in segs):.3f}s; feed [vcut] into your layout graph", file=sys.stderr)


def cmd_inspect(a) -> None:
    cfg = _cfg()
    ff, fp = cfg["extract"]["ffmpeg"], cfg["extract"]["ffprobe"]
    report = media.verify_playable(ff, fp, Path(a.file), full_decode=True)
    report.update(media.loudness(ff, Path(a.file)) if report.get("audio") else {})
    if a.sheet:
        dur = report.get("duration", 0)
        n = a.frames
        times = [dur * (i + 0.5) / n for i in range(n)]
        sel = "+".join(f"lt(prev_pts*TB\\,{t:.3f})*gte(pts*TB\\,{t:.3f})" for t in times)
        Path(a.sheet).parent.mkdir(parents=True, exist_ok=True)
        media.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", a.file, "-vf",
                   f"select='{sel}',scale=270:-2,tile={n}x1", "-frames:v", "1", "-fps_mode", "vfr", a.sheet],
                  timeout=300)
        report["sheet"] = a.sheet
        report["sheet_times"] = [round(t, 2) for t in times]
    print(json.dumps(report, indent=2))


def cmd_library(a) -> None:
    for it in usable_items(load_library()):
        if a.type and it["type"] != a.type:
            continue
        if a.tag and a.tag not in it.get("tags", []):
            continue
        print(f"{it['id']:<24} {it.get('duration') or 0:6.2f}s  {','.join(it.get('tags', [])):<34} {it.get('use', '')}")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="clipwatcher.editkit")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("captions", help="animated ASS captions from words.json")
    c.add_argument("--words", required=True)
    c.add_argument("--segments", help="keep-list in raw-clip seconds, e.g. 13.6-17.2,17.6-33")
    c.add_argument("--out", required=True)
    c.add_argument("--style", choices=("pop", "karaoke", "clean"), default="karaoke")
    c.add_argument("--font", default="Arial Black")
    c.add_argument("--size", type=int, default=88)
    c.add_argument("--outline", type=float, default=7)
    c.add_argument("--shadow", type=float, default=3)
    c.add_argument("--y", type=int, default=1250, help="vertical centre of the caption line (0-1920)")
    c.add_argument("--accent", default="#FFD400", help="highlight colour for the active/emphasis word")
    c.add_argument("--emphasis", help="comma-separated words always shown in the accent colour, larger")
    c.add_argument("--replace", action="append", help="fix a transcription error: wrong=right (repeatable)")
    c.add_argument("--max-words", type=int, default=3)
    c.add_argument("--max-chars", type=int, default=18)
    c.add_argument("--no-upper", action="store_true")
    m = sub.add_parser("audiomix", help="voice + ducked music bed + timed SFX, loudness-normalised")
    m.add_argument("--source", required=True, help="raw clip (its audio track is the voice)")
    m.add_argument("--segments")
    m.add_argument("--out", required=True)
    m.add_argument("--music", help="library id, e.g. music/silly")
    m.add_argument("--music-gain", type=float, default=-14, help="dB applied to the bed before ducking")
    m.add_argument("--music-start", type=float, default=0.0, help="seconds into the track to start")
    m.add_argument("--no-duck", action="store_true")
    m.add_argument("--music-mute", action="append", help="silence the bed for OUTPUT seconds A-B (repeatable)")
    m.add_argument("--sfx", action="append", help="ID@OUTPUT_SECONDS[:GAIN_DB], e.g. sfx/impact_boom@4.2:-4")
    m.add_argument("--sfx-gain", type=float, default=-6)
    m.add_argument("--voice-gain", type=float, default=0)
    m.add_argument("--target", type=float, default=-14, help="integrated loudness, LUFS")
    t = sub.add_parser("trimgraph", help="print an ffmpeg trim/concat graph for a keep-list")
    t.add_argument("--segments", required=True)
    i = sub.add_parser("inspect", help="verify a render: streams, decode errors, loudness, contact sheet")
    i.add_argument("file")
    i.add_argument("--sheet")
    i.add_argument("--frames", type=int, default=8)
    lb = sub.add_parser("library", help="list licensed sounds")
    lb.add_argument("--type", choices=("sfx", "music"))
    lb.add_argument("--tag")
    a = ap.parse_args(argv)
    {"captions": cmd_captions, "audiomix": cmd_audiomix, "trimgraph": cmd_trimgraph,
     "inspect": cmd_inspect, "library": cmd_library}[a.cmd](a)


if __name__ == "__main__":
    main()
