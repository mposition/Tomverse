# Marketing video renderer

Renders the marketing agent's videos from one scene list: `Short` (1080x1920,
for Instagram Reels, YouTube Shorts, TikTok and X) and `Long` (1920x1080, for
YouTube). Owner direction 2026-10-31: short-form and long-form video, made on
the AMUX box by the Claude Code CLI, submitted to the app as assets, and
published only after the Guard and a person's approval in Admin.

Its own package, outside the app build, the npm workspaces and the root
`tsconfig.json`/ESLint, like `.railway/`. Install it where it runs:

```
cd tools/marketing-video && npm ci && npx remotion browser ensure
```

## Use

```
node capture.mjs https://tomverse.app/ job/screen.png portrait
node render.mjs job/props.json Short job/short.mp4
```

`props.json` follows `src/schema.ts`: a locale (`en`, `ko`, `zh-Hant`) and
scenes of three kinds:

- `title` and `cta`: words on the brand background (`headline`, `subline`).
- `capture`: a real recording or still of the product, named by file beside
  `props.json` (`media`). Pictures of the product screen are real captures
  only; an AI-made one is refused (docs/policy/marketing-automation.md §7.3).

Each scene may carry a `caption`, burned in so the video works muted. Line
breaks in a headline are kept, and Korean and Chinese break between words.

## Chapters on a long video

Owner decision 2026-11-07: a long YouTube tutorial carries chapters so a viewer
can skip to a section. They are the video's own times, so they come with the
asset, never from the post's model. Add them to the asset file beside
`transcript`:

```json
"chapters": [
  { "startSeconds": 0, "title": { "en": "What you will build" } },
  { "startSeconds": 42, "title": { "en": "Ask three models at once" } },
  { "startSeconds": 128, "title": { "en": "Compare the answers" } }
]
```

The app refuses them unless they are YouTube's: at least 3 (at most 20), the
first at 0, each at least 10 seconds after the one before, and the last at least
10 seconds before the end. `submit-asset.mjs` rounds the length up to a whole
second, so leave the last chapter a second more than that. Every chapter needs
a title, one line of at most 60 characters with no `#`, in each locale the asset
has alt text for. The Guard reads the titles with the transcript. When the generator
writes the YouTube post for the video, the app adds the list (`00:00 Title`, one
line each) to the end of the description before the Guard reads the post and a
person approves it. A video with chapters, or longer than 60 seconds, is
long-form, and its post carries no `#Shorts`.

## Researched cards and feed videos

Owner decisions:
- 2026-11-04: a rejection does not stop the daily job.
- 2026-11-07: the job researches the market's ads and designs each card with
  its own words in the approved style, and a person sees every card in Admin
  before anything is posted.

```
node list-approved.mjs                                  # job/approved.json
node research-ads.mjs <out-dir>                         # public Meta Ad Library: ads + contact sheets
node make-card.mjs <spec.json> <out-dir>                # 4:5 image card + asset file
node make-feed-video.mjs <pack.json> <id> <out-dir>     # 4:5 feed version of the short
```

- `research-ads.mjs` saves a few current ads of each advertiser in
  `research-brands.json`, a still for a video, and contact sheets. No login,
  nothing posted. `run-daily.sh` fetches them. A separate CLI call
  (`RESEARCH.md`) reads them. That call has only the Read tool, on
  `job/research-raw/`, and no submission secret, and it answers with structured
  notes. `check-research-notes.mjs` writes those notes only in the agreed
  shape, with brands from `research-brands.json` and no run of five words from
  an ad. The raw ads are then deleted, so the call that writes copy sees only
  checked notes (docs/policy/marketing-automation.md §2).
- The job writes words from `features.json` and pictures from
  `library/library.json`: the logo, model marks (owner 2026-11-07) and AI-made
  photos. It can also use real captures from a source pack
  (`job/sources/<asset-id>/pack.json`, on the box only). `examples/` holds the
  approved style.
- `make-card.mjs` puts every visible word in the transcript the Guard judges at
  submission. It refuses:
  - a picture that is not a library entry or a capture;
  - a colour outside the brand palette;
  - cut-off lines;
  - an AI photo without the locale's AI line, or beside a product capture;
  - a look an earlier day or an example already used.

  Tests: `tests/marketingMediaMakeCard.test.mjs`.
- `make-feed-video.mjs` renders the `Feed` composition: the approved short,
  whole, on a 1080x1350 frame.

## The daily job

`run-daily.sh` runs the Claude Code CLI on `JOB.md` once a day on the AMUX box
(owner approval for the unattended job, 2026-10-31). It makes cards and feed
videos from approved source packs and submits them with `submit-asset.mjs`,
which, like `list-approved.mjs`, needs `MARKETING_APP_URL` and
`MARKETING_MEDIA_SUBMIT_SECRET` (`~/.config/tomverse/marketing-video.env` on the box, mode 600, never in git; the box user has no sudo). The app
runs the Guard over each transcript; a refusal comes back as exit 3 with the
Guard codes; the job records it and goes on. Nothing here publishes: a person approves the
asset in Admin, and the app's generator, whose calls go through the LLM cost
ledger, writes the post that carries it for a second approval. The job does
not submit posts: the draft intake takes only drafts backed by ledger calls.
Each run's whole CLI stream stays in `job/run-<yyyymmdd>.jsonl` (not in git); the
log gets the final answer and one `marketing_media_job_run` line on how it ended.

Cron on the box (05:00 Brisbane, before the generator's run, so its assets can be approved first), against production:

```
0 19 * * * set -a; . $HOME/.config/tomverse/marketing-video.prod.env; set +a; PATH=$HOME/.local/bin:$PATH $HOME/marketing-video-job/tools/marketing-video/run-daily.sh
```
