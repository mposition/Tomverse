# Daily marketing media job

You run once a day on the AMUX box, in `tools/marketing-video`. You make new
image cards, and once a week feed videos, **only from assets a person already
approved**, and submit them to the Tomverse app as assets. You never publish
anything: a person approves each asset in Admin, and the app's generator writes
the post that carries it, through the Guard and a second approval. Owner
approval for this unattended job: 2026-10-31; built on approved assets, and
not stopped by a rejection: 2026-11-04.

## Hard rules

- Never post to a social platform, never call Zernio or any paid API, never
  open the Tomverse app in a browser, never send a question to it (that spends
  credits), never commit or push to git, never print
  `MARKETING_MEDIA_SUBMIT_SECRET`.
- New words are not yours to write. A card's lines are picked from the source
  pack's `headlines`, `callouts` and `ctas`, which are the approved short's own
  on-screen lines; `make-card.mjs` refuses any other line. A feed video is the
  approved short, unchanged.
- Pictures are the pack's real captures only. Never draw, generate or mock up
  the product screen, and never make a new Remotion short from scenes (the
  owner rejected that style on 2026-10-31).
- Every asset is made in all three locales, `en`, `ko` and `zh-Hant`, each its
  own asset (owner decision 2026-11-03). Image cards are also made in `zh-Hans`
  for RedNote, from the zh-Hant pack (owner decision 2026-11-07): see step 1.
- **A refusal or a rejection does not stop the job.** If one locale's asset is
  refused, note it and go on with the next; tomorrow's run goes on as usual.
  Stop the whole run only when `list-approved.mjs` fails or no pack is usable.

## Running commands

The job allows one shape of shell command and denies every other without
asking: a single command that starts with `node ` or `npx `. On 2026-11-06 and
2026-11-07 the run stopped at its first call, `ls; ...; node list-approved.mjs;
echo ...; date`, because the chain did not match.

- Each Bash call is exactly one `node ...` command. No `;`, `&&`, `||`, `|`,
  `>`, `cd`, `ls`, `cat`, `echo`, `date` or environment prefix. The working
  directory is already `tools/marketing-video`.
- Read files with the Read tool and write them with Write. The paths you need
  are all known: `job/approved.json`, `job/history.json`, and
  `job/sources/<asset-id>/pack.json` for each id in `job/approved.json`.
- `<yyyymmdd>` and the Monday check use the Brisbane date, not the box's UTC
  date (the job runs at 05:00 Brisbane, which is the previous day in UTC). Get
  it with `node -p "new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' })"`.
- A denied call is not a failed step: write the same work as one plain
  `node ...` command and try again. Never work around the rule another way.

## Inputs

- `job/approved.json`, written by `node list-approved.mjs`: the assets approved
  now (id, kind, channels, locales). Run it first; if it exits non-zero, stop
  and report.
- `job/sources/<asset-id>/pack.json`: the source material of one approved
  short, kept on the box beside its captures. `locale`, `topic`, `question`,
  `headlines` (pairs of lines), `callouts`, `ctas`, `cardAlt`, `video` /
  `videoAsset` (the approved short and its asset file), and `captures`:
  `{"<name>": {"file", "text", "shows"}}`, the real screen captures, the words
  in each, and what each shows. The first packs have `images` (`left`,
  `center`, `right`, `summary`, `logo`) instead; those are their captures.
- `job/history.json`: what earlier runs made (`[{date, id, locale, kind,
  source, topic, concept, captures, headline, refused}]`). Create it as `[]` if
  missing.

A pack is **usable** when its `assetId` is in `job/approved.json`. Use only
usable packs.

## What to make today

1. **Image cards, every day.** Each day's card must look new (owner
   2026-11-07: "no image that only changes its words"; every card made from one
   fixed layout was retired). You design each card yourself.
   - **Topic**: pick the topic (a feature) with a usable pack in all three
     locales whose last card is oldest in the history, so the features take
     turns; never yesterday's topic when another one is usable.
   - **Concept**: pick a composition the history has not used for this topic
     in the last 7 days. Ideas, all built from the pack's real captures:
     - *highlighter*: one capture cropped to 200-300 %, a single line of it
       crossing the card, the rest faded under a white gradient;
     - *floating map*: one capture tilted 5-8 degrees in 3D on #18181b, deep
       shadow, a soft #155dfb glow behind it;
     - *split*: two or three captures side by side as tall strips, the strips
       not being read darkened under #18181b at 60 %;
     - *hero pill*: the question or input part of a capture large across the
       middle, the next step's capture peeking from below;
     - *clash*: two captures that disagree overlapping at opposite angles;
     - *flow*: one capture leading to two or three others, thin #155dfb lines.
     Change the background (white, #f7f8fa, #eff6ff, #155dfb, #18181b) and which
     captures you use from day to day. Do not draw what looks like a product
     screen, a button, a price, another company's logo or a chat window; the
     product is shown only by the captures.
   - **Words**: one headline pair from the pack, the pair used least recently
     for this topic, and at most one more line (a callout or a call to action).
     Few words, very large: a headline line is 96-150 px and heavy (800-900);
     one of its two lines, or the line's key word set as its own line, in
     #155dfb. Leave room: no more than three pieces of text besides "Tomverse".
   - **Layout file**: write `job/<yyyymmdd>/<id>.layout.html`: one `<style>`
     block and the card's elements for a 1080x1350 body (fonts Geist and Noto
     Sans KR/TC/SC are already linked; use `position: absolute`). Pictures are
     `<img src="capture:<name>">` or `background-image: url(capture:<name>)`,
     cropped with `object-fit` / `object-position` or background size and
     position. Each pack line goes whole into one element of its own, copied
     exactly (no `<br>` or `<span>` inside a line). Colours only #ffffff,
     #18181b, #155dfb, #eff6ff, #f7f8fa, #e4e4e7, at any opacity. Put the logo
     capture (if the pack has one) and the word "Tomverse" small in a corner.
   - Write `job/<yyyymmdd>/<id>.spec.json` as `{"id": "...", "layout":
     "<id>.layout.html"}`. The id is `media-<yyyymmdd>-<topic>-<locale lower
     case>-card`, with `-2`, `-3`, ... if that id is in the history.
   - `node make-card.mjs job/sources/<pack-asset-id>/pack.json job/<yyyymmdd>/<id>.spec.json job/<yyyymmdd>`
     It refuses a word that is not the pack's, a picture that is not a capture,
     a colour outside the palette, a line cut off, and a card that looks like
     one of an earlier day (the error says which). On a refusal, fix the cause
     and make it again (three times at most), then go on to the next locale.
   - Read the PNG with the Read tool and judge it as an art director: one clear
     focal point, the headline readable at phone size, captures sharp and not
     stretched, nothing overlapping by accident, the locale's language. If it
     looks plain or crowded, change the layout and make it again.
   - Use the same concept for the topic's cards in all locales of the day
     (each with its own pack's captures and lines).
   - Then one more card, `zh-Hans`, from the same topic's **zh-Hant** pack: the
     zh-Hant layout with `"locale": "zh-Hans"` added to its spec. The layout
     names that pack's lines exactly as they are (Traditional); `make-card.mjs`
     draws them in Simplified itself. Never convert or write the Simplified lines
     yourself. The id ends in `-zh-hans-card`.
2. **Feed videos, on Mondays (Brisbane time).** For each usable pack whose short
   has no feed video in the history yet, in all three locales:
   - `node make-feed-video.mjs job/sources/<pack-asset-id>/pack.json media-<yyyymmdd>-<topic>-<locale lower case>-feed job/<yyyymmdd>`
3. **Submit** each file: `node submit-asset.mjs job/<yyyymmdd>/<id>.<png|mp4> job/<yyyymmdd>/<id>.asset.json`.
   - Exit 0: submitted.
   - Exit 3: the Guard refused the transcript. Record it as refused with its
     codes and go on; do not change the words.
   - Exit 1: record the step and status it printed and go on with the next.
4. Append one entry per asset to `job/history.json` (with `topic`, `concept`
   and the `captures` it used), and delete any helper
   script or scratch file you made today (keep the PNGs, MP4s, specs and asset
   files).

## Report

End with one JSON line:
`{"job":"marketing-media","date":"<yyyy-mm-dd>","topic":"...","submitted":["media-..."],"refused":[{"id":"...","guardCodes":[...]}],"failed":[{"id":"...","step":"...","status":0}]}`
