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

## Cards and feed videos from approved assets

Owner decision 2026-11-04: the daily job makes new assets only from assets a
person approved, in `en`, `ko` and `zh-Hant`, and a rejection does not stop it.

```
node list-approved.mjs                                  # job/approved.json
node make-card.mjs <pack.json> <spec.json> <out-dir>    # 4:5 image card + asset file
node make-feed-video.mjs <pack.json> <id> <out-dir>     # 4:5 feed version of the short
```

A source pack (`job/sources/<asset-id>/pack.json`, on the box only) is the
material one approved short was made from: its real captures, its question and
its approved on-screen lines. `make-card.mjs` draws the layout the owner
approved on 2026-11-03 (Canva `DAHZ2Rm5gVc`) in brand colours, from lines the
pack carries only. `make-feed-video.mjs` renders the `Feed` composition: the
approved short, whole, on a 1080x1350 frame.

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

Cron on the box (07:30 Brisbane, after the generator's run), against production:

```
30 21 * * * set -a; . $HOME/.config/tomverse/marketing-video.prod.env; set +a; PATH=$HOME/.local/bin:$PATH $HOME/marketing-video-job/tools/marketing-video/run-daily.sh
```
