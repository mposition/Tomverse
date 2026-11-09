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

## The Higgsfield image path (off by default)

Owner decision 2026-11-08. With `MARKETING_MEDIA_IMAGE_PATH=higgsfield` in the
box's env file, `run-daily.sh` runs `run-higgsfield.mjs` instead of the HTML
card call: concepts from one Claude call (`JOB-higgsfield.md`), pictures from
Higgsfield `gpt_image_2_6` (4:5, one per call), a guide review and a content
review as separate Claude calls (`REVIEW-higgsfield.md`, Read on their own
folder only), real-font Korean and Chinese words (`compose.mjs`), the real
provider marks, and the fixed band (`band-layout.mjs`) through `make-card.mjs`.
The design guide every call follows is `HIGGSFIELD-GUIDE.md`.

- Calls go through the official Higgsfield CLI (`@higgsfield/cli`, logged in on
  the box with `higgsfield auth login`), which draws on the web plan's
  credits. The HTTP API has no GPT Image 2.6 and bills a separate balance.
- `hf-image-core.mjs` and `higgsfield-cap.mjs` keep the spend: only the one
  model, ratio and count; a daily ledger `job/higgsfield-ledger-<yyyymmdd>.json`
  under `MARKETING_HIGGSFIELD_DAILY_CREDIT_CAP` (unset or 0 refuses every call);
  a call whose outcome is unknown blocks the next until its job id shows it.
- `HIGGSFIELD_BIN` and `CLAUDE_BIN` name other binaries (a `.mjs` is run with
  node), for a dry run with stand-ins.

## The creative short job (off by default, run by hand)

Owner direction 2026-11-09: a different, creative short every time, made with
Higgsfield and ElevenLabs instead of a reused template. `run-creative-short.mjs`
(started by `run-creative-short.sh`) is off unless `MARKETING_CREATIVE_SHORT=on`
in the box's env file; no cron starts it yet.

One run makes one 15-40 s 9:16 film in every locale that has a capture pack of
its topic, and submits each for approval in Admin:

1. plan (`CREATIVE-PLAN.md`): a Claude call with Read on research notes,
   `features.json`, the capture packs and earlier films' stills writes a new
   concept, up to 3 AI shots, a music prompt and the words per locale.
   `creative-core.mjs` checks it (limits, the AI line on screen, a pack of the
   topic, a concept never used before) before anything is paid for.
2. shots and music (`hf-media-core.mjs`): a 9:16 `gpt_image_2_6` frame, a 5 s
   `kling3_0` std clip from it, one `elevenlabs_music_v2_5` instrumental bed.
   Same safeguards as the image path, its own daily ledger
   `job/creative-ledger-<yyyymmdd>.json` under
   `MARKETING_CREATIVE_SHORT_DAILY_CREDIT_CAP`, and a ceiling per call.
3. shot check (`CREATIVE-SHOTS.md`): a separate call reads 4 stills a second of
   each clip and keeps a clean span (no false writing, broken hands or logos).
4. voice (`el-voice-core.mjs`): each narration line through the ElevenLabs API
   in the locale's fixed voice (en Killian, ko Apollo, zh-Hant 阿夢, zh-Hans Qiao
   Feng), levelled to -16 LUFS. ElevenLabs bills characters: a daily ledger
   `job/creative-voice-ledger-<yyyymmdd>.json` under
   `MARKETING_CREATIVE_SHORT_DAILY_VOICE_CHARS`; a line with no answer blocks the
   rest of the day. The key is `ELEVENLABS_API_KEY`.
5. build (`CREATIVE-BUILD.md`): a Claude call writes the film's Remotion code in
   `job/creative/<run>/film/` and looks at stills it renders with
   `render-creative.mjs`; it can write only there and run only that command.
   `render-creative.mjs` refuses code that imports anything but react, remotion
   and its own files (every import read by esbuild's parser, so no webpack
   loader or comment trick passes), or names the network, Node, randomness or
   the clock. It then bundles and renders in a bubblewrap sandbox: no network
   but loopback, only PATH, HOME and LANG in the environment, and the home
   folders with logins and keys (`~/.config/tomverse`, `~/.claude`, `~/.ssh`,
   ...) hidden. Without bubblewrap on Linux it refuses.
   Only packs of shorts that `job/approved.json` lists as approved and valid
   today are used, and a locale whose narration needs more than 40 s is
   dropped rather than cut.
6. review (`CREATIVE-REVIEW.md`): a separate call scores every locale's stills
   against the earlier films: pass, fix (one more build) or reject.
7. render, master to -14 LUFS, check 1080x1920 / 10-60 s / sound, write the
   asset file in code (`capture_with_ai_media`, showing the product interface, a disclosure on every channel, zh-Hans to
   RedNote only) and submit with `submit-asset.mjs`.

Phase 1 limits: the real screens come from the approved shorts' capture packs
(`job/sources/`), so a film is about a topic one of them shows; recording new
screens per film is the next step. The report is one JSON line;
`job/creative/history.json` and `job/creative/sheets/<run>/` let the next run
avoid repeating it. For a dry run, `CLAUDE_BIN` and `HIGGSFIELD_BIN` name
stand-ins.
