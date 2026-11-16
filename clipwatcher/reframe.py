"""9:16 reframing for gaming / livestream footage (16:9 in, 1080x1920 out).

Every layout returns an ffmpeg filtergraph fragment that reads one input label
(default [vcut], the output of `editkit trimgraph`) and writes [vlay]:

  stack     facecam on top, gameplay below - the default for streamer clips
  fullcam   facecam only, filling the frame - pure reaction beats
  crop      a 9:16 window on the gameplay; X can be a number or a tracked expression
  blurfill  the whole 16:9 frame over a blurred, zoomed copy of itself
  + insets  any layout can carry HUD insets: crop the kill feed / scoreboard /
            minimap / health bar from the source and pin it somewhere readable

Rectangles are source pixels "X,Y,W,H" - read them off `editkit grid`.

`track` follows on-screen action without any CV library: ffmpeg renders tiny
grayscale frames, Python finds where the motion is (columns of frame-difference
energy, with the facecam/HUD masked out), smooths it with a dead-band, and turns
it into a crop-X expression with eased moves (or hard cuts).
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass

OUT_W, OUT_H = 1080, 1920


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int

    @classmethod
    def parse(cls, spec: str) -> "Rect":
        try:
            x, y, w, h = (int(round(float(v))) for v in spec.replace(" ", "").split(","))
        except ValueError:
            raise ValueError(f"bad rectangle {spec!r}; use X,Y,W,H in source pixels") from None
        if w <= 0 or h <= 0 or x < 0 or y < 0:
            raise ValueError(f"bad rectangle {spec!r}: needs positive size inside the frame")
        return cls(x, y, w, h)

    def clamp(self, sw: int, sh: int) -> "Rect":
        x, y = min(self.x, sw - 2), min(self.y, sh - 2)
        w, h = min(self.w, sw - x), min(self.h, sh - y)
        return Rect(x, y, w - w % 2, h - h % 2)


@dataclass(frozen=True)
class Inset:
    src: Rect          # region of the source frame (kill feed, scoreboard...)
    x: int             # where its top-left goes on the 1080x1920 canvas
    y: int
    width: int         # displayed width (height keeps the aspect ratio)
    border: int = 4

    @classmethod
    def parse(cls, spec: str) -> "Inset":
        """'X,Y,W,H@PX,PY,WIDTH' e.g. kill feed 1500,80,400,160@560,250,500"""
        try:
            rect, place = spec.split("@")
            px, py, pw = (int(round(float(v))) for v in place.split(","))
        except ValueError:
            raise ValueError(f"bad inset {spec!r}; use X,Y,W,H@PX,PY,WIDTH") from None
        return cls(Rect.parse(rect), px, py, pw)


def _cover(w: int, h: int) -> str:
    """Scale to fill w x h exactly (crop the overflow, centred)."""
    return f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},setsar=1"


def _crop(r: Rect) -> str:
    return f"crop={r.w}:{r.h}:{r.x}:{r.y}"


def _fit_crop(sw: int, sh: int, aspect: float, cx: float = 0.5, cy: float = 0.5,
              zoom: float = 1.0) -> Rect:
    """Largest window of the given aspect (w/h) inside the source, centred on (cx, cy)
    as fractions of the frame, optionally zoomed in."""
    if sw / sh > aspect:
        h = sh / zoom
        w = h * aspect
    else:
        w = sw / zoom
        h = w / aspect
    x = min(max(0.0, cx * sw - w / 2), sw - w)
    y = min(max(0.0, cy * sh - h / 2), sh - h)
    return Rect(int(x) // 2 * 2, int(y) // 2 * 2, int(w) // 2 * 2, int(h) // 2 * 2)


def stack(sw: int, sh: int, cam: Rect, game: Rect | None = None, split: float = 0.42,
          game_cx: float = 0.5, inp: str = "vcut", out: str = "vlay") -> str:
    """Facecam on top (split = its share of the height), gameplay below."""
    if not 0.2 <= split <= 0.6:
        raise ValueError("split must be between 0.2 and 0.6")
    top = int(OUT_H * split) // 2 * 2
    bottom = OUT_H - top
    cam = cam.clamp(sw, sh)
    game = (game.clamp(sw, sh) if game else _fit_crop(sw, sh, OUT_W / bottom, cx=game_cx))
    return (f"[{inp}]split=2[_cam][_game];"
            f"[_cam]{_crop(cam)},{_cover(OUT_W, top)}[_top];"
            f"[_game]{_crop(game)},{_cover(OUT_W, bottom)}[_bot];"
            f"[_top][_bot]vstack=inputs=2[{out}]")


def fullcam(sw: int, sh: int, cam: Rect, inp: str = "vcut", out: str = "vlay") -> str:
    cam = cam.clamp(sw, sh)
    win = _fit_crop(cam.w, cam.h, OUT_W / OUT_H)
    r = Rect(cam.x + win.x, cam.y + win.y, win.w, win.h)
    return f"[{inp}]{_crop(r)},{_cover(OUT_W, OUT_H)}[{out}]"


def crop(sw: int, sh: int, x: float | str | None = None, cx: float = 0.5, zoom: float = 1.0,
         inp: str = "vcut", out: str = "vlay") -> str:
    """9:16 window. `x` = left edge in source px (number or ffmpeg expression in t);
    otherwise centred on `cx` (fraction of the width). zoom > 1 tightens the window."""
    win = _fit_crop(sw, sh, OUT_W / OUT_H, cx=cx, zoom=zoom)
    if x is None:
        xs = str(win.x)
    elif isinstance(x, str):
        xs = f"'max(0,min({sw - win.w},{x}))'"
    else:
        xs = str(int(max(0, min(sw - win.w, x))) // 2 * 2)
    y = (sh - win.h) // 2 // 2 * 2
    return f"[{inp}]crop={win.w}:{win.h}:{xs}:{y},{_cover(OUT_W, OUT_H)}[{out}]"


def blurfill(sw: int, sh: int, zoom: float = 1.0, cx: float = 0.5, inp: str = "vcut",
             out: str = "vlay") -> str:
    """Whole frame (or a zoomed centre of it) over a blurred copy. Keeps the full HUD readable."""
    fg = _fit_crop(sw, sh, sw / sh, cx=cx, zoom=zoom)
    return (f"[{inp}]split=2[_bg][_fg];"
            f"[_bg]{_cover(OUT_W, OUT_H)},boxblur=luma_radius=28:luma_power=2,eq=brightness=-0.10:saturation=1.1[_bgb];"
            f"[_fg]{_crop(fg)},scale={OUT_W}:-2:flags=lanczos,setsar=1[_fgs];"
            f"[_bgb][_fgs]overlay=(W-w)/2:(H-h)/2[{out}]")


def with_insets(graph: str, insets: list[Inset], sw: int, sh: int, inp: str = "vcut",
                out: str = "vlay") -> str:
    """Pin HUD regions (cropped from the source) on top of a layout graph."""
    if not insets:
        return graph
    n = len(insets)
    labels = "".join(f"[_i{k}]" for k in range(n))
    g = graph.replace(f"[{inp}]", "[_main]", 1).replace(f"[{out}]", "[_lay0]")
    parts = [f"[{inp}]split={n + 1}[_main]{labels}", g]
    for k, ins in enumerate(insets):
        r = ins.src.clamp(sw, sh)
        h = int(ins.width * r.h / r.w) // 2 * 2
        b = ins.border
        parts.append(f"[_i{k}]{_crop(r)},scale={ins.width}:{h}:flags=lanczos,setsar=1,"
                     f"pad={ins.width + 2 * b}:{h + 2 * b}:{b}:{b}:color=black@0.85[_p{k}]")
        nxt = out if k == n - 1 else f"_lay{k + 1}"
        parts.append(f"[_lay{k}][_p{k}]overlay={ins.x}:{ins.y}[{nxt}]")
    return ";".join(parts)


# ---------------------------------------------------------------- tracking
def motion_columns(frames: list[bytes], w: int, h: int, masks: list[tuple[int, int, int, int]]) -> list[list[float]]:
    """Per frame pair: motion energy per column (abs luma difference), masked regions ignored."""
    masked = [[False] * w for _ in range(h)]
    for (mx, my, mw, mh) in masks:
        for yy in range(max(0, my), min(h, my + mh)):
            row = masked[yy]
            for xx in range(max(0, mx), min(w, mx + mw)):
                row[xx] = True
    out = []
    for prev, cur in zip(frames, frames[1:]):
        cols = [0.0] * w
        for yy in range(h):
            base = yy * w
            row = masked[yy]
            for xx in range(w):
                if not row[xx]:
                    d = cur[base + xx] - prev[base + xx]
                    if d < 0:
                        d = -d
                    if d > 12:  # ignore compression noise
                        cols[xx] += d
        out.append(cols)
    return out


def centroids(cols_per_frame: list[list[float]], min_energy: float) -> list[float | None]:
    out: list[float | None] = []
    for cols in cols_per_frame:
        total = sum(cols)
        if total < min_energy:
            out.append(None)
            continue
        out.append(sum(i * c for i, c in enumerate(cols)) / total / max(1, len(cols) - 1))
    return out


def smooth_path(times: list[float], xs: list[float | None], deadband: float = 0.08,
                alpha: float = 0.35, min_hold: float = 1.0, start: float = 0.5) -> list[tuple[float, float]]:
    """Centre-x keyframes (fractions) that only move when the action really moves.

    EMA-smooth the raw centroid, then emit a new keyframe only when the smoothed
    value leaves a dead-band around the current one and the current one has been
    held for `min_hold` seconds. Calm framing beats twitchy framing.
    """
    keys: list[tuple[float, float]] = []
    cur = None
    ema = None
    last_t = -1e9
    for t, x in zip(times, xs):
        if x is None:
            continue
        ema = x if ema is None else ema + alpha * (x - ema)
        if cur is None:
            cur = start if abs(ema - start) <= deadband else ema
            keys.append((t, round(cur, 3)))
            last_t = t
        elif abs(ema - cur) > deadband and t - last_t >= min_hold:
            cur = ema
            keys.append((t, round(cur, 3)))
            last_t = t
    if not keys:
        keys = [(times[0] if times else 0.0, start)]
    return keys


def dedupe_keys(keys: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for t, c in keys:
        if not out or abs(out[-1][1] - c) > 1e-6:
            out.append((t, c))
    return out


def upscale(src: Rect, out_w: int, out_h: int) -> float:
    """How much a cover-scaled crop is enlarged (1.0 = native pixels)."""
    return max(out_w / src.w, out_h / src.h)


def x_expression(keys: list[tuple[float, float]], sw: int, win_w: int, ease: float = 0.4) -> str:
    """Keyframes (t, centre fraction) -> crop-X expression in t. Moves ease over `ease` s
    (0 = hard cuts, the clipify style). Commas are fine inside single quotes."""
    def left(c: float) -> int:
        return int(max(0, min(sw - win_w, c * sw - win_w / 2))) // 2 * 2
    expr = str(left(keys[-1][1]))
    for (t0, c0), (t1, c1) in reversed(list(zip(keys, keys[1:]))):
        a, b = left(c0), left(c1)
        if ease > 0 and a != b:
            move = f"{a}+({b - a})*min(1,max(0,(t-{t1:.3f})/{ease:.3f}))"
            expr = f"if(lt(t,{t1:.3f}),{a},if(lt(t,{t1 + ease:.3f}),{move},{expr}))"
        else:
            expr = f"if(lt(t,{t1:.3f}),{a},{expr})"
    return expr


def track(ffmpeg: str, src: str, start: float, end: float, sw: int, sh: int,
          masks: list[Rect] | None = None, fps: float = 4.0, small_w: int = 96,
          deadband: float = 0.08) -> dict:
    """Follow the action horizontally between start and end (raw-clip seconds)."""
    small_h = max(2, int(round(small_w * sh / sw / 2)) * 2)
    dur = max(0.5, end - start)
    proc = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                           "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", src, "-an",
                           "-vf", f"fps={fps},scale={small_w}:{small_h}:flags=area,format=gray",
                           "-f", "rawvideo", "-"], capture_output=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"tracking decode failed: {proc.stderr.decode(errors='replace')[-500:]}")
    size = small_w * small_h
    raw = proc.stdout
    frames = [raw[i:i + size] for i in range(0, len(raw) - size + 1, size)]
    sx, sy = small_w / sw, small_h / sh
    small_masks = [(int(m.x * sx), int(m.y * sy), int(m.w * sx) + 1, int(m.h * sy) + 1) for m in (masks or [])]
    cols = motion_columns(frames, small_w, small_h, small_masks)
    energies = sorted(sum(c) for c in cols)
    floor = energies[len(energies) // 4] if energies else 0.0  # ignore the calmest quarter
    xs = centroids(cols, max(floor, 200.0))
    times = [start + (i + 1) / fps for i in range(len(xs))]
    keys = smooth_path(times, xs, deadband=deadband)
    return {"keys": keys, "samples": len(xs), "fps": fps,
            "raw": [None if x is None else round(x, 3) for x in xs]}
