# Spikecut rebrand and first-run tour: design

**Intent.** Give the desktop app a name and a look worthy of shipping to creators, add motion that makes
it feel alive, and teach new users the whole product on first launch.

**Decided with the owner**
- Name: **Spikecut** ("Catch the spike. Cut the Short."). Chosen over Hypereel and Peakframe.
- Look: light and clean. The window stays see-through (Windows acrylic, light tint) with frosted white panels.
- Animation: the Motion library (`motion`, one new dependency in `app/`, approved by the owner).
- Rename scope: everything a user sees. Internal names (`clipwatcher` package, `localtube` names, data
  folders, the Electron user-data folder) are unchanged so recordings, upload history and the YouTube
  sign-in keep working.
- A professional, descriptive tour that opens on first run and from a "Take the tour" button.

**Approaches considered**
- Animation: Motion (smooth page transitions, layout animation for the sidebar highlight, counters)
  vs CSS only (no dependency, but no transitions between pages). Motion picked.
- Rename: visible only vs everything including internals (needs a data move and a YouTube re-login).
  Visible only picked.

**Design**
- Mark: violet gradient tile, a chat line that spikes upward, a diagonal slash cutting the peak, a coral
  live dot. `app/build/icon.svg` is the source; `npm run icons` renders PNGs and the `.ico`.
- Tokens: Tailwind's indigo scale retinted to spike violet; coral for live only; Segoe UI Variable.
- Shell: sidebar grouped into Create / Publish / System, sliding active highlight, Take the tour, status card.
- Motion: staggered page entrance, page fade between routes, counters that count up, ripple on live dots,
  hover lift on stat and Short cards, spring-animated chat bars, a splash screen whose logo draws itself.
  `MotionConfig reducedMotion="user"` and a CSS `prefers-reduced-motion` block switch it off.
- Tour: 15 steps (welcome, the five stages, each sidebar page, four steps to a first Short). Each step
  opens its page and glows its sidebar item. Remembered as `tourSeen` in the upload server's settings
  (not browser storage: the app's port, and so its browser origin, changes on every launch).

**Non-goals.** No page changes behaviour; no new pipeline features; no installer in this change.
