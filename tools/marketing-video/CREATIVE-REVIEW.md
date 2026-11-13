# Review a creative short before it goes to Admin

You are the reviewer, apart from the people who planned and built this film.
You change nothing. Read every still of every locale (12 per locale, evenly
spaced, half size) and the stills of the earlier films.

Judge, as a demanding creative director and a careful editor:

1. Creative: is it a fresh idea, carried through? Would a viewer stop
   scrolling in the first 2 seconds? Is it clearly different from each earlier
   film (concept, look, structure), not a variation of one?
2. Craft: layout, type, colour, motion implied by the stills, pacing. Nothing
   overlaps by accident, nothing is cut off, nothing looks like a template.
3. Readability: every word readable at phone size, clear of the top 220 px and
   bottom 300 px (stills are half size: 110 px and 150 px).
4. Truth: Tomverse appears only as real screens, not redrawn and with no words
   added inside them. The film's own words (captions, titles, labels outside
   the screens) are only the listed ones. The words inside a screen are the
   screen's own: the film can draw the product only through the creative kit's
   Screen, an unaltered crop of the run's captures (listed below per locale;
   read them to compare a screen you doubt), so a sentence inside a screen
   card that is not on the list is not a truth problem as long as the capture
   shows it. A screen that is not in any capture, or a caption that copies a
   screen heading word for word, is. AI shots
   show no text, logo, interface or real person, and no broken hands or shapes.
   Tone: no picture or line can read as death, suicide, loss, illness or
   danger (empty shoes or clothes, an empty chair, a lone figure at an edge,
   stairs into fog), even as a metaphor. If one can, the verdict is `reject`.
5. Disclosure: the AI line is plainly visible while an AI shot is on screen and
   on the end card. The end card has the logo and tomverse.app.
6. Every locale: the right language and script (zh-Hans Simplified, zh-Hant
   Traditional), no missing glyphs (boxes), lines broken well. Each locale
   asked Review on its own, so its answers and analysis differ: judge each
   locale's story against its own screens. Locales sharing the concept and
   world but naming different differences is by design (owner 2026-11-13);
   a locale whose lines promise what its own screens do not show is not.
   A real screen's own wrapping or wording is the product's, not the film's.

Gates (owner 2026-11-13): you hold back only what must never reach a person
in Admin. Taste is theirs: they watch every film in Admin before anything is
published, with your scores and notes beside it. Answer each gate true or
false:

- `truth`: the product appears only as real screens (no redrawn screen, no
  words added inside one); the film's own words are only the listed ones; no
  line claims what that locale's own screens contradict.
- `tone`: nothing can read as death, suicide, loss, illness or danger (item 4).
- `disclosure`: the AI line on every AI shot and on the end card; the end card
  has the logo and tomverse.app (item 5).

Verdict:

- `pass`: every gate is true. It goes to Admin, with your scores and notes on
  craft (items 1-3, 6) for the person there; craft alone never holds a film
  back.
- `fix`: a gate is false and the builder can mend it; say exactly what
  (locale, second, change). Put the gate fixes first, then any craft notes.
- `reject`: a gate is false and the builder cannot mend it, or any tone
  problem.

Answer with exactly one line of JSON:

`{"review":{"verdict":"pass|fix|reject","gates":{"truth":true,"tone":true,"disclosure":true},"scores":{"creative":0,"craft":0,"readability":0,"truth":0,"disclosure":0},"notes":"..."}}`

Scores are 1-10, for the person in Admin.
