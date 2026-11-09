// The creative short job (owner 2026-11-09: "a different, creative ad every
// time", made with Higgsfield and ElevenLabs, not a reused template):
//   node run-creative-short.mjs
// Off unless MARKETING_CREATIVE_SHORT=on. Run by hand for now (phase 1): no
// cron starts it.
//
// Deterministic: it runs each model call with only the tools that call needs,
// checks every answer before acting on it, spends only through hf-media-core.mjs
// and el-voice-core.mjs (each refuses every call without its daily cap), and
// submits. Nothing is published: a person approves each file in Admin.
//
//  1. plan     a Claude call (CREATIVE-PLAN.md), Read on research notes,
//              features, capture packs and earlier films' stills: a new
//              concept, its AI shots, music, and the words per locale;
//              creative-core checkPlan; asked once more with the reason
//  2. shots    per shot a 9:16 start frame and a 5 s clip (Higgsfield)
//  3. check    a separate call (CREATIVE-SHOTS.md), Read on the clips'
//              stills: keeps a clean span of each clip or drops it
//  4. music    one instrumental bed (Higgsfield)
//  5. voice    every line in the locale's fixed ElevenLabs voice, levelled
//  6. build    a call (CREATIVE-BUILD.md) that writes the film's code in
//              <run>/film and renders stills of it to look at; it can write
//              only there and run only render-creative.mjs for this run
//  7. review   a separate call (CREATIVE-REVIEW.md), Read on every locale's
//              stills and earlier films': pass, fix (one more build) or reject
//  8. render   each locale, mastered; checkFinal; the asset file is written
//              here (creativeAsset); submit-asset.mjs
// The report is one JSON line.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkFilmSource, checkFinal, checkPlan, creativeAsset, jsonLine, normalizePack, reviewPassed, usablePacks } from "./creative-core.mjs";
import { speakLine, VOICE_CAP_ENV, voiceLedgerPath } from "./el-voice-core.mjs";
import { levelVoice, probe, seconds as lengthOf, stills } from "./ffmpeg-tools.mjs";
import { brisbaneDay, dailyCap, readLedger, spent } from "./higgsfield-cap.mjs";
import { CREATIVE_CAP_ENV, creativeLedgerPath, makeMedia, MUSIC_SECONDS } from "./hf-media-core.mjs";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(toolDir);
const env = process.env;
const day = brisbaneDay();
const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
const report = { job: "marketing-creative-short", date, run: null, concept: null, topic: null, locales: [], submitted: [], refused: [], failed: [], dropped: [], halted: null, credits: 0, voiceChars: 0 };
const finish = (code) => {
  try {
    report.credits = spent(readLedger(creativeLedgerPath("job", day)));
    report.voiceChars = spent(readLedger(voiceLedgerPath("job", day)));
  } catch {
    // no ledger: nothing was spent
  }
  console.log(JSON.stringify(report));
  process.exit(code);
};
const halt = (reason, code = 1) => {
  report.halted = reason;
  finish(code);
};

// 0. The switch, the caps and the keys, before anything else.
if (env.MARKETING_CREATIVE_SHORT !== "on") halt("switch_off", 0);
if (dailyCap(env, CREATIVE_CAP_ENV) === null) halt("no_credit_cap");
if (dailyCap(env, VOICE_CAP_ENV) === null) halt("no_voice_cap");
if (!env.ELEVENLABS_API_KEY) halt("no_elevenlabs_key");
if (!env.MARKETING_APP_URL || !env.MARKETING_MEDIA_SUBMIT_SECRET) halt("no_submission_settings");

const node = (args, extraEnv = env) => spawnSync(process.execPath, args, { encoding: "utf8", env: extraEnv, maxBuffer: 64 * 1024 * 1024 });
/** What a model call gets: no submission secret, no app address, no Higgsfield or ElevenLabs login or cap. */
const modelEnv = () => {
  const copy = { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  for (const key of Object.keys(copy)) if (/^(MARKETING_|HIGGSFIELD_|HF_|ELEVENLABS_|XI_)/u.test(key)) delete copy[key];
  return copy;
};

const creativeDir = path.join("job", "creative");
mkdirSync(creativeDir, { recursive: true });
let run = day;
for (let n = 2; existsSync(path.join(creativeDir, run)); n += 1) run = `${day}-${n}`;
report.run = run;
const runDir = path.join(creativeDir, run);
const pub = path.join(runDir, "public");
for (const sub of ["calls", "public/capture", "public/shots", "public/vo", "public/brand", "review", "raw", "out"]) mkdirSync(path.join(runDir, sub), { recursive: true });
const posix = (file) => file.split(path.sep).join("/");

/** One Claude CLI call. Its stream stays in <run>/calls/. Returns the final answer or null. */
function claude(name, prompt, { tools, allowed, maxTurns, timeoutMinutes = 30 }) {
  const bin = env.CLAUDE_BIN || "claude";
  const [command, prefix] = /\.m?js$/u.test(bin) ? [process.execPath, [bin]] : [bin, []];
  const out = spawnSync(
    command,
    [
      ...prefix,
      "--print", prompt,
      "--no-session-persistence",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--strict-mcp-config",
      "--tools", tools,
      "--allowedTools", allowed.join(","),
      "--disallowedTools", "mcp__*",
      "--max-turns", String(maxTurns),
      "--output-format", "stream-json",
      "--verbose",
    ],
    { encoding: "utf8", env: modelEnv(), timeout: timeoutMinutes * 60_000, maxBuffer: 128 * 1024 * 1024 },
  );
  writeFileSync(path.join(runDir, "calls", `${name}.jsonl`), out.stdout ?? "");
  let answer = null;
  for (const line of String(out.stdout ?? "").split(/\r?\n/u)) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") answer = event.result;
    } catch {
      // not an event
    }
  }
  return answer;
}

// The approved list first, as the daily job: captures come only from packs of approved shorts.
const listed = node(["list-approved.mjs"]);
if (listed.status !== 0) halt("list_approved_failed");

/**
 * The capture packs on the box (job/sources/<asset-id>/pack.json), either
 * shape (creative-core normalizePack), whose short is approved now and valid,
 * and whose source asset file gives the claims its captures rest on (as
 * make-card.mjs requires).
 */
const sourcesDir = path.join("job", "sources");
const onBox = [];
for (const id of existsSync(sourcesDir) ? readdirSync(sourcesDir) : []) {
  const file = path.join(sourcesDir, id, "pack.json");
  if (!existsSync(file)) continue;
  let pack = null;
  try {
    pack = normalizePack(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // unreadable: dropped below
  }
  const dir = path.dirname(file);
  const sourceAsset = pack?.videoAsset ? path.join(dir, pack.videoAsset) : null;
  let claimIds = null;
  try {
    claimIds = sourceAsset ? [...(JSON.parse(readFileSync(sourceAsset, "utf8")).asset?.claimIds ?? [])] : null;
  } catch {
    claimIds = null;
  }
  if (!pack || !claimIds) {
    report.dropped.push({ step: "packs", reason: `${id}: ${pack ? "no source asset file to take its claims from" : "no locale or no capture file"}` });
    continue;
  }
  // Only captures whose picture is on the box: a pack with none cannot give a film its real screens.
  const present = Object.entries(pack.captures).filter(([, capture]) => existsSync(path.join(dir, capture.file)));
  if (present.length === 0) {
    report.dropped.push({ step: "packs", reason: `${id}: none of its capture files is on the box` });
    continue;
  }
  onBox.push({ ...pack, captures: Object.fromEntries(present), file, dir, claimIds });
}
const packs = usablePacks(onBox, JSON.parse(readFileSync(path.join("job", "approved.json"), "utf8")), date);
for (const pack of onBox) if (!packs.includes(pack)) report.dropped.push({ step: "packs", reason: `${pack.assetId}: not approved now` });
if (packs.length === 0) halt("no_capture_packs");

const historyPath = path.join(creativeDir, "history.json");
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];
const sheetsDir = path.join(creativeDir, "sheets");
mkdirSync(sheetsDir, { recursive: true });

// 1. Plan.
const notesDir = path.join("job", "research-notes");
const newestNotes = existsSync(notesDir) ? readdirSync(notesDir).filter((file) => /^\d{8}\.json$/u.test(file)).sort().at(-1) : undefined;
const packLines = packs.map((pack) => `- topic ${pack.topic}, locale ${pack.locale}: ${posix(pack.file)} (pictures: ${Object.keys(pack.captures).join(", ")})`);
const planPrompt = [
  readFileSync("CREATIVE-PLAN.md", "utf8"),
  `## Today\n\n- Date: ${date}\n- Newest research notes: ${newestNotes ? `job/research-notes/${newestNotes}` : "none"}\n- Facts you may state: features.json`,
  `## Capture packs\n\n${packLines.join("\n")}`,
  `## Earlier creative shorts (never repeat one)\n\n${history.map((entry) => `- ${entry.date}: ${entry.concept} -- ${entry.logline} (stills: job/creative/sheets/${entry.run}/)`).join("\n") || "- none yet"}`,
].join("\n\n");
const planRead = ["Read(./job/research-notes/**)", "Read(./features.json)", "Read(./job/sources/**)", "Read(./job/creative/sheets/**)"];
let checked = null;
let refusal = null;
for (let attempt = 1; attempt <= 2 && !checked?.plan; attempt += 1) {
  const prompt = refusal ? `${planPrompt}\n\n## Your last plan was refused\n\n${refusal}\nWrite a new plan line that meets it.` : planPrompt;
  const answer = claude(`plan-${attempt}`, prompt, { tools: "Read", allowed: planRead, maxTurns: 40 });
  checked = answer ? checkPlan(answer, { packs, history }) : { refusal: "the answer held no {\"creative\": ...} line" };
  refusal = checked.refusal ?? null;
}
if (!checked?.plan) {
  report.dropped.push({ step: "plan", reason: refusal });
  halt("plan_refused");
}
const { plan, locales } = checked;
report.concept = plan.concept;
report.topic = plan.topic;
report.locales = locales;
writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));

// Real captures of the topic, per locale, and the logo.
// The words inside them and their short's claims go into the asset file.
const captures = {};
const captureWords = {};
const sourceClaims = {};
for (const locale of locales) {
  const pack = packs.find((candidate) => candidate.topic === plan.topic && candidate.locale === locale);
  const into = path.join(pub, "capture", locale);
  mkdirSync(into, { recursive: true });
  captureWords[locale] = [];
  sourceClaims[locale] = pack.claimIds;
  captures[locale] = Object.entries(pack.captures).flatMap(([name, { file, text }]) => {
    const from = path.join(pack.dir, file);
    if (!existsSync(from)) return [];
    const to = path.join(into, `${name}${path.extname(file)}`);
    copyFileSync(from, to);
    captureWords[locale].push(text);
    return [{ name, file: posix(path.relative(pub, to)) }];
  });
  // Before anything is paid for: a locale without a real screen is not made.
  if (captures[locale].length === 0) report.dropped.push({ step: `captures ${locale}`, reason: "no capture file left" });
}
for (const locale of [...locales]) if (captures[locale].length === 0) locales.splice(locales.indexOf(locale), 1);
report.locales = locales;
if (locales.length === 0) halt("no_capture_left");
copyFileSync(path.join("library", "tomverse-logo.png"), path.join(pub, "brand", "logo.png"));

// 2. AI shots: a start frame, then a clip from it.
// Every paid call is admitted against the day the run started: its ledgers and caps are that day's.
// Past Brisbane midnight the ledger refuses it (`today`, read at admission, "day_changed"), since it
// would bill the next day to this day's ledger while a run started after midnight spends a new cap.
const paid = (request, out, label) => makeMedia({ request, out, label: `${run}:${label}`, jobDir: "job", day, today: brisbaneDay });
const shots = [];
for (const shot of plan.shots) {
  const frame = await paid({ model: "gpt_image_2_6", aspect_ratio: "9:16", count: 1, prompt: shot.image }, path.join(runDir, "raw", `${shot.id}.png`), `${shot.id}-frame`);
  if (!frame.ok) {
    report.failed.push({ step: `shot ${shot.id} frame`, reason: frame.reason });
    continue;
  }
  const clip = await paid({ model: "kling3_0", aspect_ratio: "9:16", duration: 5, mode: "std", sound: "off", start_image: frame.jobId, prompt: shot.motion }, path.join(pub, "shots", `${shot.id}.mp4`), `${shot.id}-clip`);
  if (!clip.ok) {
    report.failed.push({ step: `shot ${shot.id} clip`, reason: clip.reason });
    continue;
  }
  shots.push({ id: shot.id, file: `shots/${shot.id}.mp4`, about: shot.image });
}

// 3. Check each clip: generated video draws false text and broken shapes, often after the first seconds.
let kept = [];
if (shots.length > 0) {
  for (const shot of shots) stills(path.join(pub, shot.file), path.join(runDir, "review", "shots", shot.id));
  const shotPrompt = [
    readFileSync("CREATIVE-SHOTS.md", "utf8"),
    `## Clips\n\n${shots.map((shot) => `- ${shot.id}: stills in job/creative/${run}/review/shots/${shot.id}/ (t001 = 0.00 s, 4 a second). Meant to show: ${shot.about}`).join("\n")}`,
  ].join("\n\n");
  const answer = claude("shots", shotPrompt, { tools: "Read", allowed: [`Read(./job/creative/${run}/review/shots/**)`], maxTurns: 40 });
  const verdicts = Array.isArray(jsonLine(answer, "shots")) ? jsonLine(answer, "shots") : [];
  kept = shots.flatMap((shot) => {
    const verdict = verdicts.find((candidate) => candidate?.id === shot.id);
    const [from, to] = Array.isArray(verdict?.keep) ? verdict.keep.map(Number) : [];
    if (!(from >= 0 && to <= 5 && to - from >= 1)) {
      report.dropped.push({ step: `shot ${shot.id}`, reason: verdict?.why ?? "no clean span" });
      return [];
    }
    return [{ id: shot.id, file: shot.file, from, to }];
  });
}

// 4. Music, a little longer than the film.
const musicSeconds = Math.min(MUSIC_SECONDS.max, Math.max(MUSIC_SECONDS.min, plan.seconds + 2));
const music = await paid({ model: "elevenlabs_music_v2_5", force_instrumental: true, duration: musicSeconds, prompt: plan.music }, path.join(pub, "music.mp3"), "music");
if (!music.ok) report.failed.push({ step: "music", reason: music.reason });

// 5. Voice, line by line, each levelled to the same loudness.
const MAX_SECONDS = 40;
const props = {};
for (const locale of [...locales]) {
  const words = plan.locales[locale];
  const lines = [];
  for (const [index, text] of words.lines.entries()) {
    const raw = path.join(runDir, "raw", `vo-${locale}-${index + 1}.mp3`);
    const spoken = await speakLine({ locale, text, out: raw, jobDir: "job", day, today: brisbaneDay, label: `${run}:${locale}-${index + 1}` });
    if (!spoken.ok) {
      report.failed.push({ step: `voice ${locale} ${index + 1}`, reason: spoken.reason });
      break;
    }
    const file = path.join(pub, "vo", `${locale}-${index + 1}.mp3`);
    levelVoice(raw, file);
    lines.push({ text, file: posix(path.relative(pub, file)), seconds: Number(lengthOf(file).toFixed(2)) });
  }
  if (lines.length !== words.lines.length) {
    locales.splice(locales.indexOf(locale), 1);
    report.dropped.push({ step: `voice ${locale}`, reason: "a line could not be made" });
    continue;
  }
  // Long enough for the narration with a breath between lines and the end card.
  // Past 40 s the locale is refused rather than cut: a cut drops the end card.
  const needed = Math.ceil(lines.reduce((sum, line) => sum + line.seconds, 0) + 0.35 * (lines.length - 1) + 2.5);
  if (needed > MAX_SECONDS) {
    locales.splice(locales.indexOf(locale), 1);
    report.dropped.push({ step: `voice ${locale}`, reason: `the narration needs ${needed} s, more than ${MAX_SECONDS}` });
    continue;
  }
  props[locale] = {
    locale,
    seconds: Math.max(plan.seconds, needed),
    lines,
    screen: words.screen,
    captures: captures[locale],
    shots: kept,
    music: music.ok ? "music.mp3" : null,
    logo: "brand/logo.png",
    url: "tomverse.app",
  };
  writeFileSync(path.join(pub, `props-${locale}.json`), JSON.stringify(props[locale], null, 2));
}
report.locales = locales;
if (locales.length === 0) halt("no_locale_left");

// 6-7. Build, then review; one more build on "fix".
const renderAll = () => {
  for (const locale of locales) {
    const rendered = node(["render-creative.mjs", runDir, locale, "--stills", "12"], modelEnv());
    if (rendered.status !== 0) return `${locale}: ${rendered.stdout.trim().split("\n").at(-1)}`;
  }
  return null;
};
const buildPrompt = (notes) => [
  readFileSync("CREATIVE-BUILD.md", "utf8").replaceAll("{{RUN}}", posix(runDir)),
  `## The plan\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``,
  `## The props per locale\n\n${locales.map((locale) => `- ${locale}: job/creative/${run}/public/props-${locale}.json`).join("\n")}`,
  notes ? `## The reviewer asked for these changes\n\n${notes}` : "",
].join("\n\n");
const reviewPrompt = () => [
  readFileSync("CREATIVE-REVIEW.md", "utf8"),
  `## This film\n\n${plan.concept}: ${plan.logline}\n\n${locales.map((locale) => `- ${locale}: stills in job/creative/${run}/review/${locale}/; words ${JSON.stringify(plan.locales[locale].screen)}`).join("\n")}`,
  `## Earlier films\n\n${history.map((entry) => `- ${entry.concept}: job/creative/sheets/${entry.run}/`).join("\n") || "- none yet"}`,
].join("\n\n");
const buildAllowed = [
  `Read(./job/creative/${run}/**)`,
  `Write(./job/creative/${run}/film/**)`,
  `Edit(./job/creative/${run}/film/**)`,
  `Bash(node render-creative.mjs ${posix(runDir)} *)`,
];
let verdict = null;
let notes = null;
for (let round = 1; round <= 2; round += 1) {
  claude(`build-${round}`, buildPrompt(notes), { tools: "Read,Write,Edit,Bash", allowed: buildAllowed, maxTurns: 150, timeoutMinutes: 90 });
  const problems = await checkFilmSource(path.join(runDir, "film"));
  if (problems.length > 0) {
    report.dropped.push({ step: `build ${round}`, reason: problems.join("; ") });
    halt("film_refused");
  }
  const renderProblem = renderAll();
  if (renderProblem) {
    report.dropped.push({ step: `build ${round}`, reason: renderProblem });
    halt("film_did_not_render");
  }
  const answer = claude(`review-${round}`, reviewPrompt(), { tools: "Read", allowed: [`Read(./job/creative/${run}/review/**)`, "Read(./job/creative/sheets/**)"], maxTurns: 60 });
  verdict = jsonLine(answer, "review");
  // A "pass" with a score under 8 (or a missing one) is not a pass: it goes back as a fix.
  const low = verdict?.verdict === "pass" && !reviewPassed(verdict);
  if (verdict?.verdict !== "fix" && !low) break;
  notes = `${low ? `Every score must be 8 or more; it was ${JSON.stringify(verdict.scores ?? null)}. ` : ""}${String(verdict.notes ?? "")}`.slice(0, 4000);
}
if (!reviewPassed(verdict)) {
  report.dropped.push({ step: "review", reason: verdict ? `${verdict.verdict} ${JSON.stringify(verdict.scores ?? null)}: ${String(verdict.notes ?? "").slice(0, 300)}` : "no verdict" });
  halt("review_did_not_pass");
}

// 8. Render, check, submit.
for (const locale of locales) {
  const id = `media-${run}-creative-${locale.toLowerCase()}-short`;
  const out = path.join(runDir, "out", `${id}.mp4`);
  const rendered = node(["render-creative.mjs", runDir, locale, "--out", out], modelEnv());
  if (rendered.status !== 0) {
    report.failed.push({ id, step: "render", status: rendered.status });
    continue;
  }
  const problems = checkFinal(probe(out));
  if (problems.length > 0) {
    report.failed.push({ id, step: "check", problems });
    continue;
  }
  writeFileSync(path.join(runDir, "out", `${id}.asset.json`), JSON.stringify(creativeAsset({ id, locale, words: plan.locales[locale], captureWords: captureWords[locale], claimIds: sourceClaims[locale] }), null, 2));
  const submitted = node(["submit-asset.mjs", out, path.join(runDir, "out", `${id}.asset.json`)]);
  if (submitted.status === 0) report.submitted.push(id);
  else if (submitted.status === 3) report.refused.push({ id, guard: jsonLine(submitted.stdout, "guardCodes") ?? submitted.stdout.trim().slice(0, 300) });
  else report.failed.push({ id, step: "submit", status: submitted.status, detail: submitted.stderr.trim().slice(0, 300) });
}

// What the next plan and review see of this one: its stills and its concept.
const sheet = path.join(sheetsDir, run);
mkdirSync(sheet, { recursive: true });
const firstLocale = locales.includes("en") ? "en" : locales[0];
for (const file of readdirSync(path.join(runDir, "review", firstLocale))) copyFileSync(path.join(runDir, "review", firstLocale, file), path.join(sheet, file));
history.push({ date, run, concept: plan.concept, logline: plan.logline, topic: plan.topic, locales, submitted: report.submitted });
writeFileSync(historyPath, JSON.stringify(history, null, 2));
rmSync(path.join(runDir, "raw"), { recursive: true, force: true });
finish(report.submitted.length > 0 ? 0 : 1);
