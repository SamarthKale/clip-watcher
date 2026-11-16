# 9:16 reframing for gaming and livestream footage

A Twitch frame is 16:9 with a facecam somewhere, a HUD around the edges and chat or alerts as
overlays. A Short is 9:16. You can't keep everything, so decide what the viewer must see in each
beat.

## Measure first: `editkit grid`
`editkit grid --source <clip> --t <time> --out work/grid.jpg`, then look at it. Labels are source
pixels. Write down:
- **facecam** `X,Y,W,H`: tight to the camera image, excluding overlay borders, alerts and chat;
- **HUD items** you may want as insets: kill feed, scoreboard, round timer, minimap, health/ammo,
  multi-kill banner;
- **overlays to avoid**: chat box, alerts, sub goals, sponsor banners.

The facecam can move or disappear (BRB scenes, full-screen moments). Check a grid at the start
and at the payoff.

## Pick a layout per beat (`editkit reframe --source <clip> <layout> ... --preview <t>`)
| Layout | Use when | Command |
|---|---|---|
| **stack** | Facecam + gameplay: the default for reactions to gameplay | `stack --cam X,Y,W,H [--split 0.38] [--game X,Y,W,H \| --game-cx 0.55]` |
| **fullcam** | Pure reaction: the face *is* the payoff (laughter, rage, shock) | `fullcam --cam X,Y,W,H` |
| **crop** | Gameplay-only beats: the shot, the clutch, the outplay | `crop --cx 0.5 [--zoom 1.15]` or `--x-expr` from `track` |
| **blurfill** | The whole HUD must be readable: scoreboard reveals, strategy, wide shots | `blurfill [--zoom 1.2]` |

Every command prints a graph that reads `[vcut]` and writes `[vlay]`. `--preview <t>` renders one
frame to `work/reframe_preview.jpg`. **Look at it before you render.**

Switching layouts between beats is the strongest move in gaming Shorts. For example, use stack for
the build, crop+zoom for the kill, and fullcam for the scream. Trim each beat separately, give each
its own layout, then `concat`. Use the same keep-list times for captions and audio.

### Rules that keep gaming crops readable
- **First-person shooters:** the crosshair is the screen centre. A centred crop (`crop --cx 0.5`)
  keeps the aim. **Don't use `track` on FPS gameplay**: when the player turns, the whole screen
  moves, so motion tracking means nothing there.
- **Third-person, top-down, MOBA, platformer, sports, IRL with a static camera:** use `track`.
  `editkit track --source <clip> --segments <keep-list> --mask <facecam> --mask <chat box>`
  follows where the action is, with a dead-band so the framing stays calm, and prints a ready
  `crop --x-expr`. Use `--ease 0` for hard-cut pans.
- **Kill feed / scoreboard lost in the crop?** Pin it back with an inset:
  `--inset X,Y,W,H@PX,PY,WIDTH`. Example, a Valorant kill feed at the top of the gameplay area:
  `--inset 1480,80,420,170@560,760,480`. Insets go where the eye already is, never over a face or
  the captions. Show one only when it proves the moment (the kill-feed entry, "ACE", the score).
- **Don't duplicate:** if the crop already shows the HUD item, don't inset it too.
- **Facecam resolution:** small facecams look soft when stretched. `reframe` warns when the cam is
  enlarged more than about 2.2×. Then use a smaller `--split` (0.30–0.36), use fullcam only for
  short beats, or favour the gameplay.
- **Never upscale gameplay twice.** Crop from the original clip, once, with lanczos (the tool does
  this).

## Safe zones (1080×1920)
Keep faces, captions, insets and key action out of the top ~8–10%, the bottom ~20% and the right
~12%, where the Shorts, Reels and TikTok UI sits. In a stack, captions go on or just below the seam
(`--y` about 1.0–1.15 × the seam height). In a crop, put them around y = 1250, clear of the HUD
banners near the screen centre.
