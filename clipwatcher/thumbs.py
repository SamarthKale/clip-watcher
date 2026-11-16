"""Thumbnails and covers: one strong frame, colour pop, a few huge words.

  thumbnail.jpg  1280x720  (YouTube thumbnail, also fine for a landscape upload)
  cover.jpg      1080x1920 (Shorts / Reels / TikTok cover frame)

Text is drawn with libass (fonts resolve by name, no font paths), so it renders
the same everywhere the captions do. Wrap words in *stars* to colour them with
the accent: "1 HP *ACE*".

Rules (from what works on gaming channels): <= 4 words, readable at phone-feed
size, the face or the action fills the frame, never cover the face with text,
and the text must not just repeat the title.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import media


def _ass_color(hex_rgb: str) -> str:
    h = hex_rgb.lstrip("#")
    return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}".upper()


def _ass_text(text: str, accent: str) -> str:
    """'1 HP *ACE*' -> ASS with the starred words in the accent colour."""
    safe = text.replace("{", "(").replace("}", ")").replace("\\", "/")
    return re.sub(r"\*(.+?)\*", lambda m: f"{{\\c{_ass_color(accent)}}}{m.group(1)}{{\\c&H00FFFFFF&}}",
                  safe).replace("\n", "\\N")


def _ass(w: int, h: int, text: str, accent: str, font: str, size: int, position: str) -> str:
    vertical = h > w  # keep clear of the Shorts/Reels/TikTok UI: top ~10%, bottom ~22%
    align, margin_v = {"top": (8, int(h * (0.11 if vertical else 0.06))),
                       "bottom": (2, int(h * (0.24 if vertical else 0.08))),
                       "center": (5, 0)}[position]
    return "\n".join([
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 1",
        "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: T,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&HAA000000,0,0,0,0,100,100,1,0,1,"
        f"{max(4, size // 11)},{max(2, size // 30)},{align},{int(w * 0.05)},{int(w * 0.05)},{margin_v},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        f"Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{_ass_text(text.upper(), accent)}", "",
    ])


def render(ffmpeg: str, src: Path, t: float, out: Path, size: tuple[int, int] = (1280, 720),
           text: str = "", accent: str = "#FFD400", font: str = "Arial Black", font_size: int | None = None,
           position: str = "top", crop: str | None = None, pop: bool = True) -> Path:
    """Frame at `t` of `src` -> JPEG of `size`, cover-cropped (optionally from a source
    rectangle 'X,Y,W,H' first), with colour pop and optional text."""
    w, h = size
    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = []
    if crop:
        x, y, cw, ch = (int(float(v)) for v in crop.split(","))
        vf.append(f"crop={cw}:{ch}:{x}:{y}")
    vf.append(f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},setsar=1")
    if pop:
        vf.append("eq=contrast=1.08:saturation=1.28:gamma=1.02,unsharp=5:5:0.7:5:5:0.0")
    with tempfile.TemporaryDirectory() as td:
        if text.strip():
            fs = font_size or int(h * (0.16 if w > h else 0.075))
            (Path(td) / "t.ass").write_text(_ass(w, h, text, accent, font, fs, position), encoding="utf-8")
            vf.append("subtitles=t.ass")  # relative path: no drive-letter escaping problems
        _run_in(td, [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                     "-ss", f"{max(0.0, t):.3f}", "-i", str(Path(src).resolve()), "-frames:v", "1",
                     "-vf", ",".join(vf), "-q:v", "2", "-update", "1", "tmp.jpg"])
        shutil.move(str(Path(td) / "tmp.jpg"), str(out))
    return out


def _run_in(cwd: str, cmd: list[str]) -> None:
    exe = Path(cmd[0])
    if not exe.is_absolute() and exe.exists():  # a relative tool path must survive the cwd change
        cmd = [str(exe.resolve())] + cmd[1:]
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=120)
    if proc.returncode != 0:
        raise media.MediaError(f"thumbnail render failed: {(proc.stderr or '')[-600:]}")


def check(ffprobe: str, path: Path, size: tuple[int, int]) -> list[str]:
    """Problems with an existing thumbnail/cover image (empty = fine)."""
    if not path.exists() or path.stat().st_size == 0:
        return [f"{path.name} is missing or empty"]
    try:
        info = media.probe(ffprobe, path)
    except media.MediaError as e:
        return [f"{path.name} is not a readable image: {e}"]
    s = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    if (s.get("width"), s.get("height")) != size:
        return [f"{path.name} is {s.get('width')}x{s.get('height')}, expected {size[0]}x{size[1]}"]
    if path.stat().st_size > 2_000_000 and size == (1280, 720):
        return [f"{path.name} is over 2 MB (YouTube's thumbnail limit)"]
    return []
