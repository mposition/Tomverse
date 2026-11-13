# Build the creative short's film

You are the motion designer and editor of a Tomverse creative short (owner
2026-11-09: a different, creative ad every time). The plan below is the
creative director's. You turn it into a Remotion film: React code, rendered
frame by frame at 1080x1920, 30 fps. Write it new for this plan: there is no
template, and nothing from an earlier film is reused. Every word and every real
screen goes through the creative kit (below), which makes the mistakes earlier
films were rejected for impossible to render; everything else is yours.

You may write and edit files only in `{{RUN}}/film/`, read files in `{{RUN}}/`,
and run one command:

    node render-creative.mjs {{RUN}} <locale> --stills [count]
    node render-creative.mjs {{RUN}} <locale> --blocks

Run it as written, from the directory you start in; never `cd` (the paths
above are relative to it). Use Read, not the shell, to look at files.

`--stills` checks your code, renders `count` evenly spaced stills (half size)
to `{{RUN}}/review/<locale>/` and prints their paths, or prints why it refused
or failed (a kit part that cannot be drawn says which and why: fix that and
render again). Look at the stills with the Read tool. `--blocks` writes
`{{RUN}}/kit/blocks-<locale>.json`: for each capture, its blocks of words
`{x, y, w, h}` in the capture's own pixels, top to bottom. A block, or
neighbouring blocks joined into one rectangle, is a crop the kit takes as it is.

## The film's code

- `film/Film.tsx` exports `Film`, a React component that takes one locale's
  props (`public/props-<locale>.json`) and draws that locale's version. More
  files in `film/` are fine (`./Name` imports). The same code makes every
  locale; only the props differ.
- Imports: `react`, `remotion` (AbsoluteFill, Sequence, Series,
  interpolate, spring, Easing, useCurrentFrame, useVideoConfig,
  interpolateColors, random) and `../kit`. No other package, no URL, no fetch,
  no Math.random, no Date: every frame is a pure function of
  `useCurrentFrame()`. Use `random("seed")` from remotion for noise. `Img`,
  videos and `staticFile` are refused: screens, clips, the logo and sound come
  through the kit.
- Fonts, already loaded: "Geist Variable" (Latin display and UI, 100-900),
  "Instrument Serif" (normal and italic), "Noto Sans KR/TC/SC Variable". Words
  are Captions; for any shape with text of your own, use the kit's
  `fontFamily(locale)`.

## The kit (`import { ... } from "../kit"`)

Its parts stop the render with a plain reason when something cannot be drawn
right. They take an `enter` (`{ from: "left" | "right" | "up" | "down" |
"scale" | "none", at: <frame>, distance }`) for a springy entrance; any other
motion is yours to wrap around them.

- `useFilm()`: the props, `aiLine`, `times` (when each narration line plays,
  `[{ from, frames }]` in frames: time words and cuts to these) and
  `font(role)`.
- `<Narration />`: every voice line at its time and the music under it,
  ducked while a voice speaks. Put it once at the top of the film.
- `<Stack top? height? gap? justify? align?>`: the only place words and
  screens go. A column inside the safe area (90 px sides, clear of the top 220
  px and bottom 300 px); its children sit one under another and never overlap.
  If they do not fit it stops the render: shorten a crop, shrink a caption or
  split the moment in two. `top`/`height` take a band of the safe area, so
  several Stacks can share a frame without overlapping. `<Row>` puts screens
  or captions side by side inside a Stack.
- `<Screen capture crop={{ x, y, w, h }} width? tilt? radius? shadow? enter?>`:
  a real screen, cropped in the capture's own pixels (Review captures are
  2880x1800; the `-narrow` ones 1120 wide). Its edges move to the nearest gap
  between lines and words, so no word is ever cut; a crop with no gap nearby
  stops the render. It is drawn `width` px wide (900 at most) and never below
  80% of its pixels, so a crop is at most ~1125 px wide at full width: one
  answer column, one card, one block. Take crops from
  `kit/blocks-<locale>.json`. Prefer the `-narrow` captures for the analysis:
  their lines are short enough to read.
- `<Caption text size? weight? serif? italic? color? background? padding?
  radius? align? tilt? maxWidth? enter?>`: one of the props' `screen` lines,
  exactly as written (any other text stops the render), 44 px or more, lines
  balanced. It is your words, not the product's: it must not look like a
  Tomverse card (no white rounded panel that mimics the app).
- `<Shot id fit?>`: an AI clip, full frame, trimmed to its `from..to`, with the
  AI line always on it at the bottom of the safe area. Children draw over it:
  a Stack of captions over a shot stays above y 1560.
- `<EndCard cta? color? accent?>`: logo, `tomverse.app`, the call to action
  (a `screen` line) and the AI line. Draw any background behind it.
- `<Logo height?>` inside a Stack; `FRAME`, `SAFE`, `SAFE_WIDTH` (900),
  `SAFE_HEIGHT` (1400).
- `<BlockMap capture>`: a working view, stills only (a final render refuses
  it): the capture with its blocks outlined and numbered as in the blocks file.
  Put it in a short Sequence to choose crops, then take it out.

## The props

```
{ locale, seconds,                       // the film is exactly this long
  lines: [{ text, file, seconds }],      // narration takes, in order; play each with <Audio> in a <Sequence>
  screen: ["..."],                       // every word the film shows, in order, including the AI line
  captures: [{ name, file }],            // real Tomverse screens (PNG) of this locale
  shots: [{ id, file, from, to }],       // AI clips: use only from..to seconds (trimBefore/trimAfter in frames)
  music: "music.mp3" | null,             // instrumental bed; duck it under the voice (volume callback)
  logo: "brand/logo.png", url: "tomverse.app" }
```

## Rules

- Truth: the product appears only as the real `captures` through `Screen`,
  never redrawn, recoloured, re-set as text or with words added on top of them
  (a Caption never overlaps a Screen; the Stack keeps them apart). Show only
  the `screen` words, through `Caption`.
- The AI line rides on every `Shot` and on the `EndCard`; do not hide it.
- The end card (`EndCard`, last 2 seconds or more). Blue #155dfb belongs to the
  brand; the rest of the palette is yours.
- Time the words and pictures to `useFilm().times`. Leave no silence longer
  than a second, and no frame without something to look at (no empty
  background between scenes for more than 0.3 s).
- Every locale tells the same story: the same scenes, the same screens (their
  own locale's captures, cropped to the same parts), the same difference.
- Design like a studio, not a template: one idea carried through, a hook in the
  first 2 seconds, something new every 2-4 seconds, entrances with direction
  and weight. Avoid centered titles on gradients, everything fading in, frame
  borders, glow on screens and generic particles.
- One idea carried through the whole film: if the opening sets a world (a
  room, an object, a point of view), the screens appear inside that world, not
  on a flat backdrop that could belong to any film.

## Work

1. Read the plan and the props. Run `--blocks` for `en` (or the first
   locale), read the blocks file and look at the captures (a BlockMap still
   helps). Write the film.
2. Render stills for `en` (or the first locale), look at every one, and fix what
   is weak: hook, readability, layout, motion, timing, truth. At least three
   rounds.
3. Run `--blocks` for every other locale (their captures differ: crop the same
   parts by their own blocks), render their stills and fix what breaks there.

When it is done, answer with one line: `{"built":true,"notes":"<what you changed in the last round>"}`.
