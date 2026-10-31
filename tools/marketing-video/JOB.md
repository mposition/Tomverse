# Daily marketing video job

You run once a day on the AMUX box, in `tools/marketing-video` of a fresh
clone. You make videos and submit them to the Tomverse app as assets. You never
publish anything: a person approves each asset in Admin, and the app's own
generator writes the post that carries it, through the Guard and a second
approval. Owner approval for this unattended job: 2026-10-31.

## Hard rules

- Never post to a social platform, never call Zernio, HeyGen or any paid API,
  never commit or push to git, never print `MARKETING_MEDIA_SUBMIT_SECRET`.
- Pictures of the product are real captures only (`node capture.mjs`). Never
  draw, generate or mock up the product screen.
- Make no factual claim the app has not registered: no prices, numbers,
  rankings, model counts, "best", "fastest", "free", comparisons with a named
  competitor, or promises. Describe what the viewer sees on screen.
- No URL or domain name in any text; the end card says "Tomverse".
- In Chinese, put a space after "。" when Latin letters follow ("來看。 AI Review"): the
  Guard reads "。AI" as a web address ("AI" is a domain suffix) and refuses it.
- Nothing aimed at people under 16; no urgency ("today only", "hurry").
- Stop and report rather than guess if a step fails twice.

## What to make today

1. One topic: something a visitor can see on a public Tomverse page today
   (asking several AI models the same question, reviewing answers, the model
   list, image generation). Open the pages with `capture.mjs` and look at what
   is actually there before you write; pick a different topic from the last
   three runs if `job/history.json` lists them.
2. A **short** (`Short`, 15 to 40 seconds) in each of `en`, `ko` and `zh-Hant`:
   a hook title scene, two to four capture scenes, a CTA scene. Captions are
   short spoken sentences; write each locale natively, not as a literal
   translation.
3. On Monday and Thursday (Brisbane time) also a **long** (`Long`, 2 to 6
   minutes, `en`): a walkthrough of the same topic with more capture scenes,
   including screen recordings (`capture.mjs <url> out.webm <orientation> <seconds>`).

## Steps

1. Capture: `node capture.mjs <url> job/<name>.png portrait` (and `landscape`
   for the long video). Capture the page in the video's language: `https://tomverse.app/...`
   for `en`, `https://tomverse.app/ko/...` for `ko`, and `https://tomverse.app/zh/...` for
   `zh-Hant` (the site has Simplified Chinese pages only; owner decision 2026-10-31). Check every capture with the Read tool; retake one that
   shows a banner, an error or a half-loaded page.
2. Write `job/<id>.props.json` per video following `src/schema.ts`, then
   `node render.mjs job/<id>.props.json Short|Long job/<id>.mp4`. Extract two
   frames with the ffmpeg in `node_modules/@remotion/compositor-*` and read
   them: text must fit, Korean and Chinese must not break inside a word.
3. Write `job/<id>.asset.json`:

   ```json
   {
     "asset": {
       "id": "media-<yyyymmdd>-<topic>-<locale>-<short|long>",
       "provenance": "capture",
       "allowedChannels": ["instagram", "youtube", "tiktok", "x"],
       "alt": { "<locale>": "<one sentence describing the video>" },
       "claimIds": [],
       "validUntil": "<today + 90 days, YYYY-MM-DD>",
       "disclosure": { "instagram": "none", "youtube": "none", "tiktok": "none", "x": "none" },
       "depictsProductInterface": true
     },
     "transcript": { "<locale>": "<every caption and on-screen line, in order>" }
   }
   ```

   A long video's `allowedChannels` is `["youtube"]` only. Ids are lower case
   letters, digits and `-`.
4. Submit: `node submit-asset.mjs job/<id>.mp4 job/<id>.asset.json`.
   - Exit 0: submitted.
   - Exit 3: the Guard refused the transcript; it prints the Guard codes.
     Rewrite the lines that caused them, render again, and resubmit with a new
     id (`-r2`). At most two rewrites per video.
   - Exit 1: stop that video and report the step and status it printed.
5. Append today's topic and asset ids to `job/history.json`, and delete any helper
   script or scratch file you made in `job/` today (keep the renders, props and history).

## Report

End with one JSON line:
`{"job":"marketing-video","date":"<yyyy-mm-dd>","topic":"...","submitted":["media-..."],"refused":[{"id":"...","guardCodes":[...]}],"failed":[{"id":"...","step":"...","status":0}]}`
