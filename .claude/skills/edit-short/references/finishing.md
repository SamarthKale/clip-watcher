# Finishing: audio polish, thumbnails, platform files and QA

## Audio enhancement
- `editkit audiomix ... --enhance` adds broadcast-style voice polish: light FFT denoise, a 250 Hz
  cut (mud) and a 3.5 kHz lift (presence), in the right order (denoise → high-pass →
  compression → EQ). Use it when the streamer's mic is noisy or muddy. Skip it when game audio
  *is* the moment (explosions, music), because the EQ also colours the game.
- The stream audio is one track (voice + game). You can't remove the game, but you can **duck the
  music bed** (automatic) and **time effects into gaps** (a silence in `signals.json` is a free
  slot).
- Loudness: the mix is normalised to -14 LUFS integrated with a true peak of -1.5 dB or lower. This
  is the YouTube/TikTok/Reels target, and `finish` rejects anything outside -17 to -11 LUFS or
  above -0.5 dBTP.

## Thumbnail and cover (rendered by `finish` from your decisions)
Add this to `edit_decisions.json`:
```json
"thumbnail": {"raw_t": 41.2, "text": "1 HP *ACE*", "accent": "#3CFF6B",
              "cover_t": 0.4, "cover_text": "", "position": "top", "crop": null}
```
- `raw_t` is a **raw-clip** time for the 1280×720 thumbnail. Pick the frame where the face *or* the
  action is at its peak: the scream, the "ACE" banner, the enemy in the crosshair. Never a menu,
  loading screen or blurry motion frame. Check with `editkit grid`, or pull frames.
- `text`: at most 4 words, a claim or tension that adds to the title rather than repeating it.
  `*word*` turns that word the accent colour. Uppercase is automatic.
- `crop`: optional `X,Y,W,H` source rectangle, e.g. only the facecam for a reaction thumbnail. It
  must be large enough not to look soft; the facecam is often too small for 1280×720.
- `cover_t` is an **output** time on `short.mp4` for the 1080×1920 cover, usually the hook frame.
  `cover_text` is optional.
- Preview any of these yourself: `editkit thumbnail --source <clip> --t <t> --text "..." --out work/thumb.jpg`.
  `finish` re-renders only when your decisions or the Short are newer than the existing images.

## Platform files (`finish` makes them; nothing is uploaded)
`<output>/final/` gets `manifest.json` and `UPLOAD.txt` saying which file goes where:
| Platform | Limit used | Typical result |
|---|---|---|
| YouTube Shorts | ≤ 180 s, ≤ 60 fps, 1080×1920 H.264 | the master `short.mp4` as-is |
| TikTok | ≤ 600 s, ≤ 287 MB | the master as-is |
| Instagram Reels | ≤ 180 s, ≤ 25 Mbps video, ≤ 128 kbps AAC audio, ≤ 300 MB | video **copied**, only the audio re-encoded |

The master is never duplicated or re-encoded when it already meets a spec. Anything over a
platform's length limit is skipped, never auto-trimmed: re-edit it instead. Limits can be changed
in `config.toml` under `[export.specs.<platform>]`.

## What `finish` checks (fix every problem it prints)
Hard problems (the job isn't done):
- the file plays end to end (full decode), with video and audio;
- exactly 1080×1920, H.264, yuv420p, ≤ 60 fps, within `max_seconds`, ≥ 3 s;
- -17 to -11 LUFS, true peak ≤ -0.5 dB;
- **doesn't open on a black frame**; no black over 1.0 s; no frozen picture over 2.5 s;
- `description.txt` links the streamer, credits every library item that needs it, and every
  `audio_assets` id is a licensed library item.

Warnings (look and decide): short black flashes, stills of 1–2.5 s, near-silence of 1.5 s or more.
They are printed by `finish` and stored in `metadata.json` → `qa.warnings`.
