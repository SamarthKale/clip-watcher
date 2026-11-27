# Talking videos: podcasts, interviews, commentary, vlogs

Use this module instead of the gaming parts of steps 1, 4, 5 and 7 when the footage is people
talking. Everything else in the playbook (beat sheet, cutting, render, QA, deliverables, hard
rules, attribution) is unchanged.

## 1. The moment
The words are the moment. Read the transcript first, then watch the frames to confirm it plays.
- **Kinds:** punchline, hot take, story with a payoff, reveal or surprising fact, heated exchange,
  a strong one-liner answer, a big laugh, an emotional beat.
- **Standalone test:** someone who never saw the rest of the video understands it in the first
  3 seconds. If it needs context, open on a one-line hook caption that gives it (`hook_text`), or
  start at the question that sets it up.
- **In point:** on the question or the setup line, never mid-word, never on "so, um". **Out
  point:** right after the payoff lands and the laugh or reaction peaks; cut before the topic moves on.
- **Hook first:** if the best line is in the middle, a 1–2 s cold open of the payoff, then the
  setup, is allowed (mark it as a beat). Never fake an order that changes what someone meant.
- Score it with the same rubric; "gameplay readability" becomes "is the speaker's face readable".
- Cut filler hard (`snap` on word boundaries): "um", false starts, long pauses. Keep breaths that
  carry timing. Never cut inside a sentence so it says something the speaker didn't say.

## 4. Framing: follow the speaker
The default is a 9:16 crop on whoever is talking, moving when the speaker changes.
1. `editkit grid --source RAW --t T --out WORK/grid_T.png` on a few frames: find each person's horizontal centre as a
   fraction of the width (e.g. host 0.28, guest 0.71). Separate camera angles that already cut to
   each speaker need no moves: crop the centre of each shot.
2. Find the turns. Use the transcript (question → answer, "you" / "I") and the frames (mouth
   open, head turned, gestures). `editkit track --segments ...` can confirm: the speaker usually
   moves more than the listener. When unsure, stay on the person whose words are on screen.
3. `editkit speakerpath --source RAW --keys "0:0.28,6.4:0.71,14.2:0.28"` (OUTPUT seconds after your
   cuts) prints the crop expression; pass it to `editkit reframe --source RAW crop --x-expr "..."`.
   Use `--ease 0.25` for a quick glide or `--ease 0` for hard cuts on fast back-and-forth.
4. Don't ping-pong: hold a speaker for at least ~1.5 s; a one-word interjection stays on the
   current speaker. A reaction shot of the listener at the payoff is a strong move when it's real.
5. Two people in one wide shot both reacting at the payoff: `stack` both faces (top/bottom) for
   that beat, or `blurfill` if they're too close to separate.
6. `--preview T` and look: eyes in the upper third, nobody's face cut off by the crop edge, safe
   zones respected.

## 5. Captions
Captions carry a talking Short. Word-by-word (`--style pop` or `karaoke`), large, 2–4 words per
line, centred in the lower-middle (inside the safe zone), the key word emphasised. Every word
checked against the audio; fix names and terms with `--replace`. Hindi and Hinglish speech are
written in Latin letters (see the playbook).

## 7. Sound
Voice first: clean and level it (`audiomix`), -14 LUFS. Music only as a quiet bed under a
story (well below the voice) or not at all. Sound effects are rare: at most one or two accents
(a whoosh into the cold open, a soft hit on the punchline). No meme sounds over someone's
serious point.

## SEO
Title the idea, not the show: the claim, question or reveal, searchable phrase first. Credit the
show/channel and link it in the description, exactly as the playbook says for streamers.
