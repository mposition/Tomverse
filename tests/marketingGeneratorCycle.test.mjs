import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  marketingDraftProvenanceMatches,
  marketingDraftSubmissionSchema,
} from "@/lib/marketingDraftIntakeCore";
import {
  MARKETING_GENERATOR_CALL_BUDGET_MS,
  marketingGeneratorWorkerConfig,
  runMarketingGeneratorCycle,
} from "@/lib/marketingGeneratorCycleCore";
import { superviseMarketingGeneratorRun } from "../scripts/marketing-generator-service.mjs";

const SECRET = "g".repeat(48);
const NOW = Date.parse("2026-10-16T00:00:00.000Z");
const DEADLINE = new Date(NOW + 20 * 60 * 1000).toISOString();

const context = {
  channels: [
    { id: "chn_b", channel: "x", accountSlug: "tomverse", defaultLocale: "en", allowedLocales: ["en"] },
    { id: "chn_a", channel: "linkedin", accountSlug: "tomverse", defaultLocale: "en", allowedLocales: ["en"] },
  ],
  claims: [],
  assets: [],
  brief: null,
  marketIntel: null,
};
const goodAnswer = JSON.stringify({
  drafts: [{ renderedText: "Ask once, read three answers.", claimIds: [], assetIds: [], disclosureFlags: ["advertising"] }],
});

function harness({ outcomes = [], submitAnswer, readContext, now } = {}) {
  const asked = [];
  const submitted = [];
  let id = 0;
  return {
    asked,
    submitted,
    deps: {
      readContext: readContext ?? (async () => context),
      callLlm: async (messages, requestKey) => {
        asked.push({ messages, requestKey });
        const next = outcomes.shift() ?? { status: "answered", content: goodAnswer, ledgerState: "settled" };
        return { callId: `call${asked.length}`, requestKey, ...next };
      },
      submit: async (submission) => {
        submitted.push(submission);
        if (submitAnswer) return submitAnswer(submission);
        return { httpStatus: 200, body: { results: submission.drafts.map(() => ({ status: "queued" })) } };
      },
      secret: SECRET,
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      now: now ?? (() => NOW),
    },
  };
}

const cycle = (h) => runMarketingGeneratorCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, postsPerAccount: 3 }, h.deps);

test("a run asks each account once, in id order, and submits each call's drafts under that call's key", async () => {
  const h = harness();
  const summary = await cycle(h);
  assert.equal(summary.stoppedAt, null);
  assert.equal(summary.calls, 2);
  assert.equal(summary.draftsSubmitted, 2);
  assert.deepEqual(summary.intake, { queued: 2 });
  assert.deepEqual(h.submitted.map((s) => s.drafts[0].channelId), ["chn_a", "chn_b"]);
  for (const [index, submission] of h.submitted.entries()) {
    const parsed = marketingDraftSubmissionSchema.parse(JSON.parse(JSON.stringify(submission)));
    assert.equal(marketingDraftProvenanceMatches(SECRET, parsed), true);
    assert.deepEqual(parsed.llmCallRequestKeys, [h.asked[index].requestKey]);
    assert.equal(parsed.submissionId, `call-${index}`);
  }
});

test("a refused reservation ends the run: no later account is asked", async () => {
  const h = harness({ outcomes: [{ status: "refused", stage: "reserve", code: "model_not_pinned" }] });
  const summary = await cycle(h);
  assert.deepEqual(summary.stoppedAt, { stage: "llm", detail: "reserve:model_not_pinned" });
  assert.equal(h.asked.length, 1);
  assert.equal(h.submitted.length, 0);
});

for (const status of ["unknown", "stopped"]) {
  test(`an ${status} call ends the run for a person to look at`, async () => {
    const h = harness({ outcomes: [{ status, stage: "dispatch" }] });
    const summary = await cycle(h);
    assert.deepEqual(summary.stoppedAt, { stage: "llm", detail: status });
    assert.equal(h.asked.length, 1);
  });
}

test("a submission whose answer is lost ends the run rather than resending under a new run", async () => {
  const h = harness({
    submitAnswer: () => {
      throw new Error("socket hang up");
    },
  });
  const summary = await cycle(h);
  assert.deepEqual(summary.stoppedAt, { stage: "submit", detail: "outcome_unknown" });
  assert.equal(h.asked.length, 1);
});

test("an answer with nothing usable submits nothing and goes on to the next account", async () => {
  const h = harness({ outcomes: [{ status: "answered", content: "not json", ledgerState: "settled" }] });
  const summary = await cycle(h);
  assert.equal(summary.stoppedAt, null);
  assert.deepEqual(summary.dropped, { answer_not_json: 1 });
  assert.equal(h.submitted.length, 1);
});

test("no context, or too little time for another call, is a stop before any call", async () => {
  const noContext = harness({ readContext: async () => ({ channels: "nope" }) });
  assert.deepEqual((await cycle(noContext)).stoppedAt, { stage: "context", detail: "context_unreadable" });
  const lost = harness({
    readContext: async () => {
      throw new Error("down");
    },
  });
  assert.deepEqual((await cycle(lost)).stoppedAt, { stage: "context", detail: "context_unavailable" });
  const late = harness({ now: () => Date.parse(DEADLINE) - MARKETING_GENERATOR_CALL_BUDGET_MS + 1 });
  const summary = await cycle(late);
  assert.deepEqual(summary.stoppedAt, { stage: "deadline", detail: "deadline_too_close" });
  assert.equal(late.asked.length, 0);
});

test("the worker needs every variable, a long secret, HTTPS and a price pin for its model", () => {
  const env = {
    MARKETING_APP_URL: "https://tomverse.app",
    MARKETING_GENERATOR_SUBMIT_SECRET: SECRET,
    MARKETING_LLM_API_KEY: "sk-fixture",
    MARKETING_GENERATOR_MODEL: "fixture-model",
  };
  const pins = [{ model: "fixture-model" }];
  assert.equal(marketingGeneratorWorkerConfig(env, pins).ok, true);
  assert.match(marketingGeneratorWorkerConfig({ ...env, MARKETING_LLM_API_KEY: undefined }, pins).reason, /missing/);
  assert.match(marketingGeneratorWorkerConfig({ ...env, MARKETING_GENERATOR_SUBMIT_SECRET: "short" }, pins).reason, /32/);
  assert.match(marketingGeneratorWorkerConfig({ ...env, MARKETING_APP_URL: "http://tomverse.app" }, pins).reason, /HTTPS/);
  assert.equal(marketingGeneratorWorkerConfig({ ...env, MARKETING_APP_URL: "http://localhost:3000" }, pins).ok, true);
  assert.match(marketingGeneratorWorkerConfig(env, []).reason, /price pin/);
});

test("the shipped worker will not start: no model has a price pin yet", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", resolve("scripts/marketing-generator-worker.mjs")],
    {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        MARKETING_GENERATOR_RUN_ID: "run-1",
        MARKETING_GENERATOR_DEADLINE: DEADLINE,
        MARKETING_APP_URL: "https://tomverse.app",
        MARKETING_GENERATOR_SUBMIT_SECRET: SECRET,
        MARKETING_LLM_API_KEY: "sk-fixture",
        MARKETING_GENERATOR_MODEL: "any-model",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no price pin/);
});

test("a worker that does not finish is killed at the deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "generator-supervisor-"));
  const hanging = join(directory, "hanging.mjs");
  writeFileSync(hanging, "setInterval(() => {}, 1000);\n");
  const started = Date.now();
  const outcome = await superviseMarketingGeneratorRun({ worker: hanging, deadlineMs: 300, stdio: "ignore" });
  assert.equal(outcome.killedAtDeadline, true);
  assert.ok(outcome.signal !== null);
  assert.ok(Date.now() - started < 5_000);
});

test("a worker that finishes in time is not killed, and gets only its own variables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "generator-supervisor-"));
  const quick = join(directory, "quick.mjs");
  writeFileSync(
    quick,
    "process.exitCode = process.env.UNRELATED_SECRET === undefined && process.env.MARKETING_GENERATOR_RUN_ID ? 0 : 3;\n",
  );
  const outcome = await superviseMarketingGeneratorRun({
    worker: quick,
    deadlineMs: 10_000,
    stdio: "ignore",
    env: { ...process.env, UNRELATED_SECRET: "x" },
  });
  assert.equal(outcome.killedAtDeadline, false);
  assert.equal(outcome.code, 0);
});
