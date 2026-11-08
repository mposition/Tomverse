import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { admit, dailyCap, ledgerPath, readLedger, requestProblem, spent } from "../tools/marketing-video/higgsfield-cap.mjs";
import { makeImage } from "../tools/marketing-video/hf-image-core.mjs";
import { checkConcepts, pickFeature } from "../tools/marketing-video/concepts-core.mjs";
import { checkReview } from "../tools/marketing-video/review-core.mjs";

/**
 * The media job's Higgsfield image path (owner 2026-11-08). Higgsfield is paid,
 * so the cap is deterministic code a model cannot widen: one 4:5 gpt_image_2_6
 * picture per call, a daily ledger under MARKETING_HIGGSFIELD_DAILY_CREDIT_CAP
 * (unset or 0 refuses everything), and a call whose outcome is unknown is
 * looked up by its job id before anything else is sent. The model's concepts
 * and reviews pass a format check before any script acts on them. No test
 * here calls Higgsfield: the CLI is a fake.
 */

const tool = resolve("tools/marketing-video");
const DAY = "20261108";
const request = (extra = {}) => ({ model: "gpt_image_2_6", aspect_ratio: "4:5", count: 1, prompt: "a person on a train with a phone", ...extra });
const capEnv = (cap) => ({ MARKETING_HIGGSFIELD_DAILY_CREDIT_CAP: cap });
const tempJob = () => mkdtempSync(join(tmpdir(), "hf-cap-"));

test("only one 4:5 gpt_image_2_6 picture, with no unlimited mode, may be asked for", () => {
  assert.equal(requestProblem(request()), null);
  assert.equal(requestProblem(request({ model: "marketing_studio_image" })), "model_not_allowed");
  assert.equal(requestProblem(request({ aspect_ratio: "9:16" })), "aspect_ratio_not_allowed");
  assert.equal(requestProblem(request({ count: 2 })), "count_not_one");
  assert.equal(requestProblem(request({ use_unlim: false })), "use_unlim_not_allowed");
  assert.equal(requestProblem(request({ batch_size: 4 })), "field_not_allowed:batch_size");
});

test("a missing, zero or unreadable cap refuses every call", () => {
  for (const value of [undefined, "", "0", "0.0", "-1", "abc", "1e9"]) assert.equal(dailyCap(capEnv(value)), null, String(value));
  assert.equal(dailyCap(capEnv("2.5")), 2.5);
  const jobDir = tempJob();
  try {
    assert.deepEqual(admit({ jobDir, day: DAY, env: {}, request: request() }), { ok: false, reason: "no_daily_cap" });
    assert.deepEqual(admit({ jobDir, day: DAY, env: capEnv("0"), request: request() }), { ok: false, reason: "no_daily_cap" });
    assert.equal(existsSync(ledgerPath(jobDir, DAY)), false, "a refused call leaves no entry");
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("the ledger adds every admitted call and refuses the one that would pass the cap", () => {
  const jobDir = tempJob();
  try {
    const file = ledgerPath(jobDir, DAY);
    for (let i = 0; i < 4; i += 1) {
      const admitted = admit({ jobDir, day: DAY, env: capEnv("1"), request: request() });
      assert.equal(admitted.ok, true);
      // Settled so the next call is not held by an unknown outcome.
      const ledger = readLedger(file);
      ledger.entries.at(-1).status = "done";
      writeFileSync(file, JSON.stringify(ledger));
    }
    assert.equal(spent(readLedger(file)), 1);
    // A cap a fraction below the price refuses: only float error is forgiven.
    const fresh = tempJob();
    assert.equal(admit({ jobDir: fresh, day: DAY, env: capEnv("0.246"), request: request() }).reason, "daily_cap_reached");
    rmSync(fresh, { recursive: true, force: true });
    const refused = admit({ jobDir, day: DAY, env: capEnv("1"), request: request() });
    assert.equal(refused.reason, "daily_cap_reached");
    assert.equal(readLedger(file).entries.length, 4);
    // A failed call still counts: it may have been charged.
    const ledger = readLedger(file);
    ledger.entries[0].status = "failed";
    writeFileSync(file, JSON.stringify(ledger));
    assert.equal(admit({ jobDir, day: DAY, env: capEnv("1"), request: request() }).reason, "daily_cap_reached");
    // A quoted price above the known one is what is recorded.
    assert.equal(admit({ jobDir, day: DAY, env: capEnv("5"), request: request(), cost: 0.4 }).entry.cost, 0.4);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

/** A fake Higgsfield CLI: answers by subcommand and records every call. */
function fakeCli(script) {
  const calls = [];
  const cli = (args) => {
    calls.push(args);
    const answer = script[args[1]];
    const value = typeof answer === "function" ? answer(args, calls) : answer;
    return value ?? { status: 1, stdout: "", stderr: "unexpected", timedOut: false };
  };
  return { cli, calls, count: (sub) => calls.filter((args) => args[1] === sub).length };
}
const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]);

test("a picture is priced, recorded, created, waited for and written", async () => {
  const jobDir = tempJob();
  try {
    const fake = fakeCli({
      cost: ok({ credits: 0.25 }),
      create: ok([{ id: "job-a", status: "queued" }]),
      wait: ok([{ id: "job-a", status: "completed", result: { images: [{ url: "https://cdn.example/a.png" }] } }]),
    });
    const out = join(jobDir, "a.png");
    const made = await makeImage({ prompt: "scene", out, label: "c1/en/make", jobDir, day: DAY, env: capEnv("1"), cli: fake.cli, fetchBytes: async () => PNG });
    assert.deepEqual({ ok: made.ok, jobId: made.jobId }, { ok: true, jobId: "job-a" });
    assert.ok(existsSync(out));
    const [entry] = readLedger(ledgerPath(jobDir, DAY)).entries;
    assert.deepEqual({ status: entry.status, jobId: entry.jobId, cost: entry.cost, label: entry.label }, { status: "done", jobId: "job-a", cost: 0.25, label: "c1/en/make" });
    const create = fake.calls.find((args) => args[1] === "create");
    assert.deepEqual(create.slice(0, 7), ["generate", "create", "gpt_image_2_6", "--prompt", create[4], "--aspect_ratio", "4:5"]);
    assert.ok(!create.includes("--wait"), "create returns the job id at once; waiting is a separate call");
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("after a timeout nothing is sent again until the job id shows the outcome", async () => {
  const jobDir = tempJob();
  try {
    let status = "in_progress";
    const fake = fakeCli({
      cost: ok({ credits: 0.25 }),
      create: ok({ id: "job-t" }),
      wait: { status: 1, stdout: "", stderr: "Timeout after 20m", timedOut: false },
      get: () => ok({ id: "job-t", status }),
    });
    const call = () => makeImage({ prompt: "scene", out: join(jobDir, "t.png"), jobDir, day: DAY, env: capEnv("5"), cli: fake.cli, fetchBytes: async () => PNG });
    assert.equal((await call()).reason, "wait_outcome_unknown");
    assert.equal(readLedger(ledgerPath(jobDir, DAY)).entries[0].status, "unknown");
    // Still running: refused, and no second create.
    assert.equal((await call()).reason, "unknown_outcome_pending");
    assert.equal(fake.count("create"), 1);
    // The job id now shows it finished: the next call may go.
    status = "completed";
    assert.equal((await call()).reason, "wait_outcome_unknown");
    assert.equal(fake.count("create"), 2);
    assert.equal(readLedger(ledgerPath(jobDir, DAY)).entries[0].status, "done");
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("a create with no answer stays unknown with no job id, and blocks the day", async () => {
  const jobDir = tempJob();
  try {
    const failing = { status: 1, stdout: "", stderr: "network", timedOut: true };
    // Nothing ties a listed job to this request, so the list is not read.
    const empty = fakeCli({ cost: ok({ credits: 0.25 }), create: failing, list: ok([{ id: "job-earlier", created_at: new Date().toISOString() }]) });
    const args = { prompt: "scene", out: join(jobDir, "x.png"), jobDir, day: DAY, env: capEnv("5"), fetchBytes: async () => PNG };
    assert.equal((await makeImage({ ...args, cli: empty.cli })).reason, "create_outcome_unknown");
    const [entry] = readLedger(ledgerPath(jobDir, DAY)).entries;
    assert.deepEqual({ status: entry.status, jobId: entry.jobId }, { status: "unknown", jobId: null });
    // No job id to look up: every later call of the day is refused before pricing.
    const later = fakeCli({ cost: ok({ credits: 0.25 }), create: ok({ id: "job-z" }) });
    assert.equal((await makeImage({ ...args, cli: later.cli })).reason, "unknown_outcome_pending");
    assert.equal(later.count("create"), 0);
    assert.equal(later.count("cost"), 0);
    assert.equal(empty.count("list"), 0, "no listed job is tied to the request");
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("more than one job for one picture keeps every id, counts each, and blocks the day for a person", async () => {
  const jobDir = tempJob();
  try {
    const many = fakeCli({ cost: ok({ credits: 0.25 }), create: ok([{ id: "job-1" }, { id: "job-2" }, { id: "job-3" }]), get: ok({ status: "completed" }) });
    const args = { prompt: "scene", out: join(jobDir, "x.png"), jobDir, day: DAY, env: capEnv("5"), fetchBytes: async () => PNG, cli: many.cli };
    assert.equal((await makeImage(args)).reason, "more_than_one_job");
    const [entry] = readLedger(ledgerPath(jobDir, DAY)).entries;
    assert.deepEqual({ jobIds: entry.jobIds, cost: entry.cost, status: entry.status, needsPerson: entry.needsPerson }, { jobIds: ["job-1", "job-2", "job-3"], cost: 0.75, status: "unknown", needsPerson: true });
    // No automatic lookup clears it, even though each job reads as completed.
    assert.equal((await makeImage(args)).reason, "unknown_outcome_pending");
    assert.equal(many.count("get"), 0);
    assert.equal(many.count("create"), 1);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("a held ledger lock refuses the call", () => {
  const jobDir = tempJob();
  try {
    writeFileSync(`${ledgerPath(jobDir, DAY)}.lock`, "");
    assert.deepEqual(admit({ jobDir, day: DAY, env: capEnv("5"), request: request(), lockWaitMs: 100 }), { ok: false, reason: "ledger_locked" });
    assert.equal(existsSync(ledgerPath(jobDir, DAY)), false);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("two runs admitting at the same moment never both get the one call the ledger allows", async () => {
  const cap = new URL("../tools/marketing-video/higgsfield-cap.mjs", import.meta.url).href;
  // Each run admits once at the same instant. An admitted call stays unsettled,
  // so the ledger allows exactly one: without the lock both read an empty
  // ledger, both are admitted, and one entry is lost.
  const script = `const { admit } = await import(${JSON.stringify(cap)});
const start = Number(process.argv[1]); while (Date.now() < start) {}
const r = admit({ jobDir: process.argv[2], day: "${DAY}", env: { MARKETING_HIGGSFIELD_DAILY_CREDIT_CAP: "5" }, request: { model: "gpt_image_2_6", aspect_ratio: "4:5", count: 1, prompt: "p" } });
console.log(r.ok ? "ok" : r.reason);`;
  const run = (start, jobDir) =>
    new Promise((done) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(start), jobDir]);
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("close", () => done(out.trim()));
    });
  for (let round = 0; round < 4; round += 1) {
    const jobDir = tempJob();
    try {
      const start = Date.now() + 1200;
      const answers = await Promise.all([run(start, jobDir), run(start, jobDir), run(start, jobDir)]);
      const ledger = readLedger(ledgerPath(jobDir, DAY));
      assert.equal(answers.filter((answer) => answer === "ok").length, 1, JSON.stringify(answers));
      assert.equal(ledger.entries.length, 1);
    } finally {
      rmSync(jobDir, { recursive: true, force: true });
    }
  }
});

test("a price that cannot be read or is above the call ceiling refuses before anything is recorded", async () => {
  const jobDir = tempJob();
  try {
    const args = { prompt: "scene", out: join(jobDir, "x.png"), jobDir, day: DAY, env: capEnv("5"), fetchBytes: async () => PNG };
    assert.equal((await makeImage({ ...args, cli: fakeCli({ cost: ok({ note: "n/a" }) }).cli })).reason, "cost_unreadable");
    assert.equal((await makeImage({ ...args, cli: fakeCli({ cost: ok({ credits: 2.75 }) }).cli })).reason, "cost_above_call_ceiling");
    assert.equal(existsSync(ledgerPath(jobDir, DAY)), false);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

const texts = [
  { role: "headline", text: "Ask GPT, Claude, Gemini and more" },
  { role: "screen", text: "Which model should answer this?" },
];
const translations = {
  ko: [
    { role: "headline", text: "GPT, Claude, Gemini 등에 물어보세요" },
    { role: "screen", text: "어떤 모델이 답하면 좋을까요?" },
  ],
  "zh-Hant": [
    { role: "headline", text: "問 GPT、Claude、Gemini 等" },
    { role: "screen", text: "這個問題該讓哪個模型回答？" },
  ],
  "zh-Hans": [
    { role: "headline", text: "问 GPT、Claude、Gemini 等" },
    { role: "screen", text: "这个问题该让哪个模型回答？" },
  ],
};
const concept = (id, extra = {}) => ({
  id,
  feature: "chat",
  device: `a commuter on a train picks a model on a phone ${id}`,
  prompt_en: `A candid photo of a commuter on a morning train holding a phone in a natural grip, the screen showing a chat app with model chips. ${"Soft window light, shallow depth of field, real people around. ".repeat(4)}`,
  texts,
  logos: ["chatgpt", "claude", "gemini"],
  factRefs: ["chat.what", "chat.models"],
  translations,
  alt: { en: "A commuter on a train picks a model on a phone.", ko: "기차 안에서 휴대폰으로 모델을 고르는 사람.", "zh-Hant": "通勤者在火車上用手機選擇模型的照片。", "zh-Hans": "通勤者在火车上用手机选择模型的照片。" },
  ...extra,
});
const conceptsOf = (...list) => ({ date: "2026-11-08", feature: "chat", concepts: list });
const check = (answer, history = []) => checkConcepts(answer, { feature: "chat", history, day: DAY, toolDir: tool });

test("well-formed concepts pass", () => {
  assert.equal(check(conceptsOf(concept("c1"), concept("c2"))), null);
});

test("concepts with the wrong shape, feature or count are refused", () => {
  assert.match(check(conceptsOf(concept("c1"))), /2-3 entries/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { feature: "review" }))), /today's/u);
  const { alt, ...noAlt } = concept("c2");
  assert.match(check(conceptsOf(concept("c1"), noAlt)), /keys must be exactly/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { logos: ["../secret"] }))), /not a file in public\/model-icons/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { factRefs: ["chat.price"] }))), /not in features\.json/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { device: concept("c1").device }))), /share a device/u);
});

test("banned words, unconditioned free, untranslated names and unknown models are refused", () => {
  const withText = (text, locale = null) =>
    concept("c2", locale ? { translations: { ...translations, [locale]: [translations[locale][0], { role: "screen", text }] } } : { texts: [texts[0], { role: "screen", text }] });
  assert.match(check(conceptsOf(concept("c1"), withText("Visit tomverse.app today"))), /Tomverse name/u);
  assert.match(check(conceptsOf(concept("c1"), withText("Try it free"))), /free/u);
  assert.equal(check(conceptsOf(concept("c1"), withText("Free to try within the included credits"))), null);
  assert.match(check(conceptsOf(concept("c1"), withText("Ask GPT and Claude at once"))), /and more/u);
  assert.match(check(conceptsOf(concept("c1"), withText("Try GPT 9 Ultra and more"))), /not a model name/u);
  assert.match(check(conceptsOf(concept("c1"), withText("지피티와 클로드에게 물어보세요", "ko"))), /stay as written/u);
  assert.match(check(conceptsOf(concept("c1"), withText("问克劳德", "zh-Hans"))), /stay as written/u);
  assert.match(check(conceptsOf(concept("c1"), withText("這個問題", "zh-Hans"))), /Simplified/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { prompt_en: `${concept("c2").prompt_en} with a purple glow` }))), /#155dfb/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { prompt_en: `${concept("c2").prompt_en} and the Tomverse logo` }))), /never names Tomverse/u);
});

test("an answer under a real model name must be its recorded answer, untranslated", () => {
  const quoted = (text, translated = text) =>
    concept("c2", {
      texts: [texts[0], { role: "answer", speaker: "Gemini Flash", text }],
      translations: Object.fromEntries(Object.entries(translations).map(([locale, list]) => [locale, [list[0], { role: "answer", speaker: "Gemini Flash", text: translated }]])),
    });
  assert.equal(check(conceptsOf(concept("c1"), quoted("Skip the Scenic Railway (which has steep steps)"))), null);
  assert.match(check(conceptsOf(concept("c1"), quoted("The Scenic Railway is perfect for everyone"))), /recorded answer/u);
  assert.match(check(conceptsOf(concept("c1"), quoted("Skip the Scenic Railway (which has steep steps)", "풍경 열차는 건너뛰세요"))), /not translated/u);
});

test("a scene idea used in the last 14 days is refused, an older one is not", () => {
  const used = concept("c2").device;
  assert.match(check(conceptsOf(concept("c1"), concept("c2")), [{ date: "2026-11-01", feature: "review", device: used }]), /last 14 days/u);
  assert.equal(check(conceptsOf(concept("c1"), concept("c2")), [{ date: "2026-10-01", feature: "review", device: used }]), null);
});

test("today's feature is the oldest shown, never the last run's", () => {
  const features = [{ id: "chat" }, { id: "review" }, { id: "files" }];
  assert.equal(pickFeature([], features, DAY), "chat");
  assert.equal(pickFeature([{ date: "2026-11-07", feature: "chat" }], features, DAY), "review");
  assert.equal(
    pickFeature([{ date: "2026-11-05", feature: "review" }, { date: "2026-11-06", feature: "files" }, { date: "2026-11-07", feature: "chat" }], features, DAY),
    "review",
  );
});

const reviewOf = (extra = {}) => ({
  id: "c1",
  verdict: "pass",
  fixes: [],
  logoBoxes: [{ logo: "claude", cx: 0.5, cy: 0.4, size: 0.06, rotate: 0, flat: true, shapeOk: true }],
  textBoxes: [{ textIndex: 0, role: "headline", x: 0.08, y: 0.06, w: 0.84, h: 0.14, rotate: 0, bg: "#f7f8fa" }],
  ...extra,
});
const line = (value) => `Here it is.\n${JSON.stringify(value)}\n`;

test("a guide review of the agreed shape is kept; pass, fix and reject are read", () => {
  const c = concept("c1");
  assert.equal(checkReview(line(reviewOf()), { stage: "guide", concept: c, locale: "en" }).review.verdict, "pass");
  assert.equal(checkReview(line(reviewOf({ verdict: "fix", fixes: ["Move the thumb behind the phone"] })), { stage: "guide", concept: c, locale: "en" }).review.verdict, "fix");
  assert.equal(checkReview(line(reviewOf({ verdict: "reject" })), { stage: "guide", concept: c, locale: "en" }).review.verdict, "reject");
  assert.match(checkReview(line(reviewOf({ verdict: "fix" })), { stage: "guide", concept: c, locale: "en" }).problem, /lists what to fix/u);
  assert.match(checkReview(line(reviewOf({ verdict: "great" })), { stage: "guide", concept: c, locale: "en" }).problem, /verdict/u);
  assert.match(checkReview("no json here", { stage: "guide", concept: c, locale: "en" }).problem, /no review line/u);
  assert.match(checkReview(line({ ...reviewOf(), extra: 1 }), { stage: "guide", concept: c, locale: "en" }).problem, /keys must be exactly/u);
});

test("boxes outside the picture, unknown logos and bad colours are refused; a tilted wrong mark forces a fix", () => {
  const c = concept("c1");
  const run = (extra) => checkReview(line(reviewOf(extra)), { stage: "guide", concept: c, locale: "en" });
  assert.match(run({ logoBoxes: [{ logo: "claude", cx: 1.2, cy: 0.4, size: 0.06, rotate: 0, flat: true, shapeOk: true }] }).problem, /fractions 0-1/u);
  assert.match(run({ logoBoxes: [{ logo: "claude", cx: 0.5, cy: 0.4, size: 0.9, rotate: 0, flat: true, shapeOk: true }] }).problem, /size/u);
  assert.match(run({ logoBoxes: [{ logo: "grok", cx: 0.5, cy: 0.4, size: 0.06, rotate: 0, flat: true, shapeOk: true }] }).problem, /not one of the concept's logos/u);
  assert.match(run({ textBoxes: [{ textIndex: 0, role: "headline", x: 0.5, y: 0.1, w: 0.7, h: 0.1, rotate: 0, bg: "#ffffff" }] }).problem, /inside the picture/u);
  assert.match(run({ textBoxes: [{ textIndex: 9, role: "headline", x: 0.1, y: 0.1, w: 0.5, h: 0.1, rotate: 0, bg: "#ffffff" }] }).problem, /textIndex/u);
  assert.match(run({ textBoxes: [{ textIndex: 0, role: "headline", x: 0.1, y: 0.1, w: 0.5, h: 0.1, rotate: 0, bg: "blue" }] }).problem, /#rrggbb/u);
  const tilted = run({ logoBoxes: [{ logo: "claude", cx: 0.5, cy: 0.4, size: 0.06, rotate: 20, flat: false, shapeOk: false }] }).review;
  assert.equal(tilted.verdict, "fix");
});

test("the content review passes only when the words read match the approved words exactly", () => {
  const c = concept("c1");
  const read = (readTexts, locale = "ko") => checkReview(line(reviewOf({ readTexts })), { stage: "content", concept: c, locale }).review;
  assert.equal(read(translations.ko.map((text) => text.text)).verdict, "pass");
  assert.equal(read(["GPT, Claude, Gemini 등에 물어보세요", "어떤 모델이 답하면 좋을까요?", "Claude"]).verdict, "pass", "a provider's own name on its mark may stand");
  const wrong = read(["GPT, Claude, Gemini 등에 물어보세요", "어떤 모델이 담하면 좋을까요?"]);
  assert.equal(wrong.verdict, "fix");
  assert.ok(wrong.fixes.some((fix) => fix.includes("어떤 모델이 답하면 좋을까요?")));
  assert.equal(read(["GPT, Claude, Gemini 등에 물어보세요"]).verdict, "fix", "a missing text is not a pass");
  assert.match(checkReview(line(reviewOf()), { stage: "content", concept: c, locale: "ko" }).problem, /keys must be exactly/u);
});

// The picture steps run in Chromium (playwright), where the tool's packages are installed.
const playwrightReady = (() => {
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('playwright')"], { cwd: tool });
  return probe.status === 0;
})();
const skip = playwrightReady ? false : "tools/marketing-video packages are not installed";

function solidPng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** RGB of one pixel of a PNG file, read in Chromium. */
async function pixelAt(file, x, y) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ([b64, px, py]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(px, py, 1, 1).data.slice(0, 3)];
      },
      [readFileSync(file).toString("base64"), x, y],
    );
  } finally {
    await browser.close();
  }
}

test("a flat mark is painted over with the real logo where the review put it, and nowhere else", { skip }, async () => {
  const { setLogos } = await import("../tools/marketing-video/compose-core.mjs");
  const dir = mkdtempSync(join(tmpdir(), "hf-logo-"));
  try {
    const input = join(dir, "in.png");
    const out = join(dir, "out.png");
    writeFileSync(input, solidPng(400, 500, [120, 140, 160]));
    const drawn = await setLogos({
      input,
      out,
      review: { logoBoxes: [{ logo: "claude", cx: 0.25, cy: 0.3, size: 0.2, rotate: 0, flat: true, shapeOk: true }, { logo: "gemini", cx: 0.7, cy: 0.7, size: 0.1, rotate: 30, flat: false, shapeOk: true }] },
    });
    assert.equal(drawn, 1, "only the flat mark is painted");
    // Far from both marks, and at the tilted mark: unchanged.
    assert.deepEqual(await pixelAt(out, 380, 20), [120, 140, 160]);
    assert.deepEqual(await pixelAt(out, 280, 350), [120, 140, 160]);
    // Inside the flat mark's square the picture changed (the logo, multiplied onto the cover).
    let changed = 0;
    for (const [x, y] of [[100, 150], [90, 140], [110, 160], [100, 135], [85, 150]]) {
      const [r, g, b] = await pixelAt(out, x, y);
      if (Math.abs(r - 120) + Math.abs(g - 140) + Math.abs(b - 160) > 30) changed += 1;
    }
    assert.ok(changed >= 1, "the logo is drawn inside the mark's box");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A day folder with a generated picture, for make-card. */
function generatedDay() {
  const root = mkdtempSync(join(tmpdir(), "hf-card-"));
  const day = join(root, "job", DAY);
  mkdirSync(join(day, "generated"), { recursive: true });
  writeFileSync(join(day, "generated", "c1-en-final.png"), solidPng(1080, 1350, [210, 220, 235]));
  writeFileSync(join(root, "outside.png"), solidPng(64, 64, [1, 2, 3]));
  return { root, day };
}
const makeCard = (day, spec, layout) => {
  writeFileSync(join(day, "card.layout.html"), layout);
  writeFileSync(join(day, "card.spec.json"), JSON.stringify({ id: `media-${DAY}-chat-en-card`, locale: "en", layout: "card.layout.html", alt: "A commuter on a train picks a model on a phone.", ...spec }));
  return spawnSync(process.execPath, [join(tool, "make-card.mjs"), join(day, "card.spec.json"), day], { encoding: "utf8", cwd: tool });
};

test("a generated card gets the band, its words in the transcript, and no address for the Guard", { skip }, async () => {
  const { bandLayout } = await import("../tools/marketing-video/band-layout.mjs");
  const { root, day } = generatedDay();
  try {
    const run = makeCard(day, { texts: ["Ask GPT, Claude, Gemini and more"] }, bandLayout({ picture: "c1-en-final.png", locale: "en", dark: false }));
    assert.equal(run.status, 0, run.stderr);
    const asset = JSON.parse(readFileSync(join(day, `media-${DAY}-chat-en-card.asset.json`), "utf8"));
    assert.equal(asset.asset.provenance, "ai_generated");
    assert.equal(asset.asset.depictsProductInterface, false);
    assert.deepEqual(asset.asset.claimIds, []);
    assert.deepEqual(asset.asset.allowedChannels, ["facebook", "instagram", "linkedin", "x"]);
    const transcript = asset.transcript.en;
    assert.match(transcript, /Ask GPT, Claude, Gemini and more/u);
    assert.match(transcript, /Photo: AI-generated/u);
    assert.doesNotMatch(transcript, /tomverse\.app/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a generated picture from elsewhere, without its AI line, beside a capture or without its words is refused", { skip }, async () => {
  const { bandLayout } = await import("../tools/marketing-video/band-layout.mjs");
  const { root, day } = generatedDay();
  try {
    const words = { texts: ["Ask GPT, Claude, Gemini and more"] };
    for (const name of ["../../outside.png", "..%2foutside.png", "c1-en-missing.png"]) {
      const run = makeCard(day, words, `<img src="generated:${name}" style="position:absolute;inset:0"><div>Photo: AI-generated</div>`);
      assert.equal(run.status, 1, name);
      assert.match(run.stderr, /not captures or library entries/u, name);
    }
    const noLine = makeCard(day, words, bandLayout({ picture: "c1-en-final.png", locale: "en", dark: false }).replace("Photo: AI-generated", "Made today"));
    assert.equal(noLine.status, 1);
    assert.match(noLine.stderr, /Photo: AI-generated/u);

    const packDir = join(root, "sources", "media-x-short");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "a.png"), solidPng(64, 64, [21, 93, 251]));
    writeFileSync(join(packDir, "src.asset.json"), JSON.stringify({ asset: { claimIds: [] } }));
    writeFileSync(join(packDir, "pack.json"), JSON.stringify({ assetId: "media-x-short", locale: "en", videoAsset: "src.asset.json", captures: { a: { file: "a.png", text: "answer" } } }));
    const mixed = makeCard(day, { ...words, pack: join(packDir, "pack.json") }, `${bandLayout({ picture: "c1-en-final.png", locale: "en", dark: false })}<img src="capture:a" style="position:absolute;left:100px;top:100px;width:200px">`);
    assert.equal(mixed.status, 1);
    assert.match(mixed.stderr, /may not share a card/u);

    const wordless = makeCard(day, {}, bandLayout({ picture: "c1-en-final.png", locale: "en", dark: false }));
    assert.equal(wordless.status, 1);
    assert.match(wordless.stderr, /spec\.texts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Chinese words are spaced after a full stop and pass the Guard's hygiene check", { skip }, async () => {
  const { bandLayout } = await import("../tools/marketing-video/band-layout.mjs");
  const { root, day } = generatedDay();
  try {
    writeFileSync(join(day, "card.layout.html"), bandLayout({ picture: "c1-en-final.png", locale: "zh-Hans", dark: true }));
    writeFileSync(join(day, "card.spec.json"), JSON.stringify({ id: `media-${DAY}-chat-zh-hans-card`, locale: "zh-Hans", layout: "card.layout.html", alt: "通勤者在火车上用手机选择模型。下方是 Tomverse 标志与网址。", texts: ["选 GPT 6 Luna。Claude 也行"] }));
    const run = spawnSync(process.execPath, [join(tool, "make-card.mjs"), join(day, "card.spec.json"), day], { encoding: "utf8", cwd: tool });
    assert.equal(run.status, 0, run.stderr);
    const asset = JSON.parse(readFileSync(join(day, `media-${DAY}-chat-zh-hans-card.asset.json`), "utf8"));
    assert.match(asset.transcript["zh-Hans"], /Luna。 Claude/u);
    assert.deepEqual(asset.asset.allowedChannels, ["rednote"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
