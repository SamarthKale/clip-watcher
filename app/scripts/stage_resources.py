"""Stage everything the installed Spikecut ships besides the Electron app itself, into app/release-res/.

    python app/scripts/stage_resources.py

  python/     Python's embeddable runtime (the same 3.13.x as the Python running this script),
              with streamlink installed into it
  pipeline/   the clipwatcher package as compiled .pyc only, its dashboard files, the edit skill pack,
              the CC0 sound library and config.example.toml
  tools/      ffmpeg + ffprobe, whisper-cli + its DLLs, yt-dlp (copied from the repo's tools/ folder)
  models/     the small English speech model
  node/       node.exe for the upload server: this machine's Node, whose ABI matches the ready-made
              better-sqlite3 build in app/node_modules (there is none for Electron's ABI)
  LICENSES/   what each bundled program is, its license and where its source is

Downloads (official sources only): the embeddable runtime from python.org, streamlink from PyPI.
Both are cached in app/build-cache/. Standard library only.
"""
from __future__ import annotations

import compileall
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
APP = REPO / "app"
OUT = APP / "release-res"
CACHE = APP / "build-cache"
PYVER = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
PYTAG = f"python{sys.version_info.major}{sys.version_info.minor}"
MODEL = "ggml-base.en.bin"

# Relative to the staging folder; checked by verify().
REQUIRED = [
    "python/python.exe",
    f"python/{PYTAG}._pth",
    "pipeline/clipwatcher/__main__.pyc",
    "pipeline/clipwatcher/cli.pyc",
    "pipeline/clipwatcher/editkit.pyc",
    "pipeline/clipwatcher/ui_static/index.html",
    "pipeline/.claude/skills/edit-short/SKILL.md",
    "pipeline/assets/library.json",
    "pipeline/config.example.toml",
    "tools/ffmpeg/ffmpeg.exe",
    "tools/ffmpeg/ffprobe.exe",
    "tools/whisper/whisper-cli.exe",
    "tools/yt-dlp/yt-dlp.exe",
    "node/node.exe",
    f"models/{MODEL}",
    "LICENSES/NOTICES.txt",
]


def log(msg: str) -> None:
    print(f"[stage] {msg}", flush=True)


def download(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.replace(dest)
    return dest


def stage_python() -> None:
    zip_path = download(f"https://www.python.org/ftp/python/{PYVER}/python-{PYVER}-embed-amd64.zip",
                        CACHE / f"python-{PYVER}-embed-amd64.zip")
    target = OUT / "python"
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(target)
    # The ._pth file fixes sys.path (it also makes Python ignore PYTHONPATH/PYTHONHOME from the
    # user's machine): the stdlib zip, the pipeline next door, and the installed packages.
    (target / f"{PYTAG}._pth").write_text(
        f"{PYTAG}.zip\n.\n..\\pipeline\nLib\\site-packages\nimport site\n", encoding="utf-8")
    site = target / "Lib" / "site-packages"
    log("installing streamlink into the bundled Python")
    subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--quiet",
                    "--target", str(site), "--only-binary=:all:", "--platform", "win_amd64",
                    "--python-version", f"{sys.version_info.major}.{sys.version_info.minor}",
                    "--implementation", "cp", "--cache-dir", str(CACHE / "pip"), "streamlink"], check=True)
    shutil.rmtree(site / "bin", ignore_errors=True)  # launchers that point at this machine's Python


def stage_pipeline() -> None:
    dest = OUT / "pipeline"
    shutil.copytree(REPO / "clipwatcher", dest / "clipwatcher",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    # legacy=True writes x.pyc next to x.py, which Python imports when x.py is absent.
    if not compileall.compile_dir(str(dest / "clipwatcher"), legacy=True, quiet=1):
        raise SystemExit("compiling the pipeline failed")
    for py in (dest / "clipwatcher").rglob("*.py"):
        py.unlink()
    shutil.copytree(REPO / ".claude" / "skills" / "edit-short", dest / ".claude" / "skills" / "edit-short")
    (dest / "assets").mkdir(parents=True)
    for sub in ("music", "sfx"):
        shutil.copytree(REPO / "assets" / sub, dest / "assets" / sub)
    shutil.copy2(REPO / "assets" / "library.json", dest / "assets" / "library.json")
    shutil.copy2(REPO / "config.example.toml", dest / "config.example.toml")


def stage_tools() -> None:
    src = REPO / "tools"
    (OUT / "tools" / "ffmpeg").mkdir(parents=True)
    for exe in ("ffmpeg.exe", "ffprobe.exe"):
        shutil.copy2(src / "ffmpeg" / exe, OUT / "tools" / "ffmpeg" / exe)
    (OUT / "tools" / "whisper").mkdir(parents=True)
    for f in (src / "whisper").iterdir():
        if f.name == "whisper-cli.exe" or f.suffix.lower() == ".dll":
            shutil.copy2(f, OUT / "tools" / "whisper" / f.name)
    (OUT / "tools" / "yt-dlp").mkdir(parents=True)
    shutil.copy2(src / "yt-dlp" / "yt-dlp.exe", OUT / "tools" / "yt-dlp" / "yt-dlp.exe")
    node = shutil.which("node")
    if not node:
        raise SystemExit("node was not found; the upload server ships with this machine's Node")
    (OUT / "node").mkdir(parents=True)
    shutil.copy2(node, OUT / "node" / "node.exe")
    (OUT / "models").mkdir(parents=True)
    shutil.copy2(REPO / "models" / MODEL, OUT / "models" / MODEL)


def stage_licenses() -> None:
    dest = OUT / "LICENSES"
    dest.mkdir(parents=True)
    ff = subprocess.run([str(OUT / "tools" / "ffmpeg" / "ffmpeg.exe"), "-hide_banner", "-version"],
                        capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    ff_license = subprocess.run([str(OUT / "tools" / "ffmpeg" / "ffmpeg.exe"), "-hide_banner", "-L"],
                                capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    first = ff.splitlines()[0] if ff else "ffmpeg"
    commit = next((part.split("-g")[1].split("-")[0] for part in first.split() if "-g" in part), "")
    notices = f"""Spikecut bundles these programs. Each keeps its own license; Spikecut runs them as separate
programs and does not modify them.

FFmpeg (ffmpeg.exe, ffprobe.exe)
  {first}
  License: GNU General Public License version 3 or later (this build includes GPL components).
  Source: https://git.ffmpeg.org/ffmpeg.git{f' (commit {commit})' if commit else ''}
  Windows build scripts: https://github.com/BtbN/FFmpeg-Builds
{''.join('  ' + line + chr(10) for line in ff_license.strip().splitlines())}
whisper.cpp (whisper-cli.exe and its DLLs) and the ggml speech model
  License: MIT. Source: https://github.com/ggml-org/whisper.cpp

Node.js (node/node.exe)
  License: MIT. Source: https://github.com/nodejs/node

yt-dlp (yt-dlp.exe)
  License: The Unlicense (public domain). Source: https://github.com/yt-dlp/yt-dlp

Python {PYVER} (python/)
  License: Python Software Foundation License, see python/LICENSE.txt. Source: https://www.python.org

streamlink and the packages it needs (python/Lib/site-packages/)
  Licenses: in each package's *.dist-info folder (streamlink: BSD 2-Clause).
  Source: https://github.com/streamlink/streamlink

Sound library (pipeline/assets/)
  CC0: original sounds made for this project.
"""
    (dest / "NOTICES.txt").write_text(notices, encoding="utf-8")


def verify(stage: Path, run: bool = True) -> list[str]:
    """Problems with a staged tree: missing required files, any .py source in the pipeline, and
    (run=True) the bundled Python failing to start the pipeline or streamlink."""
    problems = [f"missing: {rel}" for rel in REQUIRED if not (stage / rel).exists()]
    problems += [f"source file shipped: {p.relative_to(stage).as_posix()}"
                 for p in sorted((stage / "pipeline").rglob("*.py"))]
    if run and not problems:
        env = {**os.environ, "PYTHONHOME": r"C:\nowhere", "PYTHONPATH": r"C:\nowhere",
               "PYTHONDONTWRITEBYTECODE": "1"}
        py = str(stage / "python" / "python.exe")
        for args in (["-m", "clipwatcher", "--help"], ["-m", "streamlink", "--version"],
                     ["-c", "import sqlite3, ssl, tomllib, clipwatcher.editkit"]):
            r = subprocess.run([py, *args], env=env, cwd=str(stage.parent), capture_output=True, text=True,
                               encoding="utf-8", errors="replace")
            if r.returncode:
                problems.append(f"bundled python {' '.join(args)} failed: {(r.stderr or r.stdout).strip()[-300:]}")
        r = subprocess.run([str(stage / "node" / "node.exe"), "-e",
                            "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"],
                           cwd=str(APP), capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode:
            problems.append(f"bundled node cannot load better-sqlite3: {r.stderr.strip()[-300:]}")
        if list((stage / "pipeline").rglob("__pycache__")):
            problems.append("the bundled Python wrote __pycache__ into the pipeline")
    return problems


def main() -> int:
    if os.name != "nt":
        raise SystemExit("the Windows installer is staged on Windows")
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    stage_python()
    stage_pipeline()
    stage_tools()
    stage_licenses()
    problems = verify(OUT)
    if problems:
        print("\n".join(problems))
        return 1
    print("staged OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
