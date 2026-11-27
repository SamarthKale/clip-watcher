"""Editing helpers for Claude (and humans) building Shorts.

    python -m clipwatcher.editkit captions  --words words.json --segments 13.6-17.2,17.6-33 --out work/captions.ass
    python -m clipwatcher.editkit audiomix  --source clip.mp4 --segments 13.6-33 --music music/silly --sfx sfx/impact_boom@4.2 --out work/mix.wav
    python -m clipwatcher.editkit trimgraph --segments 13.6-17.2,17.6-33
    python -m clipwatcher.editkit inspect   short.mp4 --sheet work/inspect.jpg
    python -m clipwatcher.editkit library   [--type sfx|music] [--tag comedy]

Gaming / highlight tools:
    python -m clipwatcher.editkit signals   <raw clip>          # audio peaks, scene cuts, chat categories
    python -m clipwatcher.editkit timeline  --source clip.mp4 --from 30 --to 48 --out work/tl.jpg
    python -m clipwatcher.editkit grid      --source clip.mp4 --t 41 --out work/grid.jpg
    python -m clipwatcher.editkit reframe   --source clip.mp4 stack --cam 1460,40,420,236 [--inset ...] [--preview 41]
    python -m clipwatcher.editkit track     --source clip.mp4 --segments 30-48 [--mask X,Y,W,H]
    python -m clipwatcher.editkit snap      --words words.json --segments 30.1-47.8
    python -m clipwatcher.editkit thumbnail --source clip.mp4 --t 41.2 --text "1 HP *ACE*" --out thumbnail.jpg

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

from . import media, reframe, romanize, signals, thumbs
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


def apply_latin(words: list[dict], romanized_path: str | None = None) -> list[dict]:
    """Caption text for every word, always in Latin letters (Hinglish for Hindi speech).

    Order of preference: Claude's `romanized.json` (word index -> text, or a list), the word's own
    `latin` field from transcription, the word itself. Anything still in Devanagari is transliterated.
    """
    over: dict[int, str] = {}
    if romanized_path and Path(romanized_path).exists():
        raw = json.loads(Path(romanized_path).read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("words"), (dict, list)):
            raw = raw["words"]
        items = raw.items() if isinstance(raw, dict) else enumerate(raw)
        over = {int(k): str(v) for k, v in items if v not in (None, "")}
    out = []
    for i, w in enumerate(words):
        text = over.get(i) or w.get("latin") or w["w"]
        out.append({**w, "w": romanize.to_latin(text)})
    return out


def cmd_captions(a) -> None:
    data = json.loads(Path(a.words).read_text(encoding="utf-8"))
    words = apply_latin(data["words"] if isinstance(data, dict) else data, getattr(a, "romanized", None))
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
    # Order follows broadcast practice: noise reduction -> high-pass -> compression -> EQ -> gain.
    denoise = "afftdn=nf=-28:tn=1," if a.enhance else ""
    eq = ("equalizer=f=250:t=q:w=1.2:g=-2,equalizer=f=3500:t=q:w=1.4:g=2.5,"  # less mud, more presence
          if a.enhance else "")
    graph.append("".join(f"[v{k}]" for k in range(len(segs))) + f"concat=n={len(segs)}:v=0:a=1,"
                 f"{denoise}highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=150:makeup=2,"
                 f"{eq}volume={a.voice_gain}dB[voice]")
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
    if report.get("audio"):
        report["qa"] = media.qa_scan(ff, Path(a.file), report.get("duration", 0))
        report.update({k: report["qa"][k] for k in ("lufs", "true_peak_db", "lra") if k in report["qa"]})
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


# ---------------------------------------------------------------- gaming / highlight tools
def _tools():
    cfg = _cfg()
    return cfg, cfg["extract"]["ffmpeg"], cfg["extract"]["ffprobe"]


def _size(fp: str, src: str) -> tuple[int, int]:
    v = media.summarize(media.probe(fp, Path(src))).get("video") or {}
    if not v.get("width"):
        raise SystemExit(f"{src} has no video stream")
    return int(v["width"]), int(v["height"])


def cmd_signals(a) -> None:
    cfg, ff, fp = _tools()
    clip = Path(a.clip)
    existing = clip.parent / "signals.json"
    if existing.exists() and not a.recompute:
        sig = json.loads(existing.read_text(encoding="utf-8"))
    else:
        meta_p, chat_p = clip.parent / "metadata.json", clip.parent / "chat_context.json"
        meta = json.loads(meta_p.read_text(encoding="utf-8")) if meta_p.exists() else {}
        chat = json.loads(chat_p.read_text(encoding="utf-8")) if chat_p.exists() else {}
        sp = meta.get("spike", {})
        spike_t = a.spike if a.spike is not None else float(sp.get("spike_in_clip_s", 0))
        sig = signals.analyze(ff, clip, chat.get("messages", []), spike_t,
                              float(sp.get("peak_in_clip_s", spike_t)), sp.get("stats", {}))
        if a.out:  # never write next to the raw clip: inputs are read-only
            Path(a.out).parent.mkdir(parents=True, exist_ok=True)
            Path(a.out).write_text(json.dumps(sig, indent=2), encoding="utf-8")
    print("\n".join(signals.summary_lines(sig)))
    sil = sig.get("audio", {}).get("silences", [])
    print("- Silences (natural cut points): " + (", ".join(f"{s0:.1f}-{s1:.1f}" for s0, s1 in sil[:25]) or "none"))
    if a.json:
        print(json.dumps(sig, indent=2))


def cmd_timeline(a) -> None:
    """Filmstrip with timestamps over the waveform (the video-use 'timeline view')."""
    cfg, ff, fp = _tools()
    start, end, n = a.start, a.end, a.frames
    if end <= start:
        raise SystemExit("--to must be after --from")
    dur = end - start
    tw = max(80, a.width // n) // 2 * 2
    label = (f"drawtext=text='%{{pts\\:hms\\:{start:.3f}}}':fontsize={max(12, tw // 11)}:fontcolor=white:"
             f"box=1:boxcolor=black@0.65:boxborderw=3:x=4:y=4")
    graph = (f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS,fps={n}/{dur:.4f},"
             f"scale={tw}:-2,{label},tile={n}x1:padding=2:color=black[f];"
             f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS,"
             f"showwavespic=s={n * tw + 2 * (n - 1)}x{a.wave_height}:colors=0x4FC3F7[w];[f][w]vstack[out]")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    media.run([ff, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", a.source,
               "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-update", "1", a.out], timeout=300)
    times = [round(start + k * dur / n, 2) for k in range(n)]
    print(f"wrote {a.out}: {n} frames at {times} (raw-clip seconds), waveform below")


def cmd_grid(a) -> None:
    """A frame with a labelled pixel grid, for reading facecam / HUD rectangles."""
    cfg, ff, fp = _tools()
    sw, sh = _size(fp, a.source)
    step = a.step
    fs = max(14, sw // 70)
    parts = [f"drawgrid=w={step}:h={step}:t=2:c=yellow@0.55"]
    for x in range(0, sw, step * 2):
        parts.append(f"drawtext=text='{x}':x={x + 3}:y=3:fontsize={fs}:fontcolor=yellow:box=1:boxcolor=black@0.6")
    for y in range(step * 2, sh, step * 2):
        parts.append(f"drawtext=text='{y}':x=3:y={y + 3}:fontsize={fs}:fontcolor=yellow:box=1:boxcolor=black@0.6")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    media.run([ff, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", f"{a.t:.3f}", "-i", a.source,
               "-frames:v", "1", "-vf", ",".join(parts), "-q:v", "3", "-update", "1", a.out], timeout=120)
    print(f"wrote {a.out}: source is {sw}x{sh}; grid every {step}px, labels every {step * 2}px. "
          f"Rectangles are X,Y,W,H in these source pixels.")


def _layout_graph(a, sw: int, sh: int) -> str:
    if a.layout == "stack":
        g = reframe.stack(sw, sh, reframe.Rect.parse(a.cam),
                          reframe.Rect.parse(a.game) if a.game else None, a.split, a.game_cx)
    elif a.layout == "fullcam":
        g = reframe.fullcam(sw, sh, reframe.Rect.parse(a.cam))
    elif a.layout == "crop":
        x = a.x_expr or (float(a.x) if a.x is not None else None)
        g = reframe.crop(sw, sh, x=x, cx=a.cx, zoom=a.zoom)
    else:
        g = reframe.blurfill(sw, sh, zoom=a.zoom, cx=a.cx)
    return reframe.with_insets(g, [reframe.Inset.parse(i) for i in a.inset or []], sw, sh)


def cmd_reframe(a) -> None:
    cfg, ff, fp = _tools()
    sw, sh = _size(fp, a.source)
    if a.layout in ("stack", "fullcam") and not a.cam:
        raise SystemExit(f"{a.layout} needs --cam X,Y,W,H (read it off `editkit grid`)")
    try:
        graph = _layout_graph(a, sw, sh)
    except ValueError as e:
        raise SystemExit(str(e))
    print(graph)
    print(f"# reads [vcut] (from trimgraph), writes [vlay] 1080x1920; source {sw}x{sh}", file=sys.stderr)
    if a.cam:
        top = int(reframe.OUT_H * (a.split if a.layout == "stack" else 1.0))
        up = reframe.upscale(reframe.Rect.parse(a.cam), reframe.OUT_W, top)
        if up > 2.2:
            print(f"# WARNING: the facecam is enlarged {up:.1f}x and will look soft - use a smaller "
                  f"--split, keep it for short beats, or prefer the gameplay", file=sys.stderr)
    if a.preview is not None:
        out = a.preview_out or "work/reframe_preview.jpg"
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        pre = f"[0:v]trim=start={a.preview:.3f}:duration=0.5,setpts=PTS-STARTPTS[vcut];"
        media.run([ff, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", a.source,
                   "-filter_complex", pre + graph, "-map", "[vlay]", "-frames:v", "1", "-update", "1", out],
                  timeout=300)
        print(f"# preview frame at {a.preview}s -> {out}", file=sys.stderr)


def cmd_track(a) -> None:
    cfg, ff, fp = _tools()
    sw, sh = _size(fp, a.source)
    segs = parse_segments(a.segments)
    masks = [reframe.Rect.parse(m) for m in a.mask or []]
    res = reframe.track(ff, a.source, segs[0][0], segs[-1][1], sw, sh, masks, fps=a.fps, deadband=a.deadband)
    keys = []
    for t, c in res["keys"]:
        o = remap(t, segs)
        if o is not None:
            keys.append((round(o, 3), c))
    if not keys or keys[0][0] > 0:
        keys.insert(0, (0.0, keys[0][1] if keys else 0.5))
    keys = reframe.dedupe_keys(keys)
    win = reframe._fit_crop(sw, sh, reframe.OUT_W / reframe.OUT_H, zoom=a.zoom)
    expr = reframe.x_expression(keys, sw, win.w, ease=a.ease)
    out = {"keys_output_s": keys, "x_expr": expr, "window": [win.w, win.h], "source": [sw, sh],
           "samples": res["samples"]}
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"{len(keys)} framing keyframes (OUTPUT seconds, centre as fraction of width): {keys}")
    print(f'use: editkit reframe --source {a.source} crop --zoom {a.zoom} --x-expr "{expr}"')


def parse_speaker_keys(text: str) -> list[tuple[float, float]]:
    """"t:centre,..." (OUTPUT seconds, centre of the speaker as a fraction of the width) -> sorted keys."""
    keys = []
    for part in [p.strip() for p in (text or "").split(",") if p.strip()]:
        t, _, c = part.partition(":")
        try:
            keys.append((max(0.0, float(t)), max(0.0, min(1.0, float(c)))))
        except ValueError as e:
            raise ValueError(f"bad speaker key {part!r}: use t:centre, e.g. 6.5:0.72") from e
    if not keys:
        raise ValueError("no speaker keys given")
    keys.sort()
    keys[0] = (0.0, keys[0][1])
    return reframe.dedupe_keys(keys)


def cmd_speakerpath(a) -> None:
    if a.size:
        sw, sh = (int(v) for v in a.size.lower().split("x"))
    else:
        _, _, fp = _tools()
        sw, sh = _size(fp, a.source)
    keys = parse_speaker_keys(a.keys)
    win = reframe._fit_crop(sw, sh, reframe.OUT_W / reframe.OUT_H, zoom=a.zoom)
    expr = reframe.x_expression(keys, sw, win.w, ease=a.ease)
    print(f"{len(keys)} speaker keyframes (OUTPUT seconds, centre as fraction of width): {keys}")
    print(f'use: editkit reframe --source {a.source or "<raw clip>"} crop --zoom {a.zoom} --x-expr "{expr}"')


def snap_segments(segs, words, max_shift: float = 0.35, pad: float = 0.04) -> tuple[list, list[str]]:
    """Move segment edges off words: starts go to the start of the word they cut into,
    ends to the end of the word they cut into (within max_shift), never overlapping."""
    ws = sorted((float(w["start"]), float(w["end"])) for w in words)
    out, notes = [], []
    for s, e in segs:
        ns, ne = s, e
        for a0, a1 in ws:
            if a0 < s < a1:
                ns = a0 - pad if s - a0 <= max_shift else a1 + pad
                break
        for a0, a1 in ws:
            if a0 < e < a1:
                ne = a1 + pad if a1 - e <= max_shift else a0 - pad
                break
        if out and ns < out[-1][1]:
            ns = out[-1][1]
        ns, ne = round(max(0.0, ns), 3), round(ne, 3)
        if ne - ns < 0.2:
            ns, ne = s, e
        if (ns, ne) != (s, e):
            notes.append(f"{s:.2f}-{e:.2f} -> {ns:.2f}-{ne:.2f}")
        out.append((ns, ne))
    return out, notes


def cmd_snap(a) -> None:
    data = json.loads(Path(a.words).read_text(encoding="utf-8"))
    words = data["words"] if isinstance(data, dict) else data
    segs, notes = snap_segments(parse_segments(a.segments), words, a.max_shift)
    print(",".join(f"{s:.3f}-{e:.3f}" for s, e in segs))
    print("\n".join(notes) or "no edge was inside a word", file=sys.stderr)


def cmd_thumbnail(a) -> None:
    cfg, ff, fp = _tools()
    w, h = (int(v) for v in a.size.lower().split("x"))
    out = thumbs.render(ff, Path(a.source), a.t, Path(a.out), (w, h), a.text or "", a.accent, a.font,
                        a.font_size, a.position, a.crop)
    problems = thumbs.check(fp, out, (w, h))
    print(f"wrote {out} ({w}x{h})" + ("" if not problems else "  PROBLEMS: " + "; ".join(problems)))


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
    c.add_argument("--romanized", help="romanized.json: word index -> Latin (Hinglish) text; overrides transcription")
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
    m.add_argument("--enhance", action="store_true",
                   help="voice polish: light denoise, less 250 Hz mud, more 3.5 kHz presence")
    t = sub.add_parser("trimgraph", help="print an ffmpeg trim/concat graph for a keep-list")
    t.add_argument("--segments", required=True)
    i = sub.add_parser("inspect", help="verify a render: streams, decode errors, loudness, contact sheet")
    i.add_argument("file")
    i.add_argument("--sheet")
    i.add_argument("--frames", type=int, default=8)
    lb = sub.add_parser("library", help="list licensed sounds")
    lb.add_argument("--type", choices=("sfx", "music"))
    lb.add_argument("--tag")
    sg = sub.add_parser("signals", help="highlight signals for a raw clip (audio peaks, scene cuts, chat)")
    sg.add_argument("clip")
    sg.add_argument("--recompute", action="store_true")
    sg.add_argument("--spike", type=float, help="override the spike time (clip seconds)")
    sg.add_argument("--out", help="write signals.json here (e.g. work/signals.json)")
    sg.add_argument("--json", action="store_true")
    tl = sub.add_parser("timeline", help="filmstrip with timestamps + waveform for a time range")
    tl.add_argument("--source", required=True)
    tl.add_argument("--from", dest="start", type=float, required=True)
    tl.add_argument("--to", dest="end", type=float, required=True)
    tl.add_argument("--frames", type=int, default=8)
    tl.add_argument("--width", type=int, default=1920)
    tl.add_argument("--wave-height", type=int, default=140)
    tl.add_argument("--out", required=True)
    gr = sub.add_parser("grid", help="frame with a labelled pixel grid (read facecam/HUD rectangles)")
    gr.add_argument("--source", required=True)
    gr.add_argument("--t", type=float, required=True)
    gr.add_argument("--step", type=int, default=80)
    gr.add_argument("--out", required=True)
    rf = sub.add_parser("reframe", help="9:16 layout graph ([vcut] -> [vlay]): stack, fullcam, crop, blurfill")
    rf.add_argument("--source", required=True)
    rf.add_argument("layout", choices=("stack", "fullcam", "crop", "blurfill"))
    rf.add_argument("--cam", help="facecam rectangle X,Y,W,H (source px)")
    rf.add_argument("--game", help="gameplay rectangle for stack (default: centred crop that fills)")
    rf.add_argument("--split", type=float, default=0.42, help="stack: facecam share of the height")
    rf.add_argument("--game-cx", type=float, default=0.5, help="stack: gameplay centre (fraction of width)")
    rf.add_argument("--cx", type=float, default=0.5, help="crop/blurfill: centre (fraction of width)")
    rf.add_argument("--x", type=float, help="crop: left edge in source px")
    rf.add_argument("--x-expr", help="crop: left edge as an expression in t (from `track`)")
    rf.add_argument("--zoom", type=float, default=1.0)
    rf.add_argument("--inset", action="append",
                    help="HUD inset X,Y,W,H@PX,PY,WIDTH, e.g. the kill feed (repeatable)")
    rf.add_argument("--preview", type=float, help="render one frame at this raw-clip time")
    rf.add_argument("--preview-out")
    tr = sub.add_parser("track", help="follow on-screen action -> crop-X expression")
    tr.add_argument("--source", required=True)
    tr.add_argument("--segments", required=True)
    tr.add_argument("--mask", action="append", help="ignore motion here: facecam, chat box, HUD (X,Y,W,H)")
    tr.add_argument("--zoom", type=float, default=1.0)
    tr.add_argument("--fps", type=float, default=4.0)
    tr.add_argument("--deadband", type=float, default=0.08, help="ignore moves smaller than this (fraction)")
    tr.add_argument("--ease", type=float, default=0.4, help="seconds per move; 0 = hard cuts")
    tr.add_argument("--out")
    sp = sub.add_parser("speakerpath", help="speaker turns -> crop-X expression (follow whoever is talking)")
    sp.add_argument("--source", help="raw clip (for its size); or give --size")
    sp.add_argument("--size", help="source size WxH, e.g. 1920x1080")
    sp.add_argument("--keys", required=True, help="t:centre,... in OUTPUT seconds, e.g. 0:0.3,6.5:0.72")
    sp.add_argument("--zoom", type=float, default=1.0)
    sp.add_argument("--ease", type=float, default=0.25, help="seconds per move; 0 = hard cuts")
    sn = sub.add_parser("snap", help="snap keep-list edges to word boundaries")
    sn.add_argument("--words", required=True)
    sn.add_argument("--segments", required=True)
    sn.add_argument("--max-shift", type=float, default=0.35)
    th = sub.add_parser("thumbnail", help="thumbnail / cover image from one frame, with big text")
    th.add_argument("--source", required=True)
    th.add_argument("--t", type=float, required=True)
    th.add_argument("--out", required=True)
    th.add_argument("--text", help="<= 4 words; *word* = accent colour")
    th.add_argument("--size", default="1280x720", help="1280x720 thumbnail or 1080x1920 cover")
    th.add_argument("--accent", default="#FFD400")
    th.add_argument("--font", default="Arial Black")
    th.add_argument("--font-size", type=int)
    th.add_argument("--position", choices=("top", "bottom", "center"), default="top")
    th.add_argument("--crop", help="crop this source rectangle X,Y,W,H first (e.g. the facecam)")
    a = ap.parse_args(argv)
    {"captions": cmd_captions, "audiomix": cmd_audiomix, "trimgraph": cmd_trimgraph,
     "inspect": cmd_inspect, "library": cmd_library, "signals": cmd_signals, "timeline": cmd_timeline,
     "grid": cmd_grid, "reframe": cmd_reframe, "track": cmd_track, "speakerpath": cmd_speakerpath, "snap": cmd_snap,
     "thumbnail": cmd_thumbnail}[a.cmd](a)


if __name__ == "__main__":
    main()
