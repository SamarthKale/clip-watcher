# Spikecut desktop release: design

**Intent.** Turn Spikecut from "run it from the repo" into a real Windows application that anyone can
download from a GitHub release, install with a normal installer and use straight away, with Claude
built into the experience.

**Decided with the owner**
- Release on this repo's GitHub Releases (`SamarthKale/clip-watcher`). GitHub's automatic source
  zips are fine ("release the code").
- The installer bundles everything Spikecut needs, and Claude should feel native.
- Inside the installed app: compiled only. No `.py` or `.ts` files ship; Python is shipped as `.pyc`, the
  server and UI as bundled, minified JavaScript. No obfuscation, no new runtime dependencies.
- Downloading build inputs from official sources is approved: Python's embeddable runtime
  (python.org), streamlink (PyPI) and electron-builder's NSIS tools (GitHub).

**Claude.** The Claude Code program cannot be put inside the installer: Anthropic does not license it
for repackaging, and every user must sign in with their own Claude account (never the owner's). So
Spikecut makes Claude a first-class part of setup instead: it detects Claude Code, and if it is missing,
a "Set up Claude" step (first-run tour and the setup check) installs it in one click with Anthropic's
official Windows installer, then opens Claude's own sign-in. Once signed in, edits run automatically
as they do today.

**Approaches considered**
- Packaging the Python side: (a) embeddable Python plus `.pyc`-only package, (b) PyInstaller exe.
  (a) picked: no new dependency, the pipeline stays standard-library Python, streamlink installs into it.
- Running the Node server: (a) Electron's own Node (`ELECTRON_RUN_AS_NODE`) with the server bundled by
  esbuild (already present through Vite/tsx), (b) shipping a separate Node. (a) picked: nothing extra.
- Bundling tools vs asking users to install them: bundling picked (owner).

**Design**
- Installer: electron-builder NSIS, per-user (no admin prompt), `Spikecut-Setup-<version>.exe`,
  Start-menu and desktop shortcuts, uninstaller, choice of install folder. Version 1.0.0.
- In the installed app's `resources/`:
  - `python/`: Python 3.13 embeddable runtime with streamlink installed into it.
  - `pipeline/`: the `clipwatcher` package as `.pyc` only, the edit skill pack (`.claude/skills/edit-short`)
    and the CC0 sound library (`assets/`).
  - `tools/`: ffmpeg and ffprobe, whisper-cli and its DLLs, yt-dlp.
  - `models/ggml-base.en.bin`: the small English whisper model. A bigger model can be picked in config.
  - `LICENSES/`: the license of each bundled program (ffmpeg's GPL text and a link to its source,
    Python, streamlink, whisper.cpp, yt-dlp).
  - `app.asar`: Electron main, the bundled server (better-sqlite3 rebuilt for Electron) and the built UI.
- Work folder: data, Shorts, Edited Clips and `config.toml` live in a folder the user chooses on first
  run (default `Documents\Spikecut`). It is remembered in Electron's user-data folder. On this PC
  you'd pick `D:\clipper` and everything existing keeps working. A new work folder gets a `config.toml`
  from `config.example.toml` with the bundled tool paths and model filled in.
- The app puts its bundled `tools/` and `python/` first on `PATH` for the processes it starts, so the
  pipeline finds them without config changes.
- Running from the repo (`Spikecut.cmd`, `npm run desktop`) behaves exactly as today.
- Release: tag `v1.0.0`, GitHub release with the installer and its SHA-256 checksum, and short install
  notes. The installer is unsigned (a certificate costs money), so Windows SmartScreen shows "Windows
  protected your PC"; the notes say to press "More info" then "Run anyway". README gets a Download
  section.

**Checks.** Existing Python and app tests pass. A new test checks that the packaged-path logic finds the
bundled Python, tools, pipeline and model. Then the real installer is built, installed on this PC,
started, pointed at a work folder, and checked through its pages. The setup check must show every
tool as found.

**Non-goals.** Auto-update, code signing, macOS/Linux builds, bundling Claude Code itself.

**Left to the builder.** The exact esbuild options, the folder names inside `resources/` beyond those
above, and how the "Set up Claude" button reports progress.
