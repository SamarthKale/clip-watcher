# Highlight analysis: finding the real moment in gaming and livestream footage

The chat spike says *when chat reacted*. Your job is to find *what happened*, *exactly when*, and
whether it's worth a Short. Three kinds of evidence come with every clip. Read them in this order,
then confirm everything with your own eyes.

## 1. Read `signals.json` (it's in the brief)
| Field | What it tells you | How much to trust it |
|---|---|---|
| `moment_guess.t` | The loudest audio peak shortly *before* the chat spike: often the kill, the scream or the explosion | A strong starting point. Always confirm it on frames |
| `audio.peaks` | Loud spots above the clip's median (+LU). A 12+ LU rise is a scream, a team fight or a big ability | High for *something happened*, low for *what* |
| `audio.silences` | Natural cut points: pauses between sentences, a dead round | High. Prefer to cut inside them |
| `scene_changes` | Hard visual changes: killcam, death screen, spectate switch, menu, replay, round end | High for *when*; look at the frame for *what* |
| `chat.category_share` | What chat is *saying* in the reaction window: funny, hype, play (kills/aces/clutch), fail, rage, shock, wholesome | Medium: chat jokes and spams. Use it as the mood signal |
| `chat.clip_calls` | Viewers typing "clip it" | High: viewers are telling you this is clip-worthy |
| `triage.score` | A 0–100 blend of chat strength, audio peak, chat reaction and clip calls | A tie-breaker only. A 35 can be gold and an 80 can be an ad |

An event detected by **audio** (spike source `audio`) has no chat numbers. Its peak *is* often
the moment, but it can also be a loud ad, a donation alert, a music sting or game menu music.
Check before you trust it.

## 2. Look, densely, where the evidence points
- `editkit timeline --source <clip> --from <guess-12> --to <guess+6> --out work/tl.jpg` gives a
  filmstrip with timestamps above the waveform. This one image shows the build, the moment and
  the reaction together.
- Then pull frames at 3–6 fps around the exact beat:
  `ffmpeg -ss <t-2> -i <clip> -t 4 -vf fps=5,scale=640:-2 work/look_%02d.jpg`.
- Look for the **visual proof** of the moment type (table below). If there is no proof on screen
  and nobody says it, it didn't happen. Don't invent a kill to fit the chat.

## 3. Gaming moment taxonomy
Use the most specific type you can prove. It sets the edit style in the playbook's moment table.

| Type | Visual proof (examples) | Audio proof | Typical chat |
|---|---|---|---|
| **KILL / HEADSHOT** | kill feed entry with the streamer's name, headshot icon, hit marker, enemy ragdoll | shot + kill sound, "got him" | `headshot`, `1 tap`, `Pog` |
| **MULTI-KILL** | 2–4 kill-feed entries in a few seconds, multi-kill banner ("DOUBLE", "TRIPLE", "QUADRA") | rapid fire, announcer | `triple`, `4k`, `insane` |
| **ACE / TEAM WIPE** | ace banner, all enemy portraits greyed out, "TEAM ELIMINATED" | announcer, streamer yelling | `ACE`, `5k`, `wipe`, `HOLY` |
| **CLUTCH** | streamer alone (teammate portraits dead) vs 2+ enemies, low HP, round-win banner | silence then a scream | `clutch`, `1v3`, `no way` |
| **OUTPLAY / SKILL** | movement or ability trick, flick, no-scope, insane dodge | | `cracked`, `aimbot`, `diff` |
| **FAIL / THROW** | streamer dies stupidly, misses an easy shot, falls off the map, loses a won round | groan, "noooo" | `L`, `throw`, `unlucky`, `KEKW` |
| **RAGE** | desk slam, headset off, alt-F4 | yelling | `MALDING`, `tilted`, `Madge` |
| **FUNNY / REACTION** | the facecam: laughter, deadpan, a jump scare | laughter, a joke line | `KEKW`, `LUL`, `ICANT` |
| **WHOLESOME** | thanks, a kind moment with chat or a teammate | | `<3`, `aww` |
| **STORY / TAKE** | talking, no gameplay focus | a monologue | mixed |

Genre hints: in **tactical shooters** (Valorant, CS) the kill feed is top-right, and the round
timer and score are top-centre. In **battle royales** watch the kill counter and "players left".
In **MOBAs** watch the announcer and multi-kill banners plus the gold or score bar. In **fighting
games**, the health bars and combo counters.

## 4. Score it (write it into `edit_decisions.json` → `highlight_score`)
Score each dimension 0–10. Total = weighted sum × 10, from 0 to 100.

| Dimension | Weight | 10 looks like |
|---|---|---|
| Hook strength | 0.30 | The first 1.5 s already makes a stranger stay: a loud line, mid-action, a visible threat |
| Standalone clarity | 0.25 | A non-viewer of this streamer gets it with ≤ 3 s of context |
| Emotional peak | 0.20 | A genuine scream, laughter, shock or rage, visible on the facecam |
| Payoff quality | 0.15 | A clean, provable payoff: the ace, the punchline, the reveal |
| Gameplay readability | 0.10 | You can *see* what happened at phone size (big action, or a readable HUD inset) |

- **< 50: reject** (`{"rejected": true, "reason": ...}`). Not every spike is a Short. Chat
  laughs at inside jokes, ads and alerts.
- **50–64: a cautious edit.** Carried by the payoff and captions, but still built to the 50–60 s
  target from the surrounding footage (set-up and aftermath), never padded.
- **≥ 65: full treatment** from the playbook.

Record the dimension scores and the total, e.g.
`"highlight_score": {"hook": 8, "standalone": 7, "emotion": 9, "payoff": 8, "gameplay": 6, "total": 78}`.

## 5. Set the in and out points
- **In:** the latest point where a stranger still understands the stakes. For kills and clutches
  that's usually 2–6 s before the first shot, the moment the enemy is spotted or the 1vX starts.
  For a joke, it's the setup line.
- **Out:** the end of the reaction peak, never the after-chatter. Cut inside a silence from
  `signals.json` if there is one nearby.
- Run `editkit snap --words <words.json> --segments <keep-list>` so no edge cuts a word in half.
