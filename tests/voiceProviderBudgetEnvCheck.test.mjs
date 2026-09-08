import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * The operator-facing budget check: docs/ops/voice-provider-budget-rollout.md §4.
 *
 * Driven as a process rather than as a function, because what is being fixed
 * here is its *output* and its exit code -- the two things an operator and a
 * runbook actually consume. A unit test of the resolver already covers the
 * classification (tests/voiceProviderBudget.test.mjs); this covers the promise
 * that the classification can be pasted somewhere public.
 */

const SCRIPT = "scripts/check-voice-provider-budget-env.mjs";

const run = (env, args = []) => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, ...args],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...env,
      },
    }
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

// Values chosen to be findable: if either ever reaches the output, a plain
// substring search says so.
const DAY = "31337";
const MONTH = "424242";

test("a usable production budget passes", () => {
  const { status, output } = run({
    NODE_ENV: "production",
    VOICE_PROVIDER_SECONDS_PER_DAY: DAY,
    VOICE_PROVIDER_SECONDS_PER_MONTH: MONTH,
  });

  assert.equal(status, 0);
  assert.match(output, /usable — both values are set and consistent/);
});

test("the numbers never reach the output", () => {
  // The point of the script: its output is safe to paste into an issue or a
  // verification record without anybody reading it first.
  const { output } = run({
    NODE_ENV: "production",
    VOICE_PROVIDER_SECONDS_PER_DAY: DAY,
    VOICE_PROVIDER_SECONDS_PER_MONTH: MONTH,
  });

  assert.ok(!output.includes(DAY), "the daily value leaked into the output");
  assert.ok(!output.includes(MONTH), "the monthly value leaked into the output");
  // The names are the whole point of the report and must be there.
  assert.match(output, /VOICE_PROVIDER_SECONDS_PER_DAY/);
  assert.match(output, /VOICE_PROVIDER_SECONDS_PER_MONTH/);
});

test("production with nothing set fails, naming both variables", () => {
  const { status, output } = run({ NODE_ENV: "production" });

  assert.equal(status, 1);
  assert.match(output, /NOT usable/);
  assert.match(output, /VOICE_PROVIDER_SECONDS_PER_DAY: MISSING/);
  assert.match(output, /VOICE_PROVIDER_SECONDS_PER_MONTH: MISSING/);
});

test("a month below the day fails rather than being reordered", () => {
  const { status, output } = run({
    NODE_ENV: "production",
    VOICE_PROVIDER_SECONDS_PER_DAY: "3600",
    VOICE_PROVIDER_SECONDS_PER_MONTH: "1800",
  });

  assert.equal(status, 1);
  assert.match(output, /month_below_day/);
});

test("zero is refused, because zero is not a way to turn the feature off", () => {
  const { status, output } = run({
    NODE_ENV: "production",
    VOICE_PROVIDER_SECONDS_PER_DAY: "0",
    VOICE_PROVIDER_SECONDS_PER_MONTH: "54000",
  });

  assert.equal(status, 1);
  assert.match(output, /not_a_positive_integer/);
});

test("a development fallback is not reported as configured", () => {
  // The sentence an operator would quote out of context. "usable" alone would
  // read as done, and nothing has been chosen.
  const { status, output } = run({ NODE_ENV: "development" });

  assert.equal(status, 0);
  assert.match(output, /usable, but NOT configured/);
  assert.match(output, /development fallback applies/);
});

test("--assume-production applies the production rule off a dev machine", () => {
  // So the rule that governs staging and production can be checked without
  // being in either.
  const { status, output } = run({ NODE_ENV: "development" }, [
    "--assume-production",
  ]);

  assert.equal(status, 1);
  assert.match(output, /production rule \(--assume-production\)/);
});

test("the report names which rule it applied and why", () => {
  // Which rule is in force is the thing most often got wrong from memory:
  // staging runs `next start`, so it is production-mode too.
  const { output } = run({
    NODE_ENV: "production",
    VOICE_PROVIDER_SECONDS_PER_DAY: "3600",
    VOICE_PROVIDER_SECONDS_PER_MONTH: "54000",
  });

  assert.match(output, /production rule \(NODE_ENV=production\)/);
});

test("the per-subject guardrail is named as a different layer", () => {
  // docs/policy/voice-input.md §6.1-4 and §7 must not be confused by whoever
  // reads this output while deciding a number.
  const { output } = run({
    NODE_ENV: "production",
    VOICE_PROVIDER_SECONDS_PER_DAY: "3600",
    VOICE_PROVIDER_SECONDS_PER_MONTH: "54000",
  });

  // The wrapped line puts a newline between the name and the clause.
  assert.match(output, /VOICE_INPUT_\*/);
  assert.match(output, /separate per-subject guardrail/);
});
