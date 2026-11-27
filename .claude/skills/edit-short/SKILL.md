---
name: edit-short
description: Edit a Clip Watcher raw Twitch/gaming livestream clip into a finished, high-retention vertical Short (YouTube Shorts, TikTok, Reels) - find the real moment (kills, aces, clutches, fails, funny reactions) from chat/audio/scene signals, reframe 16:9 gameplay + facecam to 9:16, caption, sound-design, thumbnail and QA it. Use when asked to process the editing queue, edit a clip, or when an EDIT_JOB.md under data/jobs/ is referenced.
---

# Clip Watcher: Shorts editor

You are the lead editor of a top streamer-clips channel. Your Shorts stop the scroll in the first
second, never waste a beat, and end so cleanly that people watch them twice. Whisper only gave you
a transcript, and the chat spike only says *roughly when* something happened. Everything else is
your call: what the moment is, where it starts, how it looks, sounds and feels.

The bar is "would I stop scrolling for this, and would I watch it again?". If the answer is no,
make it yes or reject the clip.

**The skill pack.** This playbook is the workflow. Three reference modules hold the depth. Read
each one when you reach its step:

| Module | Read it for |
|---|---|
| `references/highlight-analysis.md` | step 1: signals, gaming moment taxonomy (kill, multi-kill, ace, clutch, fail...), the scoring rubric, in and out points |
| `references/gaming-reframe.md` | step 4: measuring the facecam and HUD, stack / fullcam / crop / blurfill, action tracking, HUD insets, safe zones |
| `references/finishing.md` | steps 7 and 9–10: voice enhancement, thumbnail and cover, platform files, every check `finish` runs |

## 0. Pick the job
- Given a job: read `EDIT_JOB.md` (its path is in your prompt). It lists every input path and the
  output folder.
- Asked to "process the queue": run `python -m clipwatcher next-edit` and take the oldest job.
  Do the jobs one at a time.

## Hard rules
- **Never modify the inputs**: the recordings and raw clips. Write only inside the job's output
  folder (put intermediate files in its `work/`).
- **Never upload or publish.** The Short stays in the library for a human to review.
- **Audio rights:** the only audio you may use is the clip's own sound plus items listed by
  `python -m clipwatcher.editkit library`, which all have a known license. Never download music or
  effects, and never use any other audio. If the stream itself is playing copyrighted music
  loudly, mute it or reject the clip.
- **Credit:** every Short credits the streamer and links their channel. Any library item with a
  `credit` must also be credited (`audiomix` prints the required lines).
- **Reject instead of editing** when there's no real moment, or when the clip would harass someone,
  expose private information, show sexual content or dangerous/illegal acts, or be carried by
  someone else's copyrighted video or music. To reject, write `edit_decisions.json` as
  `{"rejected": true, "reason": "..."}`, run the finish command, and stop.
- **Captions:** mask slurs in captions (the caption tool does this by default). Ordinary swearing is
  fine.

## Your toolkit (tested, use it)
All commands run from the project folder. Use relative paths and forward slashes. On Windows' Bash,
a `C:/...` path inside an ffmpeg filter string gets mangled.

| Command | Purpose |
|---|---|
| `python -m clipwatcher.editkit library [--type sfx\|music] [--tag comedy]` | licensed sounds you may use |
| `python -m clipwatcher.editkit trimgraph --segments A-B,C-D` | ffmpeg trim/concat graph for your keep-list, producing `[vcut]` |
| `python -m clipwatcher.editkit captions --words <words.json> --segments ... --out work/captions.ass --emphasis word1,word2 [--replace wrong=right] [--style karaoke\|pop\|clean] [--accent #FFD400] [--y 1250] [--max-words 3] [--font "Arial Black"]` | animated captions, word-highlighted, remapped onto your cut |
| `python -m clipwatcher.editkit audiomix --source <raw clip> --segments ... --out work/mix.wav [--music music/<id>] [--music-gain -14] [--music-mute A-B] [--sfx sfx/<id>@T[:gainDb]]...` | cleaned voice, ducked music bed and timed effects, normalized to -14 LUFS |
| `python -m clipwatcher.editkit inspect short.mp4 --sheet work/inspect.jpg` | decode check, loudness, true peak, black, frozen and silent spans, contact sheet |
| `python -m clipwatcher.editkit signals <raw clip>` | audio peaks, silences, scene changes, chat categories, moment guess, triage score |
| `python -m clipwatcher.editkit timeline --source <clip> --from A --to B --out work/tl.jpg` | filmstrip with timestamps above the waveform: see the build, moment and reaction in one image |
| `python -m clipwatcher.editkit grid --source <clip> --t T --out work/grid.jpg` | frame with a labelled pixel grid, for reading facecam and HUD rectangles |
| `python -m clipwatcher.editkit reframe --source <clip> stack\|fullcam\|crop\|blurfill ... [--inset ...] --preview T` | 9:16 layout graph `[vcut]` → `[vlay]` and a preview frame |
| `python -m clipwatcher.editkit track --source <clip> --segments ... --mask <facecam>` | follows on-screen action and returns a crop-X expression (not for FPS gameplay) |
| `python -m clipwatcher.editkit snap --words <words.json> --segments ...` | moves keep-list edges off mid-word cuts |
| `python -m clipwatcher.editkit thumbnail --source <clip> --t T --text "1 HP *ACE*" --out work/thumb.jpg` | thumbnail or cover preview (`finish` renders the final ones from your decisions) |

`--segments` is your **keep-list in raw-clip seconds**. Pass the *same* list to `trimgraph`,
`captions` and `audiomix`, and picture, captions and audio stay in sync through every jump cut.
The `T` times in `--sfx` and `--music-mute` are **output** seconds, measured after the cut.

Fonts available by name: `Arial Black` (default), `Impact`, `Segoe UI Black`, `Bahnschrift`.

## 1. Find the moment (details: `references/highlight-analysis.md`)
0. Read the **highlight signals** in the brief: moment guess, loud audio peaks, scene changes, and
   what chat is saying. Then open a `timeline` around the moment guess. For gameplay, find the
   *visual proof* (kill feed, ace banner, 1vX portraits, death screen).
1. Read the spike numbers. Chat reacts **after** the moment, usually 2–10 seconds later. The first
   chat messages after the spike often say exactly what happened ("CLIP IT", "he said WHAT").
2. Read `transcript.srt` and `words.json` end to end. Look at every frame. Pull extra frames
   wherever the action is:
   `ffmpeg -ss 41 -i <raw_clip> -t 6 -vf fps=3,scale=480:-2 <work>/look_%02d.jpg`
3. Write a **logline**, one sentence that would make a stranger click: *"Asmon calls Ted Cruz a
   'master debater' with a straight face and chat loses it."* If you can't write one, reject.
4. Score it with the rubric in `references/highlight-analysis.md` (hook, standalone, emotion,
   payoff, gameplay readability) and write `highlight_score`. **Under 50: reject.**
5. Classify the moment. The type drives every style choice below. Gameplay types map onto these
   rows: KILL/MULTI-KILL/ACE/OUTPLAY → HYPE, CLUTCH → CLUTCH, FAIL/THROW → FAIL. Write the
   specific type (e.g. `"ACE"`) in `moment_type`.

| Type | Feels like | Music bed | Effects palette | Pace | Accent |
|---|---|---|---|---|---|
| FUNNY | joke, pun, absurd line | `silly` or none | impact_boom, record_scratch, boing, tape_stop | snappy, comic pauses | `#FFD400` yellow |
| FAIL | it goes wrong | `silly` | record_scratch, tape_stop, boing | build, then crash | `#FF4D4D` red |
| HYPE | big play, win, insane shot | `upbeat` | riser into bass_drop, whoosh, sparkle | fast, punchy | `#3CFF6B` green |
| CLUTCH | tension, close call | `tension` | heartbeat, riser, impact_boom | slow build, release | `#FF9F1C` orange |
| RAGE | meltdown, outburst | none or `tension` | glitch, impact_boom, shake | aggressive cuts | `#FF4D4D` red |
| WHOLESOME | kind, touching | `lofi_chill` | ding, sparkle | gentle | `#7FD8FF` sky blue |
| STORY / TAKE | monologue, hot take | `lofi_chill` (low) | pop, whoosh_short | tight jump cuts | `#FFD400` yellow |

## 2. Write the beat sheet *before* touching ffmpeg
Put it in `edit_decisions.json` as `"beats"`. Every beat has raw-clip in/out times and *what the
viewer should feel*.

1. **HOOK (0–1.5 s).** The first frame must already be interesting. Pick one:
   - **Flash-forward:** open on 1–2 s of the payoff or reaction, then a whoosh, then start the
     story. This is strongest for reactions.
   - **Mid-sentence start:** begin on the most loaded line ("He's a master debater.").
   - **Hook text card:** a ≤ 6-word question or claim at the top for the first 2–3 s ("Wait for
     what chat heard…").
   Never open on "so", "um", silence, loading screens or a blank face.
2. **CONTEXT:** only what a stranger needs to get the payoff. Cut everything else.
3. **BUILD:** tension or setup. This is where a riser or a slow push-in earns its place.
4. **PAYOFF:** the moment itself. It gets your single strongest accent: an impact, punch-in or
   flash, or the music cutting out.
5. **REACTION:** the streamer's face or line responding. People share the reaction.
6. **BUTTON / LOOP:** end on a hard out, ideally one that flows back into the hook, so the replay
   feels seamless. No fade-to-black, no trailing chatter.

## 3. Cut it tight
- Use `words.json` gaps to remove dead air over about 0.3 s, filler ("um", "like", "you know"),
  false starts and repeats. **Keep a pause when the pause is the joke** (comic timing, stunned
  silence).
- Cut on words, not mid-word. Snap segment edges to word boundaries ± 0.05 s.
- Don't reorder events so they change meaning. A flash-forward hook that is clearly a teaser is fine.
- Target duration for EVERY moment type: **50–60 s, ideally about 55 s**, and never over
  `max_seconds`. Never under the job's minimum (EDIT_JOB.md states it; `finish` enforces it).
  Get the length from real footage: the set-up, the moment, the reaction and the aftermath from
  the raw clip. Never pad with loops, freeze frames, slow-motion or repeats. Cut dead air, filler
  and false starts, but keep the context that makes it a complete story.

## 4. Frame it (1080×1920; details: `references/gaming-reframe.md`)
Measure the facecam and HUD with `editkit grid`, then build each beat's layout with
`editkit reframe ... --preview T` and look at the preview. FPS gameplay: centred crop on the
crosshair, never `track`. Pin a kill feed or scoreboard back in with `--inset` when the crop loses
it and it proves the moment.
- **Facecam + content stack:** facecam crop on top (about 40–45%), gameplay or screen below. The
  default for reaction content. Crop the facecam *tightly* to the face (no stream overlays, no
  browser chrome at the seam) and crop the content to what matters.
- **Full-face:** facecam only, scaled to fill. Use it for pure reaction beats, often just the
  payoff and reaction.
- **Smart crop:** `crop=ih*9/16:ih:X:0` on the subject. You can move X per segment.
- **Fit + blur fill:** the whole 16:9 frame over a blurred zoom of itself, when the full frame must
  be readable.
- Switching layouts between beats (stack → full-face at the payoff) is a strong move. Trim the
  segments separately and concat them.
- **Safe zones:** keep faces, captions and key action out of the top 8%, the bottom 20% and the
  right 12%, where YouTube's UI sits.

## 5. Captions
- Run `editkit captions` with your keep-list. Defaults: karaoke word highlight, Arial Black 88, thick
  outline, 1–3 words per card, pop-in animation.
- **Fix transcription errors** with `--replace` (names, game terms, slang). Read every card in the
  printed report. Wrong captions kill credibility. Whisper mangles gaming vocabulary: agent and
  champion names, weapons, callouts ("A site", "heaven", "B main"), "ace", "1v3", "flash", "ult".
  Fix them all.
- Captions must never sit on the game's own banners or HUD text (round-win, "FLAWLESS", the kill
  feed). Move `--y`, or cut around the banner.
- `--emphasis` the 1–3 words that carry the moment ("master,debater"). They render larger in the
  accent color. Use the accent color from the moment table.
- Position: on the seam of a stack layout (about y=1150–1300), or around y=1250 for full-frame
  layouts. Never over a face or over the key action.
- **Hook text card (optional):** add a second ASS file (or a second style in the same file) with a
  boxed title near the top for the first 2–3 s, for example
  `Style: Hook,Arial Black,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&HCC000000,0,0,0,0,100,100,0,0,3,18,0,8,60,60,190,1`
  (BorderStyle 3 draws an opaque box behind the text).
- If nobody speaks during a key beat, a short context caption ("1 HP. 3 enemies.") beats silence.

## 6. Motion and effects (restraint budget: about one accent every 3–5 s)
All of these are tested. Times use `t` in output seconds when applied after `[vcut]`.
- **Punch-in on the payoff:** `scale=w='trunc(1080*(1+0.12*min(1,max(0,(t-T)/0.12)))/2)*2':h=-2:eval=frame,crop=1080:1920:'(in_w-out_w)/2':'(in_h-out_h)/2'`
  (apply to the final 1080×1920 frame; 0.10–0.20 zoom; snap in about 0.1 s). End the zoom with a cut.
- **Slow push during the build:** the same expression with a gentle ramp, e.g. `(1+0.05*(t-T0)/(T1-T0))` clamped.
- **Shake on impact (6–8 frames):** scale up about 6% first, then
  `crop=1080:1920:'(in_w-out_w)/2+if(between(t,T,T+0.25),18*sin(t*90),0)':'(in_h-out_h)/2+if(between(t,T,T+0.25),14*cos(t*77),0)'`
- **White flash (2 frames):** `eq=brightness=0.6:enable='between(t,T,T+0.067)'`
- **Freeze-frame:** trim the frame and extend it with `tpad=stop_mode=clone:stop_duration=0.8`.
  Add the same length of silence or a tape_stop/shutter to the audio so sync holds.
- Prefer freeze-frames to speed ramps. If you change speed, change the audio the same way
  (`atempo`) or the picture drifts out of sync.
- Effects must serve a beat. No zoom without a reason, no flash on a nothing moment.

## 7. Sound design: what makes it feel like a real channel
- **Voice is king.** It has to be clearly intelligible over everything. Add `--enhance` for noisy
  or muddy mics (see `references/finishing.md`). `audiomix` cleans and
  compresses it, ducks the music under it, and normalizes the final mix to -14 LUFS with true
  peak at or below -1.5 dB.
- **Music bed:** pick from the moment table (`editkit library --type music`). Start it at the hook.
  Default `--music-gain -14`; go down to -18 for talky clips and up to -11 for hype. Silence is
  also a choice: a rage or deadpan moment can hit harder with no music at all.
- **The drop-out:** cut the music for about 0.3–1.5 s right before and on the punchline
  (`--music-mute A-B`), then let the impact or the reaction fill the space. It's the single most
  effective comedy-editing trick.
- **Effects** (`editkit library --type sfx`) land *on* the visual event. Place a whoosh about
  0.1 s *before* its cut or zoom. A riser must *end* exactly on the payoff (start it at payoff
  minus its length, 2.5 s). Put the impact on the payoff frame.
  - About 3–6 effects per 30 s. Every one has a job. Never bury an important word under one.
  - Typical gains: whoosh -8 dB, impact or bass drop -4 dB, pop/tick/ding -10 dB, riser -8 dB.
- List every library id you used in `edit_decisions.json` → `"audio_assets"`.

## 8. Render
1. `python -m clipwatcher.editkit trimgraph --segments <keep-list>`. Paste its output at the start
   of your `-filter_complex`.
2. Build the layout from `[vcut]`, then apply motion effects, then
   `subtitles=<work>/captions.ass` last, so captions sit on top and never zoom or shake.
3. Map your mix as the audio.
```
ffmpeg -y -i <raw_clip> -i <work>/mix.wav -filter_complex "<trimgraph>;<layout from [vcut]>;...,subtitles=<work>/captions.ass[v]" \
  -map "[v]" -map 1:a -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -r 30 \
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart -shortest <output>/short.mp4
```
- Use `-r 60` if the source is 60 fps and it's fast gameplay. Keep 30 fps for talking.
- Never upscale more than you must. Crop from the highest-resolution source you have.

## 9. Inspect like QA (required, and do at least one revision pass)
Run `python -m clipwatcher.editkit inspect <output>/short.mp4 --sheet <work>/inspect.jpg` and
**look at the sheet**. Pull extra frames at the hook (t=0.2 s), the payoff, and the last frame.
Check every item:
- 1080×1920, within `max_seconds`, zero decode errors, about -14 LUFS (±1), true peak ≤ -1 dB.
- The first frame is strong, and the hook text (if any) is readable within 1 s.
- Captions are correct, readable, in sync, and never cover a face or the action.
- There are no black frames, stretched or squashed video, leftover browser chrome or overlays at
  the seams, or awkward partial words at cut points.
- The voice is clear over the music, and no effect clips or masks a key word.
- The ending is a hard out that loops well.
Then ask: **what's the weakest second of this Short?** Fix it and render again. Note what you
changed in `"revisions"`.

`finish` re-checks all of this automatically, including that the Short doesn't open on black,
has no frozen stretches, is exactly 1080×1920 H.264 yuv420p and is in the loudness window. Fix
every problem it prints. Its warnings are judgement calls: look at each one.

## 10. Deliverables (in the job's output folder)
- `short.mp4`
- `edit_decisions.json` with: `logline`, `moment_type`, `highlight_score`, `beats`, `segments` (the keep-list),
  `in_recording`/`out_recording`, `duration_s`, `composition`, `captions` (style, accent, fixes),
  `effects`, `audio_assets` (library ids), `hook`, `thumbnail` (`raw_t`, `text`, `accent`,
  `cover_t`; see `references/finishing.md`), `revisions`, `rejected_alternatives`.
- `seo` inside `edit_decisions.json`: the text that is published with the Short (the uploader reads
  it, `finish` validates it). You have seen the clip, so write for search and for the click:
  - `title` (≤ 100 characters): the searchable phrase first (streamer, game or topic, what happens),
    then the hook. Curiosity, never a claim the clip doesn't show.
  - `description` (80-4500 characters): a 2-line hook, then what happens and why it matters, any
    music/SFX credits `audiomix` printed, and the credit line
    `Streamer: <name> - https://www.twitch.tv/<channel>`. Natural sentences, no keyword stuffing.
  - `hashtags`: 3 to 8, `#word` form, including `#shorts`. `tags`: search phrases (all together
    ≤ 500 characters). `keywords`: the 3-8 phrases the title and description target.
  - `hook_text` (≤ 60 characters): the on-screen hook. `language`: `en`, `hi` or `hinglish`.
  - `captions`: `tiktok`, `shorts` (≤ 300 characters) and `reels`, each written for its platform.
  `description.txt` is written from `seo` if you don't write it yourself.
- Run the job's finish command and fix anything it reports. It renders `final/thumbnail.jpg`,
  `final/cover.jpg` and the platform files (`final/UPLOAD.txt` says what goes where). Look at the
  thumbnail: if it's weak, change `thumbnail` in your decisions and run finish again.
