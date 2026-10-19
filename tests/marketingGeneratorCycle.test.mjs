import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
  marketingGeneratorAppPorts,
  marketingGeneratorPinForContext,
  MARKETING_GENERATOR_WORKER_VARIABLES,
  marketingGeneratorWorkerConfig,
  runMarketingGeneratorCycle,
} from "@/lib/marketingGeneratorCycleCore";
import { AGENT_RUNNER_SERVICES } from "../.railway/agent-runners.ts";
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
  const slept = [];
  let id = 0;
  return {
    asked,
    submitted,
    slept,
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
      sleep: async (ms) => {
        slept.push(ms);
      },
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

test("an answer the ledger retained as unknown ends the run: nothing is submitted and no later account is asked", async () => {
  const h = harness({ outcomes: [{ status: "retained", ledgerState: "unknown_retained" }] });
  const summary = await cycle(h);
  assert.deepEqual(summary.stoppedAt, { stage: "llm", detail: "retained" });
  assert.equal(h.asked.length, 1);
  assert.equal(h.submitted.length, 0);
});

test("a lost or 5xx submission is resent as the same signed bytes, never as a new call", async () => {
  let sends = 0;
  const h = harness({
    submitAnswer: (submission) => {
      sends += 1;
      if (sends === 1) throw new Error("socket hang up");
      // Part-way: the route answers 500 after some drafts committed.
      if (sends === 2) return { httpStatus: 500, body: { results: [], code: "outcome_unknown" } };
      return { httpStatus: 200, body: { results: submission.drafts.map(() => ({ status: "queued", existing: true })) } };
    },
  });
  const summary = await cycle(h);
  assert.equal(summary.stoppedAt, null);
  // Three sends of the first submission, one of the second; one model call each.
  assert.equal(h.asked.length, 2);
  assert.equal(h.submitted.length, 4);
  assert.deepEqual(h.submitted[0], h.submitted[1]);
  assert.deepEqual(h.submitted[1], h.submitted[2]);
  assert.deepEqual(h.slept, [2_000, 5_000]);
});

test("a submission that never gets an answer ends the run after its resends", async () => {
  const h = harness({
    submitAnswer: () => {
      throw new Error("socket hang up");
    },
  });
  const summary = await cycle(h);
  assert.deepEqual(summary.stoppedAt, { stage: "submit", detail: "outcome_unknown" });
  assert.equal(h.asked.length, 1);
  assert.equal(h.submitted.length, 3);
});

test("a 4xx is not resent: the same bytes would be refused the same way", async () => {
  const h = harness({ submitAnswer: () => ({ httpStatus: 401, body: { code: "provenance_invalid" } }) });
  const summary = await cycle(h);
  assert.deepEqual(summary.stoppedAt, { stage: "submit", detail: "http_401" });
  assert.equal(h.submitted.length, 1);
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

test("a 4xx the app did not write -- a proxy's HTML -- keeps its status and is not resent", async () => {
  const sent = [];
  const ports = marketingGeneratorAppPorts({
    appUrl: new URL("https://tomverse.app"),
    secret: SECRET,
    generatorRunId: "run-1",
    fetch: async (url) => {
      sent.push(String(url));
      return new Response("<html>Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } });
    },
  });
  assert.deepEqual(await ports.submit({ drafts: [] }), { httpStatus: 403, body: {} });
  const h = harness();
  const summary = await runMarketingGeneratorCycle(
    { generatorRunId: "run-1", deadlineAt: DEADLINE, postsPerAccount: 3 },
    { ...h.deps, submit: ports.submit },
  );
  assert.deepEqual(summary.stoppedAt, { stage: "submit", detail: "http_403" });
  // One direct send above and one inside the run: no resend.
  assert.equal(sent.length, 2);
});

test("the worker needs every variable, a long secret and HTTPS", () => {
  const env = {
    MARKETING_APP_URL: "https://tomverse.app",
    MARKETING_GENERATOR_SUBMIT_SECRET: SECRET,
    MARKETING_LLM_API_KEY: "sk-fixture",
  };
  assert.equal(marketingGeneratorWorkerConfig(env).ok, true);
  assert.match(marketingGeneratorWorkerConfig({ ...env, MARKETING_LLM_API_KEY: undefined }).reason, /missing/);
  assert.match(marketingGeneratorWorkerConfig({ ...env, MARKETING_GENERATOR_SUBMIT_SECRET: "short" }).reason, /32/);
  assert.match(marketingGeneratorWorkerConfig({ ...env, MARKETING_APP_URL: "http://tomverse.app" }).reason, /HTTPS/);
  assert.equal(marketingGeneratorWorkerConfig({ ...env, MARKETING_APP_URL: "http://localhost:3000" }).ok, true);
});

test("the model and its pin are the ones the context carries from the Admin Console", () => {
  const pins = [{ model: "fixture-model" }, { model: "other-model" }];
  const fine = () => [];
  assert.deepEqual(marketingGeneratorPinForContext({ llm: { model: "other-model", pin: pins[1] } }, fine), { ok: true, pin: pins[1] });
  assert.match(marketingGeneratorPinForContext({ llm: { model: null, pin: null } }, fine).reason, /no model is selected/);
  assert.match(marketingGeneratorPinForContext({}, fine).reason, /no model is selected/);
  assert.match(marketingGeneratorPinForContext(null, fine).reason, /no model is selected/);
  assert.match(marketingGeneratorPinForContext({ llm: { model: "unpinned", pin: null } }, fine).reason, /no price pin/);
  // A pin for another model, or one the ledger's check refuses, is not used.
  assert.match(marketingGeneratorPinForContext({ llm: { model: "other-model", pin: pins[0] } }, fine).reason, /no price pin/);
  assert.match(
    marketingGeneratorPinForContext({ llm: { model: "other-model", pin: pins[1] } }, () => ["tiers_format"]).reason,
    /refused: tiers_format/,
  );
});

test("the shipped worker asks the app for its model and does nothing while none is selected", async () => {
  // A local app that answers the context route with no model selected.
  const asked = [];
  const server = createServer((request, response) => {
    asked.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ context: { llm: { model: null, pin: null } } }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  try {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", resolve("scripts/marketing-generator-worker.mjs")],
      {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          MARKETING_GENERATOR_RUN_ID: "run-1",
          // The worker aborts its requests at its deadline, so this one is real time.
          MARKETING_GENERATOR_DEADLINE: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          MARKETING_APP_URL: `http://127.0.0.1:${port}`,
          MARKETING_GENERATOR_SUBMIT_SECRET: SECRET,
          MARKETING_LLM_API_KEY: "sk-fixture",
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((done) => child.on("exit", done));
    assert.equal(code, 1, stderr);
    assert.match(stderr, /no model is selected in the Admin Console/);
    assert.deepEqual(asked, ["/api/internal/marketing-generator-context"]);
  } finally {
    server.close();
  }
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

test("the Railway service gives the worker exactly its variables, never on dev", () => {
  const runners = AGENT_RUNNER_SERVICES.filter((runner) => runner.key === "marketing_generator");
  assert.equal(runners.length, 1);
  const [runner] = runners;
  assert.equal(runner.startCommand, "node --experimental-strip-types scripts/marketing-generator-service.mjs");
  assert.deepEqual(Object.keys(runner.environments).sort(), ["production", "staging"]);
  for (const variables of Object.values(runner.environments)) {
    assert.deepEqual([...variables].sort(), [...MARKETING_GENERATOR_WORKER_VARIABLES].sort());
  }
});
