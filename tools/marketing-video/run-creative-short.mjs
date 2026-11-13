// The creative short job (owner 2026-11-09: "a different, creative ad every
// time", made with Higgsfield and ElevenLabs, not a reused template):
//   node run-creative-short.mjs
//   node run-creative-short.mjs --rebuild <run>
// Off unless MARKETING_CREATIVE_SHORT=on. Run by hand for now (phase 1): no
// cron starts it.
//
// --rebuild (owner 2026-11-11) takes a run that stopped at the review and
// builds its film again from the reviewer's last notes, with that run's plan,
// shots, music and voice: steps 1-5 do not run, so nothing is paid for. It
// gives REBUILD_ROUNDS more build-and-review rounds; a run its reviewer
// rejected is not rebuilt.
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

import { answerOf, checkFilmSource, checkFinal, checkPlan, creativeAsset, fileRule, jsonLine, lastBuild, packOfRun, stillsIn, normalizePack, reviewPassed, usablePacks } from "./creative-core.mjs";
import { speakLine, VOICE_CAP_ENV, voiceLedgerPath } from "./el-voice-core.mjs";
import { levelVoice, probe, seconds as lengthOf, stills } from "./ffmpeg-tools.mjs";
import { FRESH_LOCALES, FRESH_REVIEW_ENV, pickSubject } from "./fresh-review.mjs";
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
// Whatever goes wrong after money may have been spent, the report and its spend are written.
const crashed = (error) => {
  report.failed.push({ step: "run", reason: String(error?.stack ?? error).slice(0, 600) });
  halt("crashed");
};
process.on("uncaughtException", crashed);
process.on("unhandledRejection", crashed);

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
const REBUILD_ROUNDS = 3;
const rebuildAt = process.argv.indexOf("--rebuild");
const rebuild = rebuildAt === -1 ? null : String(process.argv[rebuildAt + 1] ?? "");
if (rebuild !== null && !(/^\d{8}(?:-\d+)?$/u.test(rebuild) && existsSync(path.join(creativeDir, rebuild, "plan.json")))) halt("no_such_run");
mkdirSync(creativeDir, { recursive: true });
let run = rebuild ?? day;
if (rebuild === null) for (let n = 2; existsSync(path.join(creativeDir, run)); n += 1) run = `${day}-${n}`;
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
  return answerOf(out.stdout);
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
let packs = usablePacks(onBox, JSON.parse(readFileSync(path.join("job", "approved.json"), "utf8")), date);
for (const pack of onBox) if (!packs.includes(pack)) report.dropped.push({ step: "packs", reason: `${pack.assetId}: not approved now` });
// Fresh captures (owner 2026-11-12, a different subject every film): recorded for this run below,
// so a new run does not need an approved pack. Off by default: each recording spends the demo
// account's credits.
const fresh = rebuild === null && env[FRESH_REVIEW_ENV] === "on";

/** The packs a run recorded for itself (<run>/sources/<locale>/pack.json): real screens of today, no short's claims. */
function freshPacksIn(dir) {
  const root = path.join(dir, "sources");
  return (existsSync(root) ? readdirSync(root) : []).flatMap((locale) => {
    const file = path.join(root, locale, "pack.json");
    if (!existsSync(file)) return [];
    const pack = normalizePack(JSON.parse(readFileSync(file, "utf8")));
    if (!pack) return [];
    const present = Object.entries(pack.captures).filter(([, capture]) => existsSync(path.join(root, locale, capture.file)));
    return present.length > 0 ? [{ ...pack, captures: Object.fromEntries(present), file, dir: path.dirname(file), claimIds: [] }] : [];
  });
}
if (rebuild !== null) packs = [...packs, ...freshPacksIn(runDir)];
if (packs.length === 0 && !fresh) halt("no_capture_packs");

const historyPath = path.join(creativeDir, "history.json");
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];
const sheetsDir = path.join(creativeDir, "sheets");
mkdirSync(sheetsDir, { recursive: true });
const earlierStills = (entry) => stillsIn(path.join(sheetsDir, entry.run), 4).join(", ") || "none kept";
/** What the builder is told after a review: a "pass" with a score under 8 (or a missing one) is not a pass. */
const notesFrom = (review) => {
  const low = review?.verdict === "pass" && !reviewPassed(review);
  return `${low ? `Every score must be 8 or more; it was ${JSON.stringify(review.scores ?? null)}. ` : ""}${String(review?.notes ?? "")}`.slice(0, 4000);
};

// A rebuild: the run's plan, captures, shots, music and voice as they are; only build and review
// again, from the last review's notes. Nothing below step 5 is paid for, and this never reaches step 1.
if (rebuild !== null) {
  const plan = JSON.parse(readFileSync(path.join(runDir, "plan.json"), "utf8"));
  report.concept = plan.concept;
  report.topic = plan.topic;
  // A run that reached the end is in history and its files went to Admin under their ids: never again.
  if (history.some((entry) => entry.run === run)) halt("already_finished");
  const before = lastBuild(path.join(runDir, "calls"));
  if (before.review?.verdict === "reject") {
    report.dropped.push({ step: "rebuild", reason: `its reviewer rejected it: ${String(before.review.notes ?? "").slice(0, 300)}` });
    halt("rejected_before");
  }
  const captureWords = {};
  const sourceClaims = {};
  const locales = Object.keys(plan.locales ?? {}).filter((locale) => {
    // The pack whose files the run copied, approved now; never another pack of the same topic.
    const source = packOfRun(path.join(pub, "capture", locale), packs, plan.topic, locale);
    if (!source || !existsSync(path.join(pub, `props-${locale}.json`))) {
      report.dropped.push({ step: `rebuild ${locale}`, reason: source ? "the run made no props for it" : "no pack approved now holds the run's captures" });
      return false;
    }
    captureWords[locale] = source.words;
    sourceClaims[locale] = source.pack.claimIds;
    return true;
  });
  report.locales = locales;
  if (locales.length === 0) halt("no_locale_left");
  const notes = before.review && !reviewPassed(before.review) ? notesFrom(before.review) : null;
  await finishFilm({ plan, locales, captureWords, sourceClaims, firstRound: before.rounds + 1, rounds: REBUILD_ROUNDS, notes });
}

// 0b. Fresh captures: a subject at random (never one of the last films'), one question about it per
// locale written by a model, each asked ONCE in Review and its answer analysis run ONCE
// (fresh-review.mjs). A recording that stopped after a paid step is never repeated, and stops the rest.
let subject = null;
if (fresh) {
  subject = pickSubject(history);
  const topic = `fresh-${subject.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 50)}`;
  report.topic = topic;
  const questionPrompt = [
    "Write the question a real person would type into an AI assistant about this everyday subject, once in each language: en, ko, zh-Hant (Traditional Chinese, Taiwan usage).",
    `Subject: ${subject}.`,
    "Rules: one concrete request with a detail or two that makes the answers differ (a budget, a number of people, a constraint); the same numbers in every language, so one set of shots fits all three; ask for practical help (a plan, a list, steps, a choice between options), never for novels, films, songs or other works to recommend, since the answers would name works whose themes nobody checked; 40-120 characters; natural for that language, not a translation; no brand or product names; nothing about death, illness, medicine, loss or danger; never about Tomverse or AI.",
    'Answer with one line of JSON only: {"questions": {"en": "...", "ko": "...", "zh-Hant": "..."}}',
  ].join("\n");
  const questions = jsonLine(claude("questions", questionPrompt, { tools: "Read", allowed: [fileRule("Read", "features.json")], maxTurns: 3, timeoutMinutes: 5 }), "questions");
  const asked = FRESH_LOCALES.filter((locale) => typeof questions?.[locale] === "string" && questions[locale].trim().length >= 8 && questions[locale].trim().length <= 200);
  if (asked.length === 0) halt("no_questions");
  for (const locale of asked) {
    const into = path.join(runDir, "sources", locale);
    mkdirSync(path.dirname(into), { recursive: true });
    const questionFile = path.join(runDir, "sources", `question-${locale}.txt`);
    writeFileSync(questionFile, questions[locale].trim());
    const recorded = node(["fresh-review.mjs", locale, into, questionFile, topic]);
    let line = null;
    try {
      line = JSON.parse(String(recorded.stdout ?? "").trim().split("\n").at(-1));
    } catch {
      // no report line
    }
    if (recorded.status === 0) continue;
    report.failed.push({ step: `fresh ${locale}`, reason: `exit ${recorded.status}: ${String(line?.error ?? recorded.stderr ?? "").slice(0, 300)}` });
    // Only a recording known to have stopped before any paid step (1, or 2 usage) lets the next
    // locale go on. After a paid step went wrong, a failed settings restore, a claim already taken
    // or a killed recorder (status null), the whole run stops before anything else is paid for:
    // the account is looked at first, by a person.
    if (recorded.status !== 1 && recorded.status !== 2) halt("fresh_review_stopped");
  }
  packs = freshPacksIn(runDir);
  if (packs.length === 0) halt("no_fresh_capture");
}

// 1. Plan.
const notesDir = path.join("job", "research-notes");
const newestNotes = existsSync(notesDir) ? readdirSync(notesDir).filter((file) => /^\d{8}\.json$/u.test(file)).sort().at(-1) : undefined;
const packLines = packs.map((pack) => `- topic ${pack.topic}, locale ${pack.locale}: ${posix(pack.file)} (pictures: ${Object.keys(pack.captures).join(", ")})`);
const planPrompt = [
  readFileSync("CREATIVE-PLAN.md", "utf8"),
  `## Today\n\n- Date: ${date}\n- Newest research notes: ${newestNotes ? `job/research-notes/${newestNotes}` : "none"}\n- Facts you may state: features.json`,
  ...(subject ? [`## Today's subject (picked at random)\n\n${subject}. The capture packs below were recorded for this film just now: a real question about it, asked once in Review. The film is about this subject and these screens.`] : []),
  `## Capture packs\n\n${packLines.join("\n")}`,
  `## Earlier creative shorts (never repeat one)\n\n${history.map((entry) => `- ${entry.date}: ${entry.concept} -- ${entry.logline} (stills: ${earlierStills(entry)})`).join("\n") || "- none yet"}`,
].join("\n\n");
const planRead = ["job/research-notes/**", "features.json", "job/sources/**", `job/creative/${run}/sources/**`, "job/creative/sheets/**"].map((file) => fileRule("Read", file));
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
if (subject) plan.subject = subject;
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
  const answer = claude("shots", shotPrompt, { tools: "Read", allowed: [fileRule("Read", `job/creative/${run}/review/shots/**`)], maxTurns: 40 });
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

// 6-8. Build, then review (one more build on "fix"), then render, check and submit. A new run
// comes here after step 5; a rebuild comes here straight away. Every way out ends the process.
await finishFilm({ plan, locales, captureWords, sourceClaims, firstRound: 1, rounds: 2, notes: null });

async function finishFilm({ plan, locales, captureWords, sourceClaims, firstRound, rounds, notes: firstNotes }) {
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
  // The run's real captures of a locale, each a file the reviewer may open (Read takes files, not folders).
  const capturesIn = (locale) => {
    const dir = path.join(runDir, "public", "capture", locale);
    return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".png")).sort().map((file) => posix(path.join(dir, file))) : [];
  };
  const reviewPrompt = () => [
    readFileSync("CREATIVE-REVIEW.md", "utf8"),
    `## This film\n\n${plan.concept}: ${plan.logline}\n\n${locales.map((locale) => `- ${locale}: stills ${stillsIn(path.join(runDir, "review", locale)).join(", ")}; words ${JSON.stringify(plan.locales[locale].screen)}; real captures ${capturesIn(locale).join(", ")}`).join("\n")}`,
    `## Earlier films\n\n${history.map((entry) => `- ${entry.concept}: ${earlierStills(entry)}`).join("\n") || "- none yet"}`,
  ].join("\n\n");
  const buildAllowed = [
    fileRule("Read", `job/creative/${run}/**`),
    fileRule("Edit", `job/creative/${run}/film/**`),
    `Bash(node render-creative.mjs ${posix(runDir)} *)`,
  ];
  let verdict = null;
  let notes = firstNotes;
  for (let round = firstRound; round < firstRound + rounds; round += 1) {
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
    const answer = claude(`review-${round}`, reviewPrompt(), { tools: "Read", allowed: [fileRule("Read", `job/creative/${run}/review/**`), fileRule("Read", `job/creative/${run}/public/capture/**`), fileRule("Read", "job/creative/sheets/**")], maxTurns: 60 });
    verdict = jsonLine(answer, "review");
    // A "pass" with a score under 8 (or a missing one) is not a pass: it goes back as a fix.
    const low = verdict?.verdict === "pass" && !reviewPassed(verdict);
    if (verdict?.verdict !== "fix" && !low) break;
    notes = notesFrom(verdict);
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
  history.push({ date, run, concept: plan.concept, logline: plan.logline, topic: plan.topic, ...(plan.subject ? { subject: plan.subject } : {}), locales, submitted: report.submitted });
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
  rmSync(path.join(runDir, "raw"), { recursive: true, force: true });
  finish(report.submitted.length > 0 ? 0 : 1);
}
