# Gaming & Livestream Clipping Skill Pack

Clip Watcher's editing system for Twitch and YouTube gaming content. It is one pipeline with
modular parts, built on ffmpeg, whisper.cpp, the Python standard library and Claude Code. It adds
no new dependencies.

| Part | Where | What it does |
|---|---|---|
| Highlight signals | `clipwatcher/signals.py` → `signals.json` per raw clip | loudness peaks, silences, scene changes, chat emote/keyword categories (funny, hype, play, fail, rage, shock, wholesome), "clip it" calls, moment guess, triage score |
| Audio trigger (optional) | `clipwatcher/audio_detector.py` (`audiodetect` stage) | loudness spikes in the live recording, mirroring the 3x chat algorithm on LU. Off by default. Merges with a nearby chat spike into one event |
| Reframing | `clipwatcher/reframe.py`, `editkit reframe / grid / track` | stack, fullcam, crop and blur-fill layouts, HUD insets (kill feed, scoreboard), CV-free action tracking |
| Cut precision | `editkit snap`, `editkit timeline` | no mid-word cuts; filmstrip plus waveform to see the moment |
| Audio polish | `editkit audiomix --enhance` | denoise, then high-pass, compression and voice EQ, in broadcast order; mixed to -14 LUFS |
| Thumbnails | `clipwatcher/thumbs.py`, `editkit thumbnail` | 1280×720 thumbnail and 1080×1920 cover: one frame, colour pop, ≤ 4 big words |
| Platform files | `clipwatcher/export.py` | YouTube Shorts, TikTok and Reels. Reuses the master whenever it meets the spec, otherwise re-encodes only what's out of spec |
| QA | `media.qa_scan`, `editor._qa_rules` | full decode; exact format; loudness; black open; frozen picture; silence |
| Editor playbook | `.claude/skills/edit-short/SKILL.md` + `references/` | workflow + highlight analysis, gaming reframing, finishing |

Output layout (unchanged, plus `final/`):
```
Raw Cut Clips\<streamer>\<date>\<event>\   clip.mp4 (original, stream copy), signals.json, transcripts, chat, frames
Edited Clips\<streamer>\<date>\<event>\    short.mp4 (master), edit_decisions.json, description.txt, metadata.json
                                       final\  thumbnail.jpg, cover.jpg, [platform files], manifest.json, UPLOAD.txt
```

## How the 30 reference skills were used

I read every repository's README and file tree, and read each marketplace or site page. Decisions
were judged against this project's rules: standard-library Python, no paid APIs, original footage
never modified, nothing published, and the plain 3x chat detector stays the default.

| # | Reference | Decision | What we took (or why not) |
|---|---|---|---|
| 1 | Video-use (browser-use/video-use) | **Adapted** | The *timeline view* (filmstrip + waveform) became `editkit timeline`. Also the idea that the LLM reads text plus a few images instead of watching every frame, and the self-evaluation loop (already in the playbook). Skipped: the ElevenLabs Scribe API (we use local whisper.cpp) and the Manim/HyperFrames overlays |
| 2 | Video Editing Skill (6missedcalls) | Covered | Trim, silence jump-cuts and caption styles already exist in editkit. Silence detection was reused for the cut points in `signals.json` |
| 3 | Cut Video (Tella skills) | Concept | "Hide the cut inside the stinger peak" is in the playbook's whoosh/impact timing. Tella's hosted editor isn't usable here |
| 4 | Video Trimmer (mcpmarket) | **Adopted** | The stream-copy vs re-encode decision with a size/format report became `export.plan` (copy when in spec, re-encode only what's out of spec) |
| 5 | Video Editor (claudecowork) | Covered | Silence removal, pacing and multi-platform export are all in the pipeline. The page has no recipes to add |
| 6 | HyperFrames (heygen-com) | Skipped | An HTML/Chrome render engine: a heavy Node dependency. ffmpeg + libass already render captions and motion |
| 7 | Remotion Motion Graphics | Skipped | Node/React render stack. Same reason |
| 8 | Video Shotcraft | Skipped | A product-promo shot library (Remotion), not gameplay clipping |
| 9 | Vertical Video Editing (nopefallacy) | **Adapted** | The *render verification gate* became `finish` QA (exact 1080×1920, H.264, yuv420p, audio, plus black and freeze detection). Face-safe framing became safe zones and the facecam-upscale warning. HyperFrames skipped |
| 10 | Remotion Agent Skills | Skipped | Node/React. Its "umbrella skill + narrow modules" structure *is* used (SKILL.md + references/) |
| 11 | Clipify | **Adapted** | Its CV-free trick (frame-difference energy in regions, no face model) generalised into `editkit track` (column motion energy, masked facecam/HUD, dead-band, eased or hard-cut pans). Also audio transients for clip finding (became `signals` loud peaks) and split layouts (became `stack`) |
| 12 | Shorts Video Creator (mcpmarket) | **Adapted** | A rectangle annotation as the contract between detection and crop: `X,Y,W,H` read off `editkit grid`. A bounding-box preview before rendering became `reframe --preview`. Its external "SEE" vision pipeline was skipped |
| 13 | Claude Shorts (AgriciDaniel) | **Adapted** | The weighted segment-scoring rubric with a threshold, re-weighted for gaming with *gameplay readability* added; reject below 50. Audio-aware boundary snapping became `editkit snap`. Platform encode specs became `export.py`. Reframe strategy per content type became the layout table. faster-whisper, MediaPipe and Remotion skipped |
| 14 | Motion Graphics (Barty-Bart) | Covered | "Sound effects timed and measured" already exists (synthesised CC0 library, timed `--sfx`, -14 LUFS). HTML motion B-roll skipped |
| 15 | B-Roll Overlay (mcpmarket) | **Adapted** | A non-destructive overlay over the untouched base picture and audio became HUD **insets** (kill feed, scoreboard) via `overlay`. The EDL idea is the existing keep-list and `edit_decisions.json`. Novoads API skipped |
| 16 | Thumbnail Skills (thumbcraft) | **Adapted (local)** | The thumbnail step itself, rebuilt locally in `thumbs.py` (best frame, colour pop, ≤ 4 words, accent word). The paid API and face swap were skipped |
| 17 | Claude Video Vision | **Adopted (principle)** | Adaptive extraction: sparse frames first, dense frames only where the evidence points (playbook step 1 + `timeline`). Local Whisper backend already in use. MCP server, Gemini and OpenAI skipped |
| 18 | Watch Video (bradautomates) | Covered | Frames + transcript handed to Claude is how every edit job already works. yt-dlp and Gemini skipped |
| 19 | Caption Clip (kwindla) | **Adopted** | An LLM-in-the-loop transcript cleanup step: the playbook requires fixing every misheard word, with a gaming glossary (agents, weapons, callouts, "ace", "1v3"), via `--replace`. Deepgram skipped |
| 20 | Omni Captions (lattifai) | Concept | Separate steps (transcribe, align, style) mirror our stages. Word timings already come from whisper.cpp. LaiCut and Gemini skipped |
| 21 | Caption Engine (robcressy) | **Adapted** | Rubric + threshold as a text QA gate became the thumbnail/title text rules: ≤ 4 words, adds to the title rather than repeating it, no clickbait lies |
| 22 | Color Grade AI | Partial | Colour pop (`eq` contrast/saturation + unsharp) for thumbnails only. LUT grading of gameplay was skipped: game footage is display-referred and already graded, and it needs Ruby/Pillow/numpy |
| 23 | Audio Editing (clawfu) | **Adopted** | Processing order (denoise → high-pass → compression → EQ → limit), voice EQ (cut ~250–300 Hz, lift ~3–3.5 kHz) and platform loudness. Became `audiomix --enhance`, with -14 LUFS kept |
| 24 | Pexo Agent | Skipped | AI video generation (paid). This project clips real footage and never invents it |
| 25 | Higgsfield Skills | Skipped | AI generation with credits. Same reason |
| 26 | Kling AI Skills | Skipped | Prompt writing for generative video. Not relevant to clipping |
| 27 | Video Producer | Skipped | Playwright product demos + ElevenLabs narration |
| 28 | Claude Code Video Toolkit | Skipped | A Remotion-based toolkit (README reviewed). Its "one toolkit the agent calls" idea is `editkit` |
| 29 | Superpowers | Already installed | Used for the process (test-first, verification before completion), not shipped in the product |
| 30 | Skill Creator | Already installed | Skill structure conventions: a concise SKILL.md with progressive disclosure into `references/` |

## Deliberately not built
- **Pixel-level kill and ace detection (game-specific computer vision):** it would need per-game
  templates or OCR and new dependencies, and it breaks with every HUD update. Instead, Claude
  confirms the moment visually from dense frames and the timeline, guided by the taxonomy in
  `references/highlight-analysis.md`. Audio peaks, scene changes and chat categories point it to
  the right seconds.
- **AI-generated footage, voice clones or face swaps:** they conflict with original-footage
  preservation and attribution.
- **Auto-trimming to fit a platform limit:** a Short over a platform's length limit is reported, and
  the edit is redone by a person or by Claude.
