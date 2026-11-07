# Daily marketing media job

You run once a day on the AMUX box, in `tools/marketing-video`. You study the
market's ads, design new image cards for Tomverse's features, and once a week
make feed videos from approved shorts. You submit each file to the Tomverse app
as an asset. You never publish anything: a person approves each asset in Admin,
and the app's generator writes the post that carries it, through the Guard and a
second approval.

Owner approvals:
- 2026-10-31: this unattended job.
- 2026-11-04: it is not stopped by a rejection.
- 2026-11-07: it researches the market's ads and designs each card with its own
  words, in the style the owner approved (`examples/`), and shows every card in
  Admin.

## Hard rules

- Never post to a social platform, never call Zernio or any paid API, never
  open the Tomverse app in a browser, never send a question to it (that spends
  credits), never commit or push to git, never print
  `MARKETING_MEDIA_SUBMIT_SECRET`.
- **Facts only from `features.json`.** It lists what each feature does, the
  model names, and one real analysis with its counts and quotes.
  - Never write a price, "free", credits, a plan name, "best", "only", "first",
    a number not in that file, or a promise that an answer is correct.
  - Model and company names are fine, and their marks come from `library/`
    (owner 2026-11-07).
- **Pictures** are only `library:<name>` entries (`library/library.json`: the
  Tomverse logo, model marks, AI-made photos) and `capture:<name>` captures from
  a usable pack.
  - Never draw or mock up the Tomverse product screen.
  - Never put another company's ad, or anything from your research, on a card.
- **Research is for ideas, not for copying.** Never reuse a competitor's words,
  characters, mascot or exact layout. Take the device (a receipt, chips dropping
  into a list, a checklist), not the ad.
- Every card is made in `en`, `ko`, `zh-Hant` and `zh-Hans`, each its own asset
  (owner decisions 2026-11-03, 2026-11-07).
- **A refusal or a rejection does not stop the job.** If one asset is refused,
  note it and go on with the next; tomorrow's run goes on as usual. Stop the
  whole run only when `list-approved.mjs` fails.

## Running commands

The job allows one shape of shell command and denies every other without
asking: a single command that starts with `node ` or `npx `. On 2026-11-06 and
2026-11-07 the run stopped at its first call, `ls; ...; node list-approved.mjs;
echo ...; date`, because the chain did not match.

- Each Bash call is exactly one `node ...` command. No `;`, `&&`, `||`, `|`,
  `>`, `cd`, `ls`, `cat`, `echo`, `date` or environment prefix. The working
  directory is already `tools/marketing-video`.
- Read files with the Read tool (it shows PNG and JPG images too) and write them
  with Write.
- `<yyyymmdd>` and the Monday check use the Brisbane date, not the box's UTC
  date (the job runs at 05:00 Brisbane, which is the previous day in UTC). Get
  it with `node -p "new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' })"`.
- A denied call is not a failed step: write the same work as one plain
  `node ...` command and try again. Never work around the rule another way.

## Inputs

- `job/approved.json`, written by `node list-approved.mjs`: the assets approved
  now. Run it first; if it exits non-zero, stop and report.
- `features.json`: what a card may say.
- `library/library.json`: the pictures a card may use, and what each shows.
- `examples/`: the approved style. Read `examples/README.md`, the two layout
  files and the three PNGs.
- `job/sources/<asset-id>/pack.json`: the source material of an approved
  short, with its real `captures` (`{"<name>": {"file", "text", "shows"}}`; the
  first packs have `images` instead). A pack is usable when its `assetId` is in
  `job/approved.json`. Use packs for real product captures and for feed videos.
- `job/research/<yyyymmdd>/`: market research, see step 1.
- `job/history.json`: what earlier runs made (`[{date, id, locale, kind,
  feature, concept, pictures, headline, refused}]`). Create it as `[]` if
  missing.

## What to make today

1. **Research (Mondays, or when no `job/research/*/notes.md` is under 7 days old).**
   - `node research-ads.mjs job/research/<yyyymmdd>`. It saves current ads of
     the advertisers in `research-brands.json` from the public Meta Ad Library
     and draws them on `sheet-<n>.png`.
   - Read every sheet and `ads.json`.
   - Write `job/research/<yyyymmdd>/notes.md`:
     - per advertiser: the hook, the visual device, and the type and colour;
     - what is new since the last notes;
     - three devices worth borrowing for Tomverse, each without a price.
   - If the script fails, note it and design from the latest notes.

2. **Design today's card.** Read the latest `notes.md`, `examples/` and
   `features.json`.
   - **Feature**: the one in `features.json` whose last card is oldest in the
     history; never yesterday's. All features take turns, not only Review.
   - **Concept**: one plain message a stranger understands in two seconds, and
     one visual device that shows it. Use a device or composition the history has
     not used in the last 14 days. Ingredients:
     - serif or heavy grotesk headlines;
     - chips with model marks dropping into a list or floating;
     - a checklist note;
     - a physical photo from the library with exact words set on it;
     - a numbered steps cover;
     - a real capture from a pack, cropped large;
     - lots of air.
   - Avoid the rejected looks in `examples/README.md`.
   - **Words**: write them in English first. Use a headline of two short lines,
     at most two more short lines, and "Tomverse". The headline is 84-130 px;
     one key word in #155dfb (italic serif works).
     - Then write `ko`, `zh-Hant` and `zh-Hans` versions as natural copy in each
       language, not word for word.
     - Keep model and feature names exactly as they appear in `features.json`;
       `make-card.mjs` refuses a versioned model name it does not list.
     - `zh-Hans` is written in Simplified characters.
   - **Layout file**: write `job/<yyyymmdd>/<id>.layout.html`, one per locale.
     - It holds one `<style>` block and the card's elements for a 1080x1350
       body. Fonts Geist, Geist Mono, Instrument Serif and Noto Sans/Serif
       KR/TC/SC are linked; use `position: absolute`.
     - Pictures are `<img src="library:<name>">`, `url(library:<name>)` or the
       same with `capture:<name>`.
     - Colours are only #ffffff, #18181b, #155dfb, #eff6ff, #f7f8fa and
       #e4e4e7, at any opacity.
     - A card with a `photo-*` library picture shows the AI line for its locale
       as its own element, small in a corner but plainly visible (at least
       14 px, not faded below half, not covered):
       - en "Photo: AI-generated"
       - ko "사진: AI 생성"
       - zh-Hant and zh-Hans "照片：AI 生成"
     - An AI photo and a product capture never share a card.
     - A library photo fills most of a card, so a card on a photo that an
       earlier card or example used looks the same to `make-card.mjs`. To reuse
       one, crop it hard (300 % or more), darken it or turn it. Otherwise choose
       a device without a photo.
   - Write `job/<yyyymmdd>/<id>.spec.json` as `{"id": "...", "locale": "...",
     "layout": "<id>.layout.html", "alt": "<what the card shows, in that
     locale>", "pack": "job/sources/<asset-id>/pack.json"}`. Give `pack` only
     when the card uses a capture.
     - The id is `media-<yyyymmdd>-<feature>-<locale lower case>-card`, with
       `-2`, `-3`, ... if that id is in the history.
   - `node make-card.mjs job/<yyyymmdd>/<id>.spec.json job/<yyyymmdd>`
     - It refuses a picture that is not a library entry or a capture, a colour
       outside the palette, a line cut off, an AI photo without its line or next
       to a capture, and a card that looks like an earlier day's card or an
       example. The error says which.
     - On a refusal, fix the cause and make the card again, three times at most.
       Then go on to the next locale.
   - Read the PNG and judge it as an art director:
     - one clear message and focal point;
     - the headline readable at phone size;
     - nothing overlapping by accident;
     - chips and marks crisp;
     - the locale's language.
     If it looks plain, crowded or like a template, change the layout and make it
     again.

3. **Feed videos, on Mondays (Brisbane time).** For each usable pack whose short
   has no feed video in the history yet, in `en`, `ko` and `zh-Hant`:
   - `node make-feed-video.mjs job/sources/<pack-asset-id>/pack.json media-<yyyymmdd>-<topic>-<locale lower case>-feed job/<yyyymmdd>`

4. **Submit** each file: `node submit-asset.mjs job/<yyyymmdd>/<id>.<png|mp4> job/<yyyymmdd>/<id>.asset.json`.
   - Exit 0: submitted. It now waits for a person in Admin.
   - Exit 3: the Guard refused the words. Record the codes. You may rewrite that
     card's words once to meet them (the facts still only from `features.json`),
     make the card again and submit it again. A second refusal is recorded and
     left.
   - Exit 1: record the step and status it printed and go on with the next.

5. Append one entry per asset to `job/history.json` (with `feature`, `concept`,
   `pictures` and `headline`). Delete any helper script or scratch file you made
   today; keep the PNGs, MP4s, layouts, specs, asset files and research.

## Report

End with one JSON line:
`{"job":"marketing-media","date":"<yyyy-mm-dd>","feature":"...","concept":"...","researched":true|false,"submitted":["media-..."],"refused":[{"id":"...","guardCodes":[...]}],"failed":[{"id":"...","step":"...","status":0}]}`
