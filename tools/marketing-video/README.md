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

## The daily job

`run-daily.sh` runs the Claude Code CLI on `JOB.md` once a day on the AMUX box
(owner approval for the unattended job, 2026-10-31). It captures, renders and
submits assets with `submit-asset.mjs`, which needs `MARKETING_APP_URL` and
`MARKETING_MEDIA_SUBMIT_SECRET` (an env file on the box, never in git). The app
runs the Guard over each transcript; a refusal comes back as exit 3 with the
Guard codes and the job rewrites. Nothing here publishes: a person approves the
asset in Admin, and the app's generator, whose calls go through the LLM cost
ledger, writes the post that carries it for a second approval. The job does
not submit posts: the draft intake takes only drafts backed by ledger calls.

Cron on the box (07:30 Brisbane, after the generator's run):

```
30 21 * * * set -a; . /etc/tomverse/marketing-video.env; set +a; /path/to/clone/tools/marketing-video/run-daily.sh
```
