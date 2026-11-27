# Spikecut desktop release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-user Windows installer, `Spikecut-Setup-1.0.0.exe`, that installs a self-contained Spikecut (own Python, tools and model, compiled code only), published as GitHub release v1.0.0.

**Architecture:** Packaged mode in Electron starts the bundled Python (`resources/python`) on a `.pyc`-only pipeline (`resources/pipeline`) and runs the Vite-bundled server with Electron's own Node. A staging script builds `app/release-res/` (python, pipeline, tools, model, licenses); electron-builder ships it as `extraResources`. Data lives in a work folder the user picks on first run. Running from the repo is unchanged.

**Tech Stack:** Electron 45, electron-builder 26 (NSIS), Vite 6 SSR build (already a dependency), Python 3.13 embeddable, vitest, unittest.

**Spec:** `docs/superpowers/specs/2026-11-27-spikecut-desktop-release-design.md`

## Global Constraints

- No new runtime dependencies (Python: stdlib + bundled tools; app: existing `package.json` deps).
- No `.py`, `.ts` or `.tsx` file in the installer.
- Never bundle Claude Code or anyone's sign-in; Claude Code is installed with Anthropic's official installer on the user's request.
- Running from the repo (`Spikecut.cmd`, `npm run desktop`) behaves exactly as before.
- Never write into the install folder at runtime (it may be read-only).
- Version `1.0.0`; artifact `Spikecut-Setup-1.0.0.exe`; appId `app.spikecut.desktop`.
- Don't name a specific game anywhere; all text UTF-8.

## Review Focus

1. A work folder path with spaces (`C:\Users\Samarth Kale\Documents\Spikecut`) must work end to end. Test in Task 4.
2. Claude Code installed while Spikecut is open must be found without a restart (`%USERPROFILE%\.local\bin` on the children's PATH). Test in Task 4.
3. Picking a folder that already has a `config.toml` (this PC: `D:\clipper`) must never overwrite it. Test in Task 4.
4. A user's own Python settings (`PYTHONHOME`, `PYTHONPATH`) must not break the bundled Python, and nothing writes `__pycache__` into the install. Test in Task 4.
5. The configured `streamlink` missing from PATH but importable by the bundled Python must still record. Test in Task 1.

---

### Task 1: Pipeline finds bundled resources

**Files:**
- Modify: `clipwatcher/config.py` (`Config.resolve`), `clipwatcher/recorder.py`, `clipwatcher/cli.py` (`tool_status`)
- Test: `tests/test_packaging.py`

**Interfaces:**
- Produces: `Config.resolve(value)` falls back to `$CLIPPER_RESOURCES/<value>` when the relative path is missing under `root` and the fallback exists. `recorder.streamlink_command(cfg) -> list[str] | None`: `[found]` if `which(configured)`; else `[sys.executable, "-m", "streamlink"]` when configured is `"streamlink"` and `importlib.util.find_spec("streamlink")`; else `None`.

- [ ] Test `test_resolve_falls_back_to_bundled_resources` (relative model only under a temp `CLIPPER_RESOURCES` → that path; present under root → root wins; absolute untouched).
- [ ] Test `test_streamlink_command_uses_module_when_not_on_path` (patch `which` → None, `find_spec` → object: `[sys.executable, "-m", "streamlink"]`; both missing → None).
- [ ] Run `python -m unittest tests.test_packaging -v` → FAIL. Implement. `build_command` starts with `streamlink_command(cfg)`; `record_forever` exits when it is None; `tool_status` reports the module form as found.
- [ ] Full Python suite passes. Commit.

### Task 2: Server and Electron main as bundled, minified JS

**Files:**
- Create: `app/vite.server.config.ts`, `app/vite.electron.config.ts`
- Modify: `app/src/server/app.ts:125` (UI dir from `LOCALTUBE_UI_DIR`, default unchanged), `app/package.json` (scripts `build:server`, `build:electron`)

**Interfaces:**
- Produces: `dist/server/index.mjs` (+ `dist/server/schema.sql`, `dist/server/migrations/*.sql`, copied by the config's `closeBundle`), `dist/electron/main.cjs`, `dist/electron/preload.cjs`. Node deps and `electron` stay external.

- [ ] Build both; check: `node dist/server/index.mjs` with a temp `LOCALTUBE_DATA` prints `LocalTube running:` and `GET /` serves the UI when `LOCALTUBE_UI_DIR` points to `dist/ui`.
- [ ] `npm test` passes. Commit.

### Task 3: Stage the bundled resources

**Files:**
- Create: `app/scripts/stage_resources.py` (stdlib), `app/build/LICENSES/*.txt`
- Modify: `.gitignore` (`app/release-res/`, `app/build-cache/`)

**Interfaces:**
- Produces `app/release-res/`: `python/` (embeddable CPython matching the build machine's 3.13.x, `python313._pth` = `python313.zip`, `.`, `..\pipeline`, `Lib\site-packages`, `import site`; streamlink via `pip install --target ... --only-binary=:all: --platform win_amd64 --python-version 3.13`), `pipeline/` (`clipwatcher/**/*.pyc` built with `compileall -b`, no `.py`; `clipwatcher/ui_static/`; `.claude/skills/edit-short/`; `assets/` music, sfx, `library.json`; `config.example.toml`), `tools/ffmpeg/{ffmpeg,ffprobe}.exe`, `tools/whisper/{whisper-cli.exe,*.dll}`, `tools/yt-dlp/yt-dlp.exe`, `models/ggml-base.en.bin`, `LICENSES/`.
- `verify(stage_dir) -> list[str]` problems: any `.py` under `pipeline`, missing listed files, `python -m clipwatcher --help` or `python -c "import streamlink"` failing with the bundled Python and `PYTHONHOME`/`PYTHONPATH` set to junk.

- [ ] Run `python app/scripts/stage_resources.py` → prints `staged OK`. Commit.

### Task 4: Packaged runtime, work folder, PATH

**Files:**
- Create: `app/electron/runtime.cjs`, `app/electron/workfolder.cjs`
- Modify: `app/electron/main.cjs`
- Test: `app/tests/electron/runtime.test.ts`

**Interfaces:**
- `resolveRuntime({ isPackaged, resourcesPath, appDir, execPath, env, home, workDir }) -> { root, config, python, server: { cmd, args, cwd, env }, childEnv }`. Packaged: `python = <res>/python/python.exe`; server `cmd = execPath`, `args = [<appDir>/dist/server/index.mjs]`, env `ELECTRON_RUN_AS_NODE=1`, `LOCALTUBE_UI_DIR=<appDir>.unpacked/dist/ui`. `childEnv`: PATH starts with `<res>/python`, `<res>/tools/ffmpeg`, `<res>/tools/whisper`, `<res>/tools/yt-dlp`, `<home>/.local/bin`; sets `CLIPPER_RESOURCES`, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUTF8=1`; removes `PYTHONHOME`, `PYTHONPATH`. Dev: exactly today's values.
- `workfolder.cjs`: `readChoice(userData) -> string | null`, `saveChoice(userData, dir)`, `prepare(dir, resourcesPath) -> { created: boolean }` (makes the folder; writes `config.toml` from `config.example.toml` with `model = "models/ggml-base.en.bin"` only if none exists). `SPIKECUT_WORK_DIR` env overrides the choice (tests, power users).
- First run in packaged mode: message box "Where should Spikecut keep recordings, clips and Shorts?" with "Use Documents\Spikecut" / "Choose a folder…".

- [ ] Tests: packaged PATH order and `.local\bin` (RF2); env cleanup + no-bytecode (RF4); dev mode unchanged; `prepare` into a path with a space creates config with the model line (RF1); `prepare` on a folder with an existing `config.toml` leaves it byte-identical (RF3).
- [ ] `npm test` passes; `npm run desktop` still starts from the repo. Commit.

### Task 5: Set up Claude from the app

**Files:**
- Create: `app/src/server/claude.ts`, route registration in `app/src/server/app.ts`
- Modify: `app/src/ui/pages/Home.tsx` (setup banner), `app/src/ui/components/Tour.tsx` (ready step mentions it)
- Test: `app/tests/server/claude.test.ts`

**Interfaces:**
- `installCommand() -> { cmd: 'powershell.exe', args: ['-NoProfile','-ExecutionPolicy','Bypass','-Command','irm https://claude.ai/install.ps1 | iex'] }`; `signInCommand(home) -> { cmd: 'cmd.exe', args: ['/c','start','"Claude sign-in"', <home>\.local\bin\claude.exe] }` (falls back to `claude`).
- `POST /api/claude/install` (runs install in a visible console window, returns `{ started: true }`), `POST /api/claude/signin`. Both behind the existing token auth. Spawner injectable for tests.
- Home banner: when the `claude` tool is missing → "Set up Claude" button (then "Sign in to Claude"); text explains each user signs in with their own Claude account.

- [ ] Tests: commands exactly as above; routes 401 without token; with token call the injected spawner once.
- [ ] `npm test` + `npm run test:ui` pass. Commit.

### Task 6: Build the installer

**Files:**
- Modify: `app/package.json` (`version` 1.0.0, `build` config, script `dist`)

- `build`: `files` = `dist/**`, `package.json`, `build/icon.*`; `extraMetadata.main` = `dist/electron/main.cjs`; `asarUnpack` = `dist/ui/**`, `**/*.node`; `extraResources` = `{from: release-res, to: .}`; `win.target` nsis x64; `nsis`: `oneClick false`, `perMachine false`, `allowToChangeInstallationDirectory true`, desktop + start-menu shortcuts, `artifactName Spikecut-Setup-${version}.exe`, installer/uninstaller icons.
- `dist` = build:ui, build:server, build:electron, stage resources, `electron-builder --win nsis`.

- [ ] `npm run dist` → `app/out/Spikecut-Setup-1.0.0.exe`. Check `npx asar list out/win-unpacked/resources/app.asar` has no `.ts`/`.tsx`/`src/`, and `resources/pipeline` has no `.py`. Commit.

### Task 7: Install and test for real

- [ ] Install with `/S`; launch with `SPIKECUT_WORK_DIR` = a temp folder with a space in its name; Home loads, the setup check shows every tool found (Claude is installed on this PC); Spikes, Shorts, Settings open; screenshot.
- [ ] Launch without the override: first-run prompt appears; choose `D:\clipper`; existing Shorts/spikes show.
- [ ] Uninstall leaves the work folder untouched.

### Task 8: Release

- [ ] README "Download" section, `docs/product.md` install notes (SmartScreen "More info" → "Run anyway"; Claude sign-in). Commit, push, open PR.
- [ ] After the PR is merged to main: tag `v1.0.0`, `gh release create v1.0.0` with the installer and `Spikecut-Setup-1.0.0.exe.sha256`, notes as above.
