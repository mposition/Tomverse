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
  own asset (owner decision 2026-11-03).
- **A refusal or a rejection does not stop the job.** If one locale's asset is
  refused, note it and go on with the next; tomorrow's run goes on as usual.
  Stop the whole run only when `list-approved.mjs` fails or no pack is usable.

## Inputs

- `job/approved.json`, written by `node list-approved.mjs`: the assets approved
  now (id, kind, channels, locales). Run it first; if it exits non-zero, stop
  and report.
- `job/sources/<asset-id>/pack.json`: the source material of one approved
  short, kept on the box beside its captures. `locale`, `topic`, `question`
  (two lines), `images` (`left`, `center`, `right`, `summary`, `logo`),
  `summaryText`, `headlines` (pairs of lines), `callouts`, `ctas`, `cardAlt`,
  and `video` / `videoAsset` (the approved short and its asset file).
- `job/history.json`: what earlier runs made (`[{date, id, locale, kind,
  source, headline, callout, refused}]`). Create it as `[]` if missing.

A pack is **usable** when its `assetId` is in `job/approved.json`. Use only
usable packs.

## What to make today

1. **Image cards, every day.** Pick one topic that has a usable pack in all
   three locales; prefer the topic whose last card is oldest in the history.
   For each locale:
   - Pick a headline pair, a callout and a call to action from that locale's
     pack, choosing the headline pair used least recently in the history (never
     the same pair two days running) and a callout that does not repeat the
     headline's words.
   - Write `job/<yyyymmdd>/<id>.spec.json` as
     `{"id": "...", "headline": ["...", "..."], "callout": "...", "cta": "..."}`
     with the lines copied exactly. The id is
     `media-<yyyymmdd>-<topic>-<locale lower case>-card`, with `-2`, `-3`, ...
     if that id is in the history.
   - `node make-card.mjs job/sources/<pack-asset-id>/pack.json job/<yyyymmdd>/<id>.spec.json job/<yyyymmdd>`
   - Read the PNG with the Read tool: every line is whole, nothing overlaps the
     wrong element, the language is the locale's. If it is not, pick another
     headline pair and make it again (twice at most).
2. **Feed videos, on Mondays (Brisbane time).** For each usable pack whose short
   has no feed video in the history yet, in all three locales:
   - `node make-feed-video.mjs job/sources/<pack-asset-id>/pack.json media-<yyyymmdd>-<topic>-<locale lower case>-feed job/<yyyymmdd>`
3. **Submit** each file: `node submit-asset.mjs job/<yyyymmdd>/<id>.<png|mp4> job/<yyyymmdd>/<id>.asset.json`.
   - Exit 0: submitted.
   - Exit 3: the Guard refused the transcript. Record it as refused with its
     codes and go on; do not change the words.
   - Exit 1: record the step and status it printed and go on with the next.
4. Append one entry per asset to `job/history.json`, and delete any helper
   script or scratch file you made today (keep the PNGs, MP4s, specs and asset
   files).

## Report

End with one JSON line:
`{"job":"marketing-media","date":"<yyyy-mm-dd>","topic":"...","submitted":["media-..."],"refused":[{"id":"...","guardCodes":[...]}],"failed":[{"id":"...","step":"...","status":0}]}`
