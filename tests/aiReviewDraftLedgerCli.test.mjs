// The drafting script's spend control, exercised as a script.
//
// The unit tests cover the ledger's arithmetic. These cover the part that
// arithmetic cannot: that a billed call which returns nothing usable is
// settled rather than forgotten, that a process killed after reserving leaves
// its money held, and that two runs cannot both decide they have room.
//
// No provider is called. A stub server stands in, so "billed" here means
// "reserved and settled" -- which is exactly the bookkeeping under test.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ledgerBalance } from "../lib/aiReviewDraftLedger.ts";
import {
  assignTargetLabels,
  draftInstruction,
} from "../lib/aiReviewEvalDraftPrompt.ts";
import {
  draftingCallCostCeilingUsd,
  draftingInputTokenCeiling,
  draftingOutputTokenCap,
} from "../lib/aiReviewEvalPlan.ts";
import { getModelPricingProfile } from "../lib/modelPricing.ts";

/**
 * What one call of ARGS costs at most, computed the way the drafter computes
 * it.
 *
 * Derived rather than typed in: the per-call ceiling moves whenever the
 * instruction, the token bound or the output cap changes, and a hard-coded
 * total quietly stops testing what it was written to test -- it did, the day
 * the output cap started being sized to the batch.
 */
const callCeilingUsd = () => {
  const cell = {
    language: "ko",
    taskType: "safety_sensitive",
    phenomenon: "prompt_injection",
    mode: "balanced",
    count: 2,
  };
  const tier = getModelPricingProfile("gpt-5-6-luna").tiers[0];
  return draftingCallCostCeilingUsd({
    inputTokens: draftingInputTokenCeiling(
      draftInstruction({
        ...cell,
        existingQuestions: [],
        targetLabels: assignTargetLabels(cell),
      })
    ),
    outputTokenCap: draftingOutputTokenCap(cell.count),
    inputUsdPerMillionTokens: tier.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: tier.outputUsdPerMillionTokens,
  });
};

const ARGS = [
  "--model=gpt-5-6-luna",
  "--language=ko",
  "--task-type=safety_sensitive",
  "--phenomenon=prompt_injection",
  "--mode=balanced",
  "--count=2",
];

/**
 * Where the drafter will tell the reply to plant the fault, for ARGS.
 *
 * Read out of ARGS rather than restated, so editing the cell above cannot
 * leave the stub accusing an answer the drafter did not assign.
 */
const ARGS_CELL = Object.fromEntries(
  ARGS.map((argument) => argument.replace(/^--/, "").split("="))
);
const ARGS_TARGET_LABELS = assignTargetLabels({
  language: ARGS_CELL.language,
  taskType: ARGS_CELL["task-type"],
  phenomenon: ARGS_CELL.phenomenon,
  mode: ARGS_CELL.mode,
  count: Number(ARGS_CELL.count),
});

/**
 * A stand-in provider. `reply` is what it returns; `null` never answers.
 *
 * It runs in this process, so the children must be spawned asynchronously:
 * `spawnSync` blocks this event loop, and a server that cannot accept a
 * connection looks exactly like a provider that never replies.
 */
const stubProvider = async (reply) => {
  const server = createServer((request, response) => {
    if (reply === null) return; // hangs, so the caller can be killed mid-flight
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(reply);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};


/**
 * A reply the drafter will accept, carrying one case with the given marker.
 *
 * Shaped to the v2 contract, because that is what the drafter now enforces:
 * three answers labelled a/b/c, each past the length floor.
 */
const usableReply = (marker) =>
  JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            cases: [
              {
                question: `question ${marker}`,
                responses: ["a", "b", "c"].map((label) => ({
                  label,
                  // Distinct per label: two identical answers are refused, and
                  // a stub that shipped three copies of one string would be
                  // testing the drafter against material it will not accept.
                  content: `answer ${label} for ${marker}. `.repeat(20),
                })),
                gold: {
                  // The label the assignment picked for the first case of this
                  // batch, derived rather than typed in -- the drafter checks
                  // the gold's accusation against it, and a constant here would
                  // break the moment the cell in ARGS changed.
                  accusedLabel: ARGS_TARGET_LABELS[0],
                  contradictions: [
                    { id: marker, anyOf: [marker], description: marker },
                  ],
                },
                goldCompleteness: { contradictions: true },
                injectionMarkers: [marker],
              },
            ],
          }),
        },
      },
    ],
  });

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ai-review-ledger-"));
  const setPath = join(root, "decision-v1.json");
  return {
    root,
    setPath,
    ledgerPath: join(root, "decision-v1.spend.jsonl"),
    balance: () =>
      ledgerBalance(
        existsSync(join(root, "decision-v1.spend.jsonl"))
          ? readFileSync(join(root, "decision-v1.spend.jsonl"), "utf8").split("\n")
          : []
      ),
  };
};

const args = (setPath, extra = []) => [
  "--conditions=react-server",
  "--import",
  "tsx",
  "scripts/draft-ai-review-eval-candidates.mjs",
  ...ARGS,
  `--set=${setPath}`,
  ...extra,
];

const env = (baseUrl) => ({
  ...process.env,
  OPENAI_API_KEY: "test-key-not-a-real-one",
  // The script accepts a loopback base URL only, which is what makes this a
  // test seam rather than a way to redirect a real key.
  AI_REVIEW_DRAFT_BASE_URL: baseUrl,
});

/** Runs the drafter to completion and collects what it said. */
const run = (setPath, extra, baseUrl) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args(setPath, extra), {
      env: env(baseUrl),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

test("a billed call that returns nothing usable is settled, not forgotten", async (t) => {
  const provider = await stubProvider(
    JSON.stringify({ choices: [{ message: { content: "no json here at all" } }] })
  );
  const fix = fixture();
  t.after(async () => {
    await provider.close();
    rmSync(fix.root, { recursive: true, force: true });
  });

  const result = await run(fix.setPath, ["--send", "--max-total-cost-usd=1"], provider.url);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Nothing usable came back/);

  const balance = fix.balance();
  assert.deepEqual(balance.problems, []);
  assert.equal(balance.settledCount, 1, "the billed call must be settled");
  assert.equal(balance.outstandingCount, 0);
  assert.ok(balance.committedUsd > 0, "a billed call must move the total");
  const settlement = readFileSync(fix.ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.op === "settle");
  assert.equal(settlement.outcome, "no_usable_cases");
});

test("a reply that will not parse is settled too", async (t) => {
  const provider = await stubProvider("<html>gateway error</html>");
  const fix = fixture();
  t.after(async () => {
    await provider.close();
    rmSync(fix.root, { recursive: true, force: true });
  });

  const result = await run(fix.setPath, ["--send", "--max-total-cost-usd=1"], provider.url);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /The reply is not JSON/);
  const balance = fix.balance();
  assert.equal(balance.settledCount, 1);
  assert.ok(balance.committedUsd > 0);
});

test("a process killed after reserving leaves its money held", async (t) => {
  const provider = await stubProvider(null); // never answers
  const fix = fixture();
  t.after(async () => {
    await provider.close();
    rmSync(fix.root, { recursive: true, force: true });
  });

  const child = spawn(
    process.execPath,
    args(fix.setPath, ["--send", "--max-total-cost-usd=1"]),
    { env: env(provider.url) }
  );
  // Wait for the reservation to land, then kill mid-flight. The window is
  // generous because the whole unit suite runs these files concurrently and
  // the child has to boot tsx before it reserves anything.
  for (let attempt = 0; attempt < 900; attempt += 1) {
    if (fix.balance().outstandingCount > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));

  const balance = fix.balance();
  assert.equal(balance.outstandingCount, 1, "the reservation must survive the kill");
  assert.ok(balance.committedUsd > 0, "and must still hold the budget");
  assert.equal(balance.settledCount, 0);
});

test("a reservation nobody settled blocks a later run, room or not", async (t) => {
  const fix = fixture();
  t.after(() => rmSync(fix.root, { recursive: true, force: true }));
  // Tiny, so the budget has ample room: the refusal must not depend on the
  // arithmetic. A run holding this reservation may still be writing the
  // decision set, and a second run would write its own copy back over it.
  writeFileSync(
    fix.ledgerPath,
    `${JSON.stringify({
      op: "reserve",
      id: "orphan",
      at: "2026-09-01",
      costCeilingUsd: 0.0001,
    })}\n`
  );

  const result = await run(
    fix.setPath,
    ["--send", "--max-total-cost-usd=1"],
    "http://127.0.0.1:1/v1"
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /HARD STOP/);
  assert.match(result.stderr, /have not settled/);
  // Nothing was added: the refusal happens before the reservation is written.
  assert.equal(fix.balance().outstandingCount, 1);
});

test("two runs at once cannot both decide they have room", async (t) => {
  const provider = await stubProvider(
    JSON.stringify({ choices: [{ message: { content: "not usable" } }] })
  );
  const fix = fixture();
  t.after(async () => {
    await provider.close();
    rmSync(fix.root, { recursive: true, force: true });
  });

  // A total that fits one call and not two, and both runs start at once.
  const total = (callCeilingUsd() * 1.5).toFixed(6);
  const [one, two] = await Promise.all([
    run(fix.setPath, ["--send", `--max-total-cost-usd=${total}`], provider.url),
    run(fix.setPath, ["--send", `--max-total-cost-usd=${total}`], provider.url),
  ]);
  const refused = [one, two].filter((result) => /HARD STOP/.test(result.stderr));
  assert.equal(refused.length, 1, `${one.stderr}\n---\n${two.stderr}`);

  const balance = fix.balance();
  assert.deepEqual(balance.problems, []);
  assert.ok(
    balance.committedUsd <= Number(total),
    `committed ${balance.committedUsd} passed the approved total ${total}`
  );
});

test("the base-URL seam refuses anything but loopback", async (t) => {
  const fix = fixture();
  t.after(() => rmSync(fix.root, { recursive: true, force: true }));

  const result = await run(
    fix.setPath,
    ["--send", "--max-total-cost-usd=1"],
    "http://evil.example.com:8080/v1"
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /loopback-only test seam/);
  // The refusal happens before the key is read and before anything is reserved.
  assert.equal(existsSync(fix.ledgerPath), false);
});

test("a run with no API key reserves nothing", async (t) => {
  const provider = await stubProvider(
    JSON.stringify({ choices: [{ message: { content: "not usable" } }] })
  );
  const fix = fixture();
  t.after(async () => {
    await provider.close();
    rmSync(fix.root, { recursive: true, force: true });
  });

  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      args(fix.setPath, ["--send", "--max-total-cost-usd=1"]),
      { env: { ...env(provider.url), OPENAI_API_KEY: "" } }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.on("close", (status) => resolve({ status, stderr }));
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY is not set/);
  // A reservation stands for money very likely spent. This run could not
  // spend any, so it must not leave one holding the budget for ever.
  assert.equal(existsSync(fix.ledgerPath), false);
});

test("two concurrent runs never lose a written case", async (t) => {
  // The defect this serialisation exists for. Both runs read the whole
  // decision set, append to their own copy in memory and write the file back,
  // so a budget that admitted two calls paid for two and kept one. Now the
  // second is refused before it calls, and the set holds exactly the cases of
  // the run that went ahead.
  const provider = await stubProvider(usableReply("m1"));
  const fix = fixture();
  t.after(async () => {
    await provider.close();
    rmSync(fix.root, { recursive: true, force: true });
  });

  const [one, two] = await Promise.all([
    run(fix.setPath, ["--send", "--max-total-cost-usd=1"], provider.url),
    run(fix.setPath, ["--send", "--max-total-cost-usd=1"], provider.url),
  ]);
  // Either outcome is correct: the second run is refused outright, or it waits
  // out the lock and goes after the first. What must never happen is that both
  // are billed and only one case survives.
  const succeeded = [one, two].filter((result) => result.status === 0);
  assert.ok(succeeded.length >= 1, `${one.stderr}\n---\n${two.stderr}`);

  const set = JSON.parse(readFileSync(fix.setPath, "utf8"));
  const balance = fix.balance();
  assert.deepEqual(balance.problems, []);
  assert.equal(
    set.cases.length,
    succeeded.length,
    "every run that was billed must have left its case in the set"
  );
  assert.equal(balance.settledCount, succeeded.length);
  assert.equal(balance.outstandingCount, 0);
  assert.equal(
    new Set(set.cases.map((item) => item.id)).size,
    set.cases.length,
    "two runs must not hand out the same case id"
  );
});

test("a set holding an older template's cases is refused before anything is reserved", async (t) => {
  // The shape a stale working copy produces: a decision set that survived a
  // move, quietly collecting v2 cases on top of v1 ones. Templates differ in
  // where the fault is planted and how long an answer must be, so a set
  // holding both measures neither cleanly.
  const fix = fixture();
  t.after(() => rmSync(fix.root, { recursive: true, force: true }));
  writeFileSync(
    fix.setPath,
    JSON.stringify({
      version: "decision-v1",
      schemaVersion: 1,
      purpose: "decision",
      frozenAt: null,
      frozenBy: null,
      frozenDigest: null,
      cases: [
        {
          id: "ko-safety-sensitive-001",
          language: "ko",
          taskType: "safety_sensitive",
          phenomenon: "direct_contradiction",
          mode: "balanced",
          question: "q",
          responses: [
            { label: "a", content: "c", modelId: "drafted", provider: "drafted" },
            { label: "b", content: "c", modelId: "drafted", provider: "drafted" },
          ],
          gold: { contradictions: [{ id: "g", anyOf: ["g"], description: "g" }] },
          goldCompleteness: { contradictions: true },
          status: "candidate",
          adoptedBy: null,
          adoptedAt: null,
          draftedBy: {
            modelId: "gpt-5-6-luna",
            templateVersion: "ai-review-eval-draft-v1",
            draftedAt: "2026-09-02T06:59:09.592Z",
          },
        },
      ],
    })
  );

  const result = await run(
    fix.setPath,
    ["--send", "--max-total-cost-usd=1"],
    "http://127.0.0.1:1/v1"
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /ai-review-eval-draft-v1/);
  assert.equal(existsSync(fix.ledgerPath), false, "nothing may be reserved");
});
