import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { marketingAssetSchema } from "../lib/marketingAssets.ts";
import { AI_LINE, answerOf, checkFilmSource, checkFinal, checkPlan, creativeAsset, fileRule, lastBuild, normalizePack, packOfRun, reviewPassed, stillsIn, usablePacks } from "../tools/marketing-video/creative-core.mjs";
import { speakLine, VOICE_CAP_ENV, VOICES, voiceLedgerPath } from "../tools/marketing-video/el-voice-core.mjs";
import { admit, downloadResult, ledgerPath, readLedger } from "../tools/marketing-video/higgsfield-cap.mjs";
import { CREATIVE_CAP_ENV, creativeLedgerPath, creativeRequestProblem, makeMedia } from "../tools/marketing-video/hf-media-core.mjs";

/**
 * The creative short job (owner 2026-11-09: a different, creative ad every
 * time, made with Higgsfield and ElevenLabs). Money leaves only through two
 * capped, deterministic callers that no model runs: Higgsfield clips, frames
 * and music under MARKETING_CREATIVE_SHORT_DAILY_CREDIT_CAP, and ElevenLabs
 * lines in a fixed voice per locale under MARKETING_CREATIVE_SHORT_DAILY_VOICE_CHARS.
 * The model's plan and film code pass checks before anything is paid for or
 * rendered, and the asset file is written by code. No test here calls a paid
 * service: the CLI and fetch are fakes.
 */

const DAY = "20261110";
const JOB = "8d3c6a1e-1111-4222-8333-944455556666";
const tempJob = () => mkdtempSync(join(tmpdir(), "creative-"));
const capEnv = (credits = "40", chars = "3000") => ({ MARKETING_CREATIVE_SHORT_DAILY_CREDIT_CAP: credits, MARKETING_CREATIVE_SHORT_DAILY_VOICE_CHARS: chars, ELEVENLABS_API_KEY: "test-key" });
const image = (extra = {}) => ({ model: "gpt_image_2_6", aspect_ratio: "9:16", count: 1, prompt: "a quiet harbour at dawn, no text", ...extra });
const clip = (extra = {}) => ({ model: "kling3_0", aspect_ratio: "9:16", duration: 5, mode: "std", sound: "off", start_image: JOB, prompt: "slow push-in", ...extra });
const music = (extra = {}) => ({ model: "elevenlabs_music_v2_5", force_instrumental: true, duration: 26, prompt: "warm lo-fi, 90 bpm", ...extra });
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20)]);

/** A fake Higgsfield CLI: prices at `cost`, creates one job, finishes it. Records every command. */
function fakeCli({ cost = 7.5, created = [JOB], status = "completed" } = {}) {
  const calls = [];
  const cli = (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[1] === "cost") return { status: 0, stdout: JSON.stringify({ credits: cost }) };
    if (args[1] === "create") return { status: 0, stdout: JSON.stringify(created) };
    if (args[1] === "wait" || args[1] === "get") return { status: 0, stdout: JSON.stringify({ id: JOB, status, result_url: "https://cdn.example/x" }) };
    return { status: 1, stdout: "" };
  };
  return { cli, calls };
}

test("only the fixed frame, clip and music requests may be sent", () => {
  assert.equal(creativeRequestProblem(image()), null);
  assert.equal(creativeRequestProblem(clip()), null);
  assert.equal(creativeRequestProblem(music()), null);
  assert.equal(creativeRequestProblem(image({ aspect_ratio: "4:5" })), "aspect_ratio_not_allowed");
  assert.equal(creativeRequestProblem(image({ count: 2 })), "count_not_allowed");
  assert.equal(creativeRequestProblem(image({ quality: "max" })), "field_not_allowed:quality");
  assert.equal(creativeRequestProblem(clip({ mode: "pro" })), "mode_not_allowed");
  assert.equal(creativeRequestProblem(clip({ duration: 10 })), "duration_not_allowed");
  assert.equal(creativeRequestProblem(clip({ sound: "on" })), "sound_not_allowed");
  assert.equal(creativeRequestProblem(clip({ start_image: "./frame.png" })), "start_image_not_a_job_id");
  assert.equal(creativeRequestProblem(music({ duration: 60 })), "duration_not_allowed");
  assert.equal(creativeRequestProblem(music({ force_instrumental: false })), "force_instrumental_not_allowed");
  assert.equal(creativeRequestProblem(music({ lyrics: "la" })), "field_not_allowed:lyrics");
  assert.equal(creativeRequestProblem({ ...clip(), use_unlim: true }), "use_unlim_not_allowed");
  assert.equal(creativeRequestProblem({ model: "veo3", prompt: "x" }), "model_not_allowed");
});

test("without the creative cap nothing is priced or created", async () => {
  const jobDir = tempJob();
  const { cli, calls } = fakeCli();
  const result = await makeMedia({ request: clip(), out: join(jobDir, "c.mp4"), jobDir, env: {}, cli, fetchBytes: async () => MP4, day: DAY });
  assert.equal(result.reason, "no_daily_cap");
  assert.ok(!calls.includes("generate create"));
});

test("a clip is priced, recorded before it is created, and written; the image path's ledger is untouched", async () => {
  const jobDir = tempJob();
  const { cli, calls } = fakeCli();
  const out = join(jobDir, "c.mp4");
  const result = await makeMedia({ request: clip(), out, jobDir, env: capEnv(), cli, fetchBytes: async () => MP4, day: DAY });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["generate cost", "generate create", "generate wait"]);
  const entries = readLedger(creativeLedgerPath(jobDir, DAY)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "done");
  assert.equal(entries[0].cost, 7.5);
  assert.ok(existsSync(out));
  assert.ok(!existsSync(ledgerPath(jobDir, DAY)));
});

test("a price above the call's ceiling, or past the day's cap, is refused before anything is created", async () => {
  const jobDir = tempJob();
  const dear = fakeCli({ cost: 20 });
  const refused = await makeMedia({ request: clip(), out: join(jobDir, "a.mp4"), jobDir, env: capEnv(), cli: dear.cli, fetchBytes: async () => MP4, day: DAY });
  assert.equal(refused.reason, "cost_above_call_ceiling");
  assert.ok(!dear.calls.includes("generate create"));

  const env = capEnv("10");
  const first = await makeMedia({ request: clip(), out: join(jobDir, "b.mp4"), jobDir, env, cli: fakeCli().cli, fetchBytes: async () => MP4, day: DAY });
  assert.equal(first.ok, true);
  const second = fakeCli();
  const over = await makeMedia({ request: clip(), out: join(jobDir, "c.mp4"), jobDir, env, cli: second.cli, fetchBytes: async () => MP4, day: DAY });
  assert.equal(over.reason, "daily_cap_reached");
  assert.ok(!second.calls.includes("generate create"));
});

test("a create with no job id blocks the creative ledger for the day", async () => {
  const jobDir = tempJob();
  const lost = await makeMedia({ request: music(), out: join(jobDir, "m.mp3"), jobDir, env: capEnv(), cli: fakeCli({ cost: 3.8, created: [] }).cli, fetchBytes: async () => MP3, day: DAY });
  assert.equal(lost.reason, "create_outcome_unknown");
  const next = fakeCli({ cost: 0.25 });
  const blocked = await makeMedia({ request: image(), out: join(jobDir, "i.png"), jobDir, env: capEnv(), cli: next.cli, fetchBytes: async () => null, day: DAY });
  assert.equal(blocked.reason, "unknown_outcome_pending");
  assert.ok(!next.calls.includes("generate create"));
});

test("the image path's admit keeps its own rules by default", () => {
  const jobDir = tempJob();
  const refused = admit({ jobDir, day: DAY, env: { MARKETING_HIGGSFIELD_DAILY_CREDIT_CAP: "5" }, request: image(), cost: 0.25 });
  assert.equal(refused.reason, "aspect_ratio_not_allowed");
  const creativeCapOnly = admit({ jobDir, day: DAY, env: capEnv(), request: { model: "gpt_image_2_6", aspect_ratio: "4:5", count: 1, prompt: "x" }, cost: 0.25 });
  assert.equal(creativeCapOnly.reason, "no_daily_cap");
});

/** A fake fetch for ElevenLabs. */
function fakeFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (answer === "throw") throw new Error("socket hang up");
    return { status: answer.status, headers: new Map([["request-id", "req-1"]]), arrayBuffer: async () => answer.body ?? MP3 };
  };
  return { fetchImpl, calls };
}

test("a line is spoken in the locale's fixed voice and counted in characters", async () => {
  const jobDir = tempJob();
  const { fetchImpl, calls } = fakeFetch({ status: 200 });
  const out = join(jobDir, "ko.mp3");
  const result = await speakLine({ locale: "ko", text: "한 번 묻고, 다른 점을 보세요.", out, jobDir, env: capEnv(), fetchImpl, day: DAY });
  assert.equal(result.ok, true);
  assert.ok(calls[0].url.includes(VOICES.ko));
  assert.equal(JSON.parse(calls[0].init.body).model_id, "eleven_v4");
  assert.equal(calls[0].init.headers["xi-api-key"], "test-key");
  const [entry] = readLedger(voiceLedgerPath(jobDir, DAY)).entries;
  assert.equal(entry.cost, "한 번 묻고, 다른 점을 보세요.".length);
  assert.equal(entry.status, "done");
  assert.ok(existsSync(out));
});

test("a paid result's download is tried again and never throws", async () => {
  // 2026-11-10: a thrown fetch after the music was paid for ended the first run before its report.
  let tries = 0;
  const flaky = async () => {
    tries += 1;
    if (tries === 1) throw new Error("other side closed");
    if (tries === 2) return { ok: false, status: 503 };
    return { ok: true, arrayBuffer: async () => MP3 };
  };
  assert.deepEqual(await downloadResult("https://cdn.example/m.mp3", { maxBytes: 1024, waitMs: 1, fetchImpl: flaky }), MP3);
  assert.equal(tries, 3);
  const down = async () => { throw new Error("ECONNRESET"); };
  assert.equal(await downloadResult("https://cdn.example/m.mp3", { maxBytes: 1024, waitMs: 1, fetchImpl: down }), null);
  const big = async () => ({ ok: true, arrayBuffer: async () => Buffer.alloc(2048) });
  assert.equal(await downloadResult("https://cdn.example/m.mp3", { maxBytes: 1024, waitMs: 1, fetchImpl: big }), null);

  // A download that throws leaves the job settled and the run going: a refusal, not a crash.
  const jobDir = tempJob();
  const result = await makeMedia({ request: music(), out: join(jobDir, "m.mp3"), jobDir, env: capEnv(), cli: fakeCli({ cost: 3.8 }).cli, fetchBytes: down, day: DAY });
  assert.equal(result.reason, "result_not_the_media");
  assert.equal(readLedger(creativeLedgerPath(jobDir, DAY)).entries[0].status, "done");
});

test("a call whose price lookup crosses Brisbane midnight is refused before it is created or written", async () => {
  // The run fixes its day at the start; the ledger reads the clock again at admission.
  const jobDir = tempJob();
  let now = DAY;
  const { cli, calls } = fakeCli();
  const crossing = (args) => {
    const answer = cli(args);
    if (args[1] === "cost") now = "20261111";
    return answer;
  };
  const refused = await makeMedia({ request: clip(), out: join(jobDir, "c.mp4"), jobDir, env: capEnv(), cli: crossing, fetchBytes: async () => MP4, day: DAY, today: () => now });
  assert.equal(refused.reason, "day_changed");
  assert.deepEqual(calls.filter((call) => call === "generate create"), []);
  assert.deepEqual(readLedger(creativeLedgerPath(jobDir, DAY)).entries, []);

  const { fetchImpl, calls: sent } = fakeFetch({ status: 200 });
  const line = await speakLine({ locale: "en", text: "Ask once.", out: join(jobDir, "en.mp3"), jobDir, env: capEnv(), fetchImpl, day: DAY, today: () => "20261111" });
  assert.equal(line.reason, "day_changed");
  assert.equal(sent.length, 0);
  assert.deepEqual(readLedger(voiceLedgerPath(jobDir, DAY)).entries, []);

  // On the same day both are admitted as before.
  const same = await makeMedia({ request: clip(), out: join(jobDir, "d.mp4"), jobDir, env: capEnv(), cli: fakeCli().cli, fetchBytes: async () => MP4, day: DAY, today: () => DAY });
  assert.equal(same.ok, true);
});

test("no key, no cap, no voice for the locale, or past the character cap: nothing is sent", async () => {
  const jobDir = tempJob();
  for (const [args, reason] of [
    [{ locale: "en", env: { ...capEnv(), ELEVENLABS_API_KEY: "" } }, "no_api_key"],
    [{ locale: "en", env: { ELEVENLABS_API_KEY: "k" } }, "no_daily_cap"],
    [{ locale: "ja", env: capEnv() }, "locale_has_no_voice"],
    [{ locale: "en", env: capEnv("40", "5") }, "daily_cap_reached"],
  ]) {
    const { fetchImpl, calls } = fakeFetch({ status: 200 });
    const result = await speakLine({ text: "Ask once.", out: join(jobDir, "x.mp3"), jobDir, fetchImpl, day: DAY, ...args });
    assert.equal(result.reason, reason);
    assert.equal(calls.length, 0);
  }
});

test("a line with no answer may have been charged: it blocks every later line that day; a 4xx does not", async () => {
  const lostDir = tempJob();
  const lost = await speakLine({ locale: "en", text: "Ask once.", out: join(lostDir, "a.mp3"), jobDir: lostDir, env: capEnv(), fetchImpl: fakeFetch("throw").fetchImpl, day: DAY });
  assert.equal(lost.reason, "outcome_unknown");
  const after = fakeFetch({ status: 200 });
  const blocked = await speakLine({ locale: "en", text: "Again.", out: join(lostDir, "b.mp3"), jobDir: lostDir, env: capEnv(), fetchImpl: after.fetchImpl, day: DAY });
  assert.equal(blocked.reason, "unknown_outcome_pending");
  assert.equal(after.calls.length, 0);

  const refusedDir = tempJob();
  const refused = await speakLine({ locale: "en", text: "Ask once.", out: join(refusedDir, "a.mp3"), jobDir: refusedDir, env: capEnv(), fetchImpl: fakeFetch({ status: 422 }).fetchImpl, day: DAY });
  assert.equal(refused.reason, "refused_by_elevenlabs");
  const next = await speakLine({ locale: "en", text: "Ask once.", out: join(refusedDir, "b.mp3"), jobDir: refusedDir, env: capEnv(), fetchImpl: fakeFetch({ status: 200 }).fetchImpl, day: DAY });
  assert.equal(next.ok, true);
});

const PACKS = [
  { topic: "review-compare", locale: "en" },
  { topic: "review-compare", locale: "ko" },
  { topic: "review-compare", locale: "zh-Hant" },
];
const words = (locale) => ({ lines: ["One.", "Two.", "Three."], screen: ["Hook", AI_LINE[locale]], alt: "What it shows." });
const plan = (extra = {}) => ({
  concept: "Night market",
  logline: "Three stalls shout different prices; Tomverse shows where they differ.",
  topic: "review-compare",
  seconds: 24,
  shots: [{ id: "s1", image: "a night market stall, no text", motion: "slow dolly" }],
  music: "warm synth, 100 bpm",
  locales: { en: words("en"), ko: words("ko"), "zh-Hant": words("zh-Hant"), "zh-Hans": words("zh-Hans") },
  ...extra,
});
const answer = (value) => JSON.stringify({ creative: value });

test("a plan is made only for locales with a capture pack, and must show the AI line", () => {
  const ok = checkPlan(answer(plan()), { packs: PACKS });
  assert.deepEqual(ok.locales, ["en", "ko", "zh-Hant"]);
  const noLine = plan();
  noLine.locales.ko = { ...words("ko"), screen: ["Hook"] };
  assert.match(checkPlan(answer(noLine), { packs: PACKS }).refusal, /ko: screen must include the AI line/u);
  assert.match(checkPlan(answer(plan({ topic: "images" })), { packs: PACKS }).refusal, /no capture pack/u);
  assert.match(checkPlan(answer(plan({ shots: [1, 2, 3, 4].map((n) => ({ id: `s${n}`, image: "x", motion: "y" })) })), { packs: PACKS }).refusal, /at most 3/u);
  assert.match(checkPlan(answer(plan({ seconds: 60 })), { packs: PACKS }).refusal, /seconds/u);
  const url = plan();
  url.locales.en = { ...words("en"), lines: ["Visit www.example.com", "Two.", "Three."] };
  assert.match(checkPlan(answer(url), { packs: PACKS }).refusal, /web address/u);
  assert.match(checkPlan("no json here", { packs: PACKS }).refusal, /no \{"creative"/u);
});

test("a concept or logline used before is refused", () => {
  const history = [{ concept: "Night  Market!", logline: "something else" }];
  assert.match(checkPlan(answer(plan()), { packs: PACKS, history }).refusal, /used before/u);
});

test("the film may import only react, remotion and its own files, and stay a pure function of time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "film-"));
  const film = join(dir, "film");
  mkdirSync(film);
  const write = (source) => writeFileSync(join(film, "Film.tsx"), source);
  writeFileSync(join(film, "Card.tsx"), `import React from "react";\nexport const Card = () => <div />;`);
  write(`import React from "react";\nimport { AbsoluteFill, random } from "remotion";\nimport { Card } from "./Card";\nexport const Film = () => <AbsoluteFill><Card /></AbsoluteFill>;`);
  assert.deepEqual(await checkFilmSource(film), []);
  assert.deepEqual(await checkFilmSource(relative(process.cwd(), film)), [], "a relative folder, as the runner passes");
  for (const [source, pattern] of [
    [`import fs from "fs";`, /imports fs/u],
    [`import x from "@remotion/google-fonts/Lobster";`, /imports @remotion/u],
    [`import { Gone } from "./Gone";`, /not a file in film/u],
    [`import { Up } from "../entry";`, /imports \.\.\/entry/u],
    [`fetch("/x");`, /fetch/u],
    [`const u = "https://evil.example/a.png";`, /a URL/u],
    [`const n = Math.random();`, /randomness/u],
    [`const m = await import("./x");`, /dynamic import/u],
    [`process.env.X;`, /Node, webpack or page globals/u],
  ]) {
    write(source);
    assert.match((await checkFilmSource(film)).join("\n"), pattern, source);
  }
  write(`export const Film = () => null;`);
  writeFileSync(join(film, "run.sh"), "rm -rf /");
  assert.match((await checkFilmSource(film)).join("\n"), /only \.tsx and \.ts/u);
});

test("the film's imports are read by a parser: comments, webpack loaders, re-exports and unused imports do not slip past", async () => {
  const film = join(mkdtempSync(join(tmpdir(), "film-")), "film");
  mkdirSync(film);
  writeFileSync(join(film, "Loader.ts"), `export default function loader() { return ""; }`);
  const check = async (source) => {
    writeFileSync(join(film, "Film.tsx"), source);
    return (await checkFilmSource(film)).join("\n");
  };
  // The review's case: a comment between `from` and the string, and a webpack inline loader.
  assert.match(await check(`import x from /*comment*/ "!!./Loader.ts!./Film.tsx";\nexport const Film = () => null;`), /imports !!\.\/Loader\.ts!\.\/Film\.tsx/u);
  assert.match(await check(`import x from\n  // a line comment\n  "!./Loader.ts";\nexport const Film = () => null;`), /imports !\.\/Loader\.ts/u);
  // Kept although nothing uses it (verbatimModuleSyntax).
  assert.match(await check(`import unused from "node:fs";\nexport const Film = () => null;`), /imports node:fs/u);
  assert.match(await check(`export * from "left-pad";\nexport const Film = () => null;`), /imports left-pad/u);
  assert.match(await check(`import "fs";\nexport const Film = () => null;`), /imports fs/u);
  assert.match(await check(`const fs = globalThis["req" + "uire"]("fs");\nexport const Film = () => null;`), /globals/u);
  assert.match(await check(`export const Film = ( => null;`), /Film\.tsx:1/u);
});

test("both pack shapes are read the same way, and a pack's topic comes from its short when it names none", () => {
  const current = normalizePack({ assetId: "media-20261108-images-zh-hant-short", locale: "zh-Hant", videoAsset: "src.asset.json", captures: { answer: { file: "answer.png", text: "answer words" }, bad: { file: "../escape.png", text: "x" } } });
  assert.deepEqual(current, { assetId: "media-20261108-images-zh-hant-short", locale: "zh-Hant", topic: "images", captures: { answer: { file: "answer.png", text: "answer words" } }, videoAsset: "src.asset.json" });
  const first = normalizePack({ assetId: "media-20261101-review-compare-en-short", locale: "en", topic: "review-compare", videoAsset: "v.json", images: { left: "left.png", center: "center.png", right: "right.png", summary: "summary.png", logo: "logo.png" }, captureText: ["A", "B", "C"], summaryText: "S" });
  assert.equal(first.topic, "review-compare");
  assert.deepEqual(Object.keys(first.captures), ["left", "center", "right", "summary"]);
  assert.equal(first.captures.right.text, "C");
  assert.equal(first.captures.summary.text, "S");
  // A logo is not a product screen: a pack with only a logo has no capture.
  assert.equal(normalizePack({ assetId: "media-x-en-short", locale: "en", images: { logo: "logo.png" }, captureText: [] }), null);
  assert.equal(normalizePack({ assetId: "media-x-en-short", locale: "en", captures: { logo: { file: "logo.png", text: "" } } }), null);
  assert.equal(normalizePack({ assetId: "media-x-short", locale: "fr", captures: { a: { file: "a.png" } } }), null);
  assert.equal(normalizePack({ assetId: "media-x-short", locale: "en", captures: {} }), null);
});

test("a review passes only with the verdict pass and every score 8 or more", () => {
  const scores = { creative: 9, craft: 8, readability: 8, truth: 10, disclosure: 9 };
  assert.equal(reviewPassed({ verdict: "pass", scores }), true);
  assert.equal(reviewPassed({ verdict: "pass", scores: { ...scores, craft: 7 } }), false);
  assert.equal(reviewPassed({ verdict: "pass", scores: { creative: 9 } }), false);
  assert.equal(reviewPassed({ verdict: "pass", scores: { ...scores, truth: "10" } }), false);
  assert.equal(reviewPassed({ verdict: "pass" }), false);
  assert.equal(reviewPassed({ verdict: "fix", scores }), false);
  assert.equal(reviewPassed(null), false);
});

test("the asset carries the words inside the captures it shows and its source short's claims", () => {
  const { asset, transcript } = creativeAsset({ id: "media-20261110-creative-en-short", locale: "en", words: words("en"), captureWords: ["GPT 6 Luna  says\nhello", "", "AGREE 7"], claimIds: ["claim-a", "claim-a"], today: new Date("2026-11-10T00:00:00Z") });
  assert.equal(marketingAssetSchema.safeParse(asset).success, true);
  assert.deepEqual(asset.claimIds, ["claim-a"]);
  assert.ok(transcript.en.endsWith("GPT 6 Luna says hello\nAGREE 7"));
});

test("captures come only from shorts approved now and still valid", () => {
  const packs = [
    { assetId: "media-a-en-short", topic: "t", locale: "en" },
    { assetId: "media-b-ko-short", topic: "t", locale: "ko" },
    { assetId: "media-c-zh-hant-short", topic: "t", locale: "zh-Hant" },
    { topic: "t", locale: "en" },
  ];
  const approved = [{ id: "media-a-en-short", validUntil: "2027-01-30" }, { id: "media-c-zh-hant-short", validUntil: "2026-11-09" }];
  assert.deepEqual(usablePacks(packs, approved, "2026-11-09").map((pack) => pack.assetId), ["media-a-en-short", "media-c-zh-hant-short"]);
  assert.deepEqual(usablePacks(packs, approved, "2026-11-10").map((pack) => pack.assetId), ["media-a-en-short"]);
  assert.deepEqual(usablePacks(packs, null, "2026-11-10"), []);
});

test("off the Linux box, the renderer refuses to run the film without its sandbox", { skip: process.platform === "linux" }, () => {
  const tool = resolve("tools/marketing-video");
  const ran = spawnSync(process.execPath, [join(tool, "render-creative.mjs"), tmpdir(), "en", "--stills"], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? "" } });
  assert.equal(ran.status, 1);
  assert.match(JSON.parse(ran.stdout.trim().split("\n").at(-1)).error, /no sandbox here/u);
});

test("a finished file is 1080x1920, 10-60 s, with sound", () => {
  const good = { streams: [{ codec_type: "video", width: 1080, height: 1920 }, { codec_type: "audio" }], format: { duration: "24.1" } };
  assert.deepEqual(checkFinal(good), []);
  assert.deepEqual(checkFinal({ ...good, streams: [good.streams[0]] }), ["no sound"]);
  assert.deepEqual(checkFinal({ ...good, format: { duration: "75" } }), ["not 10-60 seconds long"]);
});

test("the asset file is AI-origin with a disclosure on every channel, and zh-Hans goes to RedNote only", () => {
  for (const locale of ["en", "ko", "zh-Hant", "zh-Hans"]) {
    const { asset, transcript } = creativeAsset({ id: `media-20261110-creative-${locale.toLowerCase()}-short`, locale, words: words(locale), today: new Date("2026-11-10T00:00:00Z") });
    assert.equal(marketingAssetSchema.safeParse(asset).success, true, locale);
    assert.equal(asset.provenance, "capture_with_ai_media");
    assert.equal(asset.depictsProductInterface, true);
    assert.ok(Object.values(asset.disclosure).every((value) => value !== "none"));
    assert.deepEqual(asset.allowedChannels, locale === "zh-Hans" ? ["rednote"] : ["instagram", "youtube", "tiktok", "x"]);
    assert.ok(transcript[locale].includes(AI_LINE[locale]));
    assert.ok(transcript[locale].includes("tomverse.app"));
  }
});

test("the job does nothing while its switch is off, and stops before spending without its caps", () => {
  const tool = resolve("tools/marketing-video");
  const runOff = spawnSync(process.execPath, [join(tool, "run-creative-short.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(runOff.status, 0);
  assert.equal(JSON.parse(runOff.stdout.trim().split("\n").at(-1)).halted, "switch_off");
  const noCap = spawnSync(process.execPath, [join(tool, "run-creative-short.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH, MARKETING_CREATIVE_SHORT: "on" } });
  assert.equal(noCap.status, 1);
  assert.equal(JSON.parse(noCap.stdout.trim().split("\n").at(-1)).halted, "no_credit_cap");
});

test("model file rules are absolute, so a cd in the model's shell cannot move them", async () => {
  const posixResolve = (file) => `/home/tommy/job-checkout/tools/marketing-video/${file}`;
  assert.equal(fileRule("Edit", "job/creative/20261110-2/film/**", posixResolve, "/"), "Edit(//home/tommy/job-checkout/tools/marketing-video/job/creative/20261110-2/film/**)");
  const backslash = String.fromCharCode(92);
  const windowsResolve = (file) => ["C:", "work", "tools", "marketing-video", ...file.split("/")].join(backslash);
  assert.equal(fileRule("Read", "job/sources/**", windowsResolve, backslash), "Read(//c/work/tools/marketing-video/job/sources/**)");
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/marketing-video/run-creative-short.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:Read|Edit|Write)\(\.\//u, "no relative file rule is left");
  assert.doesNotMatch(source, /`Write\(/u, "Write rules match nothing; Edit covers Write");
});

test("a Read-only call is handed every still by name, since Read cannot list a folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "creative-stills-"));
  for (const name of ["f-02-3.8s.png", "f-01-1.3s.png", "notes.txt", "f-03-6.3s.jpg", "f-04-8.8s.png"]) writeFileSync(join(dir, name), "x");
  const posixDir = dir.split(/[\\/]/u).join("/");
  assert.deepEqual(stillsIn(dir), ["f-01-1.3s.png", "f-02-3.8s.png", "f-03-6.3s.jpg", "f-04-8.8s.png"].map((name) => `${posixDir}/${name}`));
  assert.deepEqual(stillsIn(dir, 2), [`${posixDir}/f-01-1.3s.png`, `${posixDir}/f-03-6.3s.jpg`]);
  assert.deepEqual(stillsIn(join(dir, "missing")), []);
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/marketing-video/run-creative-short.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /stills in job\/creative\/\$\{run\}\/review\/\$\{locale\}\/;/u, "the review prompt names files, not a folder");
  assert.doesNotMatch(source, /job\/creative\/sheets\/\$\{entry\.run\}\//u, "earlier films are named by file too");
});

test("a run's last build round and review verdict are read from its call transcripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "creative-calls-"));
  assert.deepEqual(lastBuild(join(dir, "missing")), { rounds: 0, review: null });
  const stream = (result) => [JSON.stringify({ type: "system" }), JSON.stringify({ type: "result", result }), ""].join("\n");
  writeFileSync(join(dir, "build-1.jsonl"), stream("built"));
  writeFileSync(join(dir, "build-2.jsonl"), stream("built"));
  writeFileSync(join(dir, "review-1.jsonl"), stream(JSON.stringify({ review: { verdict: "reject", notes: "old" } })));
  writeFileSync(join(dir, "review-2.jsonl"), stream(JSON.stringify({ review: { verdict: "fix", notes: "make the screens readable" } })));
  writeFileSync(join(dir, "plan-1.jsonl"), stream("{}"));
  assert.deepEqual(lastBuild(dir), { rounds: 2, review: { verdict: "fix", notes: "make the screens readable" } });
  writeFileSync(join(dir, "review-3.jsonl"), "not a stream");
  assert.deepEqual(lastBuild(dir), { rounds: 2, review: null }, "the newest review decides, even when it gave no answer");
  assert.equal(answerOf(`${stream("first")}${stream("second")}`), "second");
  assert.equal(answerOf(""), null);
});

test("a rebuild reuses the run's paid media: it never reaches a paid step, and a missing run stops it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/marketing-video/run-creative-short.mjs", import.meta.url), "utf8");
  const start = source.indexOf("if (rebuild !== null) {");
  const end = source.indexOf("// 1. Plan.");
  assert.ok(start > 0 && end > start, "the rebuild branch sits before the plan");
  assert.ok(start < source.indexOf("await paid("), "and before every paid call");
  const branch = source.slice(start, end);
  assert.doesNotMatch(branch, /paid\(|speakLine\(|makeMedia\(/u);
  assert.match(branch, /halt\("rejected_before"\)/u);
  assert.match(branch, /await finishFilm\(/u);
  const shell = await readFile(new URL("../tools/marketing-video/run-creative-short.sh", import.meta.url), "utf8");
  assert.match(shell, /node run-creative-short\.mjs "\$@"/u, "the shell passes --rebuild on");
  const tool = resolve("tools/marketing-video");
  const env = { PATH: process.env.PATH, MARKETING_CREATIVE_SHORT: "on", [CREATIVE_CAP_ENV]: "1", [VOICE_CAP_ENV]: "1", ELEVENLABS_API_KEY: "test", MARKETING_APP_URL: "http://localhost:1", MARKETING_MEDIA_SUBMIT_SECRET: "test" };
  for (const name of ["../../etc", "20991231-9", ""]) {
    const out = spawnSync(process.execPath, [join(tool, "run-creative-short.mjs"), "--rebuild", name], { encoding: "utf8", env });
    assert.equal(out.status, 1);
    assert.equal(JSON.parse(out.stdout.trim().split("\n").at(-1)).halted, "no_such_run");
  }
});

test("a rebuild takes words and claims only from the approved pack whose files the run copied", () => {
  const root = mkdtempSync(join(tmpdir(), "creative-packof-"));
  const packDir = (name, bytes) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "answer.png"), bytes);
    return { topic: "review-compare", locale: "ko", dir, claimIds: [`claim-${name}`], captures: { answer: { file: "answer.png", text: `words ${name}` } } };
  };
  const a = packDir("a", "picture A");
  const b = packDir("b", "picture B");
  const copied = join(root, "run", "capture", "ko");
  mkdirSync(copied, { recursive: true });
  writeFileSync(join(copied, "answer.png"), "picture A");
  assert.deepEqual(packOfRun(copied, [b, a], "review-compare", "ko"), { pack: a, words: ["words a"] });
  assert.equal(packOfRun(copied, [b], "review-compare", "ko"), null, "A no longer approved: B's words are never put on A's pictures");
  assert.equal(packOfRun(copied, [a], "review-compare", "en"), null);
  assert.equal(packOfRun(join(root, "none"), [a], "review-compare", "ko"), null);
  writeFileSync(join(copied, "extra.png"), "x");
  assert.equal(packOfRun(copied, [a], "review-compare", "ko"), null, "the copied set must be the pack's set exactly");
});
