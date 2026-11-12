import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { admit, dailyCap, ledgerPath, readLedger, requestProblem, spent } from "../tools/marketing-video/higgsfield-cap.mjs";
import { makeImage } from "../tools/marketing-video/hf-image-core.mjs";
import { checkConcepts, gatherConcepts, pickFeature, sortConcepts } from "../tools/marketing-video/concepts-core.mjs";
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
// `higgsfield generate wait --help` on the box (2026-11-09): these flags and no
// others; an unknown one makes the CLI exit 1 at once.
const WAIT_FLAGS = new Set(["--timeout", "--interval", "--quiet", "-q", "--json", "--no-color"]);
const WAIT_VALUED = new Set(["--timeout", "--interval"]);
function unknownWaitFlag(args) {
  for (let index = 3; index < args.length; index += 1) {
    if (!WAIT_FLAGS.has(args[index])) return args[index];
    if (WAIT_VALUED.has(args[index])) index += 1;
  }
  return null;
}

function fakeCli(script) {
  const calls = [];
  const cli = (args) => {
    calls.push(args);
    if (args[1] === "wait" && unknownWaitFlag(args)) return { status: 1, stdout: "", stderr: `unknown flag: ${unknownWaitFlag(args)}`, timedOut: false };
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
      // The shape `generate get --json` answered on the box (2026-11-09): the
      // small preview and the uploaded references come before the picture.
      wait: ok({
        created_at: "2026-11-08T19:02:48.25575Z",
        display_name: "GPT Image 2.6",
        id: "job-a",
        job_type: "gpt_image_2_6",
        min_result_url: "https://cdn.example/hf_job-a_min.webp",
        params: { aspect_ratio: "4:5", medias: [{ data: { type: "media_input", url: "https://cdn.example/reference.png" }, role: "image" }], quality: "low" },
        result_url: "https://cdn.example/hf_job-a.png",
        status: "completed",
      }),
    });
    const out = join(jobDir, "a.png");
    const fetched = [];
    const fetchBytes = async (url) => (fetched.push(url), PNG);
    const made = await makeImage({ prompt: "scene", out, label: "c1/en/make", jobDir, day: DAY, env: capEnv("1"), cli: fake.cli, fetchBytes });
    assert.deepEqual({ ok: made.ok, jobId: made.jobId }, { ok: true, jobId: "job-a" });
    assert.ok(existsSync(out));
    assert.deepEqual(fetched, ["https://cdn.example/hf_job-a.png"], "the full-size picture, not the preview or a reference");
    const wait = fake.calls.find((args) => args[1] === "wait");
    assert.deepEqual(wait.slice(0, 5), ["generate", "wait", "job-a", "--timeout", "20m"]);
    const [entry] = readLedger(ledgerPath(jobDir, DAY)).entries;
    assert.deepEqual({ status: entry.status, jobId: entry.jobId, cost: entry.cost, label: entry.label }, { status: "done", jobId: "job-a", cost: 0.25, label: "c1/en/make" });
    const create = fake.calls.find((args) => args[1] === "create");
    assert.deepEqual(create.slice(0, 7), ["generate", "create", "gpt_image_2_6", "--prompt", create[4], "--aspect_ratio", "4:5"]);
    assert.ok(!create.includes("--wait"), "create returns the job id at once; waiting is a separate call");
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("a finished job with only a preview or reference URLs writes nothing, and its cost stays counted", async () => {
  const jobDir = tempJob();
  try {
    const fake = fakeCli({
      cost: ok({ credits: 0.25 }),
      create: ok({ id: "job-p" }),
      wait: ok({ id: "job-p", min_result_url: "https://cdn.example/hf_job-p_min.webp", params: { medias: [{ data: { url: "https://cdn.example/reference.png" } }] }, status: "completed" }),
    });
    const out = join(jobDir, "p.png");
    const made = await makeImage({ prompt: "scene", out, label: "c1/en/make", jobDir, day: DAY, env: capEnv("1"), cli: fake.cli, fetchBytes: async () => PNG });
    assert.equal(made.reason, "no_result_url");
    assert.equal(existsSync(out), false);
    const [entry] = readLedger(ledgerPath(jobDir, DAY)).entries;
    assert.deepEqual({ status: entry.status, cost: entry.cost }, { status: "done", cost: 0.25 });
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

test("one broken concept is dropped and the others go ahead; a broken answer is refused whole", () => {
  const sort = (answer) => sortConcepts(answer, { feature: "chat", history: [], day: DAY, toolDir: tool });
  const broken = concept("c2", { prompt_en: `${concept("c2").prompt_en}, accents in Tomverse blue` });
  const sorted = sort(conceptsOf(concept("c1"), broken, concept("c3")));
  assert.deepEqual(sorted.kept.map((entry) => entry.id), ["c1", "c3"]);
  assert.equal(sorted.dropped.length, 1);
  assert.equal(sorted.dropped[0].id, "c2");
  assert.match(sorted.dropped[0].problems[0], /^concept c2: prompt_en must not contain the word "Tomverse"/u);
  assert.deepEqual(sort(conceptsOf(concept("c1"), concept("c2"))).dropped, []);
  assert.match(sort(conceptsOf(concept("c1"))).problem, /2-3 entries/u);
  assert.match(sort(null).problem, /one JSON object/u);
});

test("a refused concept lists everything wrong with it, so one retry can mend it all", () => {
  const sort = (answer) => sortConcepts(answer, { feature: "chat", history: [], day: DAY, toolDir: tool });
  const broken = concept("c2", {
    prompt_en: `${concept("c2").prompt_en} No purple anywhere, no lorem ipsum, and no Tomverse logo.`,
    logos: ["chatgpt", "../secret"],
    texts: [texts[0], { role: "screen", text: "Try it free at tomverse.app" }],
    translations: { ...translations, ko: [translations.ko[0], { role: "screen", text: "지피티에게 무료로 물어보세요" }] },
  });
  const { problems } = sort(conceptsOf(concept("c1"), broken)).dropped[0];
  for (const expected of [
    /prompt_en must not contain the word "Tomverse".*Found in: ".*no Tomverse logo/u,
    /prompt_en must not contain the words purple.*Found in: ".*No purple anywhere/u,
    /prompt_en must not contain the words "lorem ipsum"/u,
    /logo "\.\.\/secret" is not one of the logo files/u,
    /texts\[1\]: no text in the picture contains "Tomverse"/u,
    /texts\[1\]: no web address/u,
    /texts\[1\]: the word "free" stands only/u,
    /ko\[1\]: model and company names stay as written.*지피티/u,
    /ko\[1\]: "무료" only/u,
  ]) {
    assert.ok(problems.some((problem) => expected.test(problem)), `${expected} in ${JSON.stringify(problems)}`);
  }
});

test("concepts are asked for again with every reason; what passed in either answer is kept", () => {
  const sort = (answer) => sortConcepts(answer, { feature: "chat", history: [], day: DAY, toolDir: tool });
  const bad = (id) => concept(id, { prompt_en: `${concept(id).prompt_en} No purple, no Tomverse logo.` });
  const gather = (answers) => {
    const asked = [];
    const result = gatherConcepts({
      ask: (again) => {
        asked.push(again);
        return answers[asked.length - 1] ?? null;
      },
      sort,
    });
    return { ...result, asked };
  };
  // All pass at once: one call.
  const clean = gather([conceptsOf(concept("c1"), concept("c2"))]);
  assert.deepEqual([clean.concepts.map((entry) => entry.id), clean.dropped, clean.asked], [["c1", "c2"], [], [""]]);
  // One broken: asked once more with both reasons and told what passed; the mended one joins the kept ones.
  const mended = gather([conceptsOf(concept("c1"), bad("c2"), concept("c3")), conceptsOf(concept("c1"), concept("c2"), concept("c3"))]);
  assert.deepEqual(mended.concepts.map((entry) => entry.id), ["c1", "c3", "c2"]);
  assert.equal(mended.asked.length, 2);
  assert.match(mended.asked[1], /the words purple[\s\S]*the word "Tomverse"|the word "Tomverse"[\s\S]*the words purple/u);
  assert.match(mended.asked[1], /Repeat c1 and c3 exactly as they were/u);
  // Still broken the second time: it is dropped, the others go ahead, and there is no third call.
  const dropped = gather([conceptsOf(concept("c1"), bad("c2")), conceptsOf(concept("c1"), bad("c2")), conceptsOf(concept("c1"), concept("c2"))]);
  assert.deepEqual([dropped.concepts.map((entry) => entry.id), dropped.dropped.map((entry) => entry.id), dropped.asked.length], [["c1"], ["c2"], 2]);
  // The second answer breaks what passed before: the first version stays.
  const kept = gather([conceptsOf(concept("c1"), bad("c2")), conceptsOf(bad("c1"), concept("c2"))]);
  assert.deepEqual([kept.concepts.map((entry) => entry.id), kept.dropped], [["c1", "c2"], []]);
  // Nothing passes twice (no JSON, then all broken): a third call, and its concepts are used.
  const third = gather([null, conceptsOf(bad("c1"), bad("c2")), conceptsOf(concept("c1"), concept("c2"))]);
  assert.deepEqual([third.concepts.map((entry) => entry.id), third.asked.length], [["c1", "c2"], 3]);
  assert.match(third.asked[1], /exactly one line of JSON/u);
  // Nothing ever passes: no concepts, and the last reasons are kept for the report.
  const none = gather([null, null, conceptsOf(bad("c1"), bad("c2"))]);
  assert.deepEqual([none.concepts, none.asked.length], [[], 3]);
  assert.match(none.refusal, /must not contain/u);
});

test("counts after a model name, exact model lists on a screen and compound words are not refused", () => {
  const analysis = (list) => {
    const strip = (text) => Object.fromEntries(Object.entries(text).filter(([key]) => !["ko", "zhT", "zhS"].includes(key)));
    const inLocale = (key) => list.map((text) => strip({ ...text, text: text[key] ?? text.text }));
    return { ...concept("c2", { feature: "analysis", factRefs: ["analysis.what"] }), texts: list.map(strip), translations: { ko: inLocale("ko"), "zh-Hant": inLocale("zhT"), "zh-Hans": inLocale("zhS") } };
  };
  const first = { ...concept("c1"), feature: "analysis", factRefs: ["analysis.what"] };
  const problemsOf = (...list) => sortConcepts({ date: "2026-11-12", feature: "analysis", concepts: [first, analysis([{ role: "headline", text: "See where the answers differ", ko: "답변이 어디서 갈리는지 보세요", zhT: "看看回答哪裡不同", zhS: "看看回答哪里不同" }, ...list])] }, { feature: "analysis", history: [], day: DAY, toolDir: tool }).dropped[0]?.problems ?? [];
  // A count that follows a model name is not a version (every analysis card has counts).
  assert.deepEqual(problemsOf({ role: "screen", text: "GPT, Claude, Gemini and more agree on 7 points", ko: "GPT, Claude, Gemini 등 답변 7가지 공통점", zhT: "GPT、Claude、Gemini 等 7 個共同點", zhS: "GPT、Claude、Gemini 等 7 个共同点" }), []);
  // The three models that answered the recorded example, on a screen or a tag.
  assert.deepEqual(problemsOf({ role: "label", text: "GPT 6 Luna · Claude Haiku 5.5 · Gemini Flash" }), []);
  // The same list as copy still ends "and more", and so does any list of bare names.
  assert.match(problemsOf({ role: "subhead", text: "GPT 6 Luna, Claude Haiku 5.5 and Gemini Flash answered", ko: "GPT 6 Luna, Claude Haiku 5.5, Gemini Flash의 답변", zhT: "GPT 6 Luna、Claude Haiku 5.5、Gemini Flash 的回答", zhS: "GPT 6 Luna、Claude Haiku 5.5、Gemini Flash 的回答" })[0], /and more/u);
  assert.match(problemsOf({ role: "label", text: "GPT · Claude · Gemini" })[0], /and more/u);
  // A version that is not in features.json is still refused, in any language.
  assert.match(problemsOf({ role: "screen", text: "Gemini Flash 2.0 answered", ko: "Gemini Flash 2.0의 답변", zhT: "Gemini Flash 2.0 的回答", zhS: "Gemini Flash 2.0 的回答" })[0], /"Gemini Flash 2\.0" is not a model name/u);
  assert.match(problemsOf({ role: "screen", text: "Ask Claude Opus 4 and more" , ko: "Claude Opus 4 등에 물어보세요", zhT: "問 Claude Opus 4 等", zhS: "问 Claude Opus 4 等" })[0], /"Claude Opus 4" is not a model name/u);
  // Also in lower case, joined to its number, or written unlike features.json (independent review, 2026-11-12).
  const same = (text) => ({ role: "screen", text, ko: text, zhT: text, zhS: text });
  assert.match(problemsOf(same("Claude opus 4 and more"))[0], /"Claude opus 4" is not a model name/u);
  assert.match(problemsOf(same("claude haiku 5.5 answered"))[0], /"claude haiku 5\.5" is not a model name/u);
  assert.match(problemsOf(same("GPT4 answered"))[0], /"GPT4" is not a model name/u);
  assert.match(problemsOf(same("GPT-4o mini answered"))[0], /"GPT-4" is not a model name/u);
  assert.deepEqual(problemsOf(same("Claude Haiku 5.5 found 7 gaps; Gemini Flash found 6")), []);
  // One bare name in a list of exact names, and the list is copy again.
  assert.match(problemsOf({ role: "label", text: "GPT 6 Luna · Claude" })[0], /and more/u);
  assert.match(problemsOf({ role: "label", text: "GPT 6 Luna · Claude · Gemini Flash" })[0], /and more/u);
  // Words around exact names are allowed on a screen or a tag (the real model wrote this label, 2026-11-12); as copy they are not.
  assert.deepEqual(problemsOf({ role: "label", text: "Asked at once: GPT 6 Luna, Claude Haiku 5.5, Gemini Flash", ko: "한 번에 질문: GPT 6 Luna, Claude Haiku 5.5, Gemini Flash", zhT: "同時提問：GPT 6 Luna、Claude Haiku 5.5、Gemini Flash", zhS: "同时提问：GPT 6 Luna、Claude Haiku 5.5、Gemini Flash" }), []);
  assert.match(problemsOf({ role: "cta", text: "Ask GPT 6 Luna and Claude Haiku 5.5 for every task", ko: "GPT 6 Luna와 Claude Haiku 5.5에 물어보세요", zhT: "問 GPT 6 Luna 和 Claude Haiku 5.5", zhS: "问 GPT 6 Luna 和 Claude Haiku 5.5" })[0], /and more/u);
  // "stress-free" is not an offer; "feel free" is reworded.
  assert.deepEqual(problemsOf({ role: "screen", text: "A stress-free weekend plan", ko: "편안한 주말 계획", zhT: "輕鬆的週末行程", zhS: "轻松的周末行程" }), []);
  assert.match(problemsOf({ role: "screen", text: "Feel free to ask again", ko: "언제든 다시 물어보세요", zhT: "隨時再問", zhS: "随时再问" })[0], /"free" stands only/u);
});

test("concepts with the wrong shape, feature or count are refused", () => {
  assert.match(check(conceptsOf(concept("c1"))), /2-3 entries/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { feature: "review" }))), /today's/u);
  const noAlt = concept("c2");
  delete noAlt.alt;
  assert.match(check(conceptsOf(concept("c1"), noAlt)), /keys must be exactly/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { logos: ["../secret"] }))), /not one of the logo files/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { factRefs: ["chat.price"] }))), /not a path in features\.json/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { texts: Array.from({ length: 13 }, () => texts[0]) }))), /texts holds 1-12 entries \(it has 13/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { device: concept("c1").device }))), /share a device/u);
});

test("banned words, unconditioned free, untranslated names and unknown models are refused", () => {
  const withText = (text, locale = null) =>
    concept("c2", locale ? { translations: { ...translations, [locale]: [translations[locale][0], { role: "screen", text }] } } : { texts: [texts[0], { role: "screen", text }] });
  assert.match(check(conceptsOf(concept("c1"), withText("Visit tomverse.app today"))), /no text in the picture contains "Tomverse"/u);
  assert.match(check(conceptsOf(concept("c1"), withText("Try it free"))), /free/u);
  assert.equal(check(conceptsOf(concept("c1"), withText("Free to try within the included credits"))), null);
  assert.match(check(conceptsOf(concept("c1"), withText("Ask GPT and Claude at once"))), /and more/u);
  assert.match(check(conceptsOf(concept("c1"), withText("Try GPT 9 Ultra and more"))), /not a model name/u);
  assert.match(check(conceptsOf(concept("c1"), withText("지피티와 클로드에게 물어보세요", "ko"))), /stay as written/u);
  assert.match(check(conceptsOf(concept("c1"), withText("问克劳德", "zh-Hans"))), /stay as written/u);
  assert.match(check(conceptsOf(concept("c1"), withText("這個問題", "zh-Hans"))), /Simplified/u);
  assert.match(check(conceptsOf(concept("c1"), concept("c2", { prompt_en: `${concept("c2").prompt_en} with a purple glow` }))), /#155dfb/u);
  // The refusal says the word must go and quotes where it is, so the retry can drop it.
  const named = check(conceptsOf(concept("c1"), concept("c2", { prompt_en: `${concept("c2").prompt_en}, accents in Tomverse blue` })));
  assert.match(named, /must not contain the word "Tomverse"/u);
  assert.match(named, /Found in: "\.\.\..*accents in Tomverse blue\.\.\."/u);
});

test("an answer under a real model name must be its recorded answer, untranslated", () => {
  const quoted = (text, translated = text) =>
    concept("c2", {
      texts: [texts[0], { role: "answer", speaker: "Gemini Flash", text }],
      translations: Object.fromEntries(Object.entries(translations).map(([locale, list]) => [locale, [list[0], { role: "answer", speaker: "Gemini Flash", text: translated }]])),
    });
  assert.equal(check(conceptsOf(concept("c1"), quoted("Skip the Scenic Railway (which has steep steps)"))), null);
  // Quote marks around it and a final stop are not a change of words.
  assert.equal(check(conceptsOf(concept("c1"), quoted("“Skip the Scenic Railway (which has steep steps).”"))), null);
  // Every recorded speaker is read, also one whose name holds a stop ("Claude Haiku 5.5" was read as "5").
  const haiku = concept("c2", {
    texts: [texts[0], { role: "answer", speaker: "Claude Haiku 5.5", text: "The Scenic Railway runs down a steep incline in a seated, enclosed carriage" }],
    translations: Object.fromEntries(Object.entries(translations).map(([locale, list]) => [locale, [list[0], { role: "answer", speaker: "Claude Haiku 5.5", text: "The Scenic Railway runs down a steep incline in a seated, enclosed carriage" }]])),
  });
  assert.equal(check(conceptsOf(concept("c1"), haiku)), null);
  assert.match(check(conceptsOf(concept("c1"), quoted("The Scenic Railway is perfect for everyone"))), /recorded answers exist only for Gemini Flash and Claude Haiku 5\.5/u);
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

test("a review may list up to 10 fixes of up to 500 characters; more is refused", () => {
  const c = concept("c1");
  const at = { stage: "guide", concept: c, locale: "en" };
  const fixes = (count, length) => Array.from({ length: count }, () => "x".repeat(length));
  // The first box run (2026-11-10) lost two reviews whose fixes ran past 300 characters.
  assert.equal(checkReview(line(reviewOf({ verdict: "fix", fixes: fixes(10, 500) })), at).review.fixes.length, 10);
  assert.match(checkReview(line(reviewOf({ verdict: "fix", fixes: fixes(11, 20) })), at).problem, /at most 10 strings of 500/u);
  assert.match(checkReview(line(reviewOf({ verdict: "fix", fixes: fixes(1, 501) })), at).problem, /at most 10 strings of 500/u);
});

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

// The picture steps run in Chromium (playwright), where the tool's packages and
// browser are installed. Importing playwright is not enough: a CI job may have
// the package from the root install but no browser, so the probe launches one.
const playwrightReady = (() => {
  const probe = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "const { chromium } = await import('playwright'); const browser = await chromium.launch(); await browser.close();"],
    { cwd: tool, timeout: 60_000 },
  );
  return probe.status === 0;
})();
const skip = playwrightReady ? false : "tools/marketing-video packages or their Chromium are not installed";

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

test("set words never break inside a word, so a narrow box shrinks the type instead", { skip }, async () => {
  const { textBreakCss } = await import("../tools/marketing-video/compose-core.mjs");
  const { chromium } = await import("playwright");
  // The first box run (2026-11-10) set "Gemini Flash" as "Gemin / i Flash" and
  // "일주일" as "일 / 주일". Each case puts a sentence in a box narrower than
  // one word and counts the lines that word sits on.
  const cases = [
    { locale: "ko", text: "일주일 동안 빗속 등산을 가는데 뭘 챙겨야 할까요?", word: "일주일" },
    { locale: "ko", text: "Gemini Flash", word: "Gemini" },
    { locale: "zh-Hans", text: "Gemini Flash", word: "Gemini" },
    { locale: "zh-Hant", text: "下雨天健行一週，該帶什麼？用 Gemini Flash", word: "Gemini" },
  ];
  const linesOf = (page, css, { text, word }) =>
    page.evaluate(
      ([cssText, textIn, wordIn]) => {
        document.body.innerHTML = `<div id="b" style="width:70px;font:40px sans-serif;line-height:1.25;${cssText}"></div>`;
        const box = document.getElementById("b");
        box.textContent = textIn;
        const start = textIn.indexOf(wordIn);
        const range = document.createRange();
        range.setStart(box.firstChild, start);
        range.setEnd(box.firstChild, start + wordIn.length);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      },
      [css, text, word],
    );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const sample of cases) {
      assert.equal(await linesOf(page, textBreakCss(sample.locale), sample), 1, `${sample.locale}: "${sample.word}" stays on one line`);
    }
    // The old rule broke the word, which is what the box run showed.
    assert.ok((await linesOf(page, "word-break: keep-all; overflow-wrap: anywhere;", cases[1])) > 1);
  } finally {
    await browser.close();
  }
});

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
// make-card runs as the box runs it: on a Node that cannot import a .ts file
// (the first box run, 2026-11-10), so the Guard's hygiene check must load anyway.
const WITHOUT_TS = process.features.typescript ? ["--no-experimental-strip-types"] : [];
const makeCard = (day, spec, layout) => {
  writeFileSync(join(day, "card.layout.html"), layout);
  writeFileSync(join(day, "card.spec.json"), JSON.stringify({ id: `media-${DAY}-chat-en-card`, locale: "en", layout: "card.layout.html", alt: "A commuter on a train picks a model on a phone.", ...spec }));
  return spawnSync(process.execPath, [...WITHOUT_TS, join(tool, "make-card.mjs"), join(day, "card.spec.json"), day], { encoding: "utf8", cwd: tool });
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
    const run = spawnSync(process.execPath, [...WITHOUT_TS, join(tool, "make-card.mjs"), join(day, "card.spec.json"), day], { encoding: "utf8", cwd: tool });
    assert.equal(run.status, 0, run.stderr);
    const asset = JSON.parse(readFileSync(join(day, `media-${DAY}-chat-zh-hans-card.asset.json`), "utf8"));
    assert.match(asset.transcript["zh-Hans"], /Luna。 Claude/u);
    assert.deepEqual(asset.asset.allowedChannels, ["rednote"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
