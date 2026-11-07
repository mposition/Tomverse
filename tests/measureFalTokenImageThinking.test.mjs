import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { attributeUsage, PROMPTS, usageCostMicroUsd } from "../scripts/measure-fal-token-image-thinking.mjs";

// The script spends money, so what it can be tested on without spending any is
// tested: the arithmetic that turns fal's minute buckets into per-call costs,
// and the refusals that stand between an invocation and a paid call.

const SCRIPT = fileURLToPath(new URL("../scripts/measure-fal-token-image-thinking.mjs", import.meta.url));

const call = (startedAt, finishedAt) => ({ startedAt, finishedAt });
const bucket = (minute, costMicroUsd) => ({ bucket: `2026-11-07T10:${minute}:00Z`, costMicroUsd });

test("usage line items sum to micro-USD, and anything unreadable is null", () => {
  assert.equal(usageCostMicroUsd([{ cost_total: 0.031, currency: "USD" }, { cost_total: 0.009, currency: "USD" }]), 40_000);
  assert.equal(usageCostMicroUsd([]), 0);
  for (const items of [null, [{ cost_total: 0.01, currency: "EUR" }], [{ cost_total: "0.01", currency: "USD" }], [{ cost_total: -1, currency: "USD" }]]) {
    assert.equal(usageCostMicroUsd(items), null, JSON.stringify(items));
  }
});

test("spaced calls each own their minute, and the maximum is the largest of them", () => {
  const calls = [call("2026-11-07T10:00:10Z", "2026-11-07T10:00:30Z"), call("2026-11-07T10:01:45Z", "2026-11-07T10:02:05Z")];
  const result = attributeUsage(calls, [bucket("00", 41_000), bucket("01", 20_000), bucket("02", 23_000), bucket("03", 0)]);
  assert.deepEqual(result.perCallMicroUsd, [41_000, 43_000]);
  assert.equal(result.maxObservedMicroUsd, 43_000);
});

test("a bucket two calls touch attributes to neither, so there is no maximum", () => {
  const calls = [call("2026-11-07T10:00:10Z", "2026-11-07T10:00:20Z"), call("2026-11-07T10:00:40Z", "2026-11-07T10:00:50Z")];
  const result = attributeUsage(calls, [bucket("00", 80_000)]);
  assert.deepEqual(result.perCallMicroUsd, [null, null]);
  assert.equal(result.maxObservedMicroUsd, null);
});

test("cost no call explains voids the maximum rather than being dropped", () => {
  // Other traffic on the endpoint -- or a charge of ours stamped late. Either
  // way the per-call figures can no longer be trusted as the whole bill.
  const calls = [call("2026-11-07T10:00:10Z", "2026-11-07T10:00:30Z")];
  const result = attributeUsage(calls, [bucket("00", 40_000), bucket("05", 40_000)]);
  assert.deepEqual(result.perCallMicroUsd, [40_000]);
  assert.equal(result.unexplainedMicroUsd, 40_000);
  assert.equal(result.maxObservedMicroUsd, null);
  // So does an unreadable bucket, and a call nothing was billed against.
  assert.equal(attributeUsage(calls, [bucket("00", 40_000), bucket("01", null)]).maxObservedMicroUsd, null);
  assert.equal(attributeUsage([...calls, call("2026-11-07T10:03:00Z", "2026-11-07T10:03:20Z")], [bucket("00", 40_000)]).maxObservedMicroUsd, null);
  assert.equal(attributeUsage([], []).maxObservedMicroUsd, null);
});

test("a zone-less bucket is read as UTC, the zone it was requested in", () => {
  const calls = [call("2026-11-07T10:00:10Z", "2026-11-07T10:00:30Z")];
  assert.deepEqual(attributeUsage(calls, [{ bucket: "2026-11-07T10:00:00", costMicroUsd: 40_000 }]).perCallMicroUsd, [40_000]);
});

test("the built-in prompts are two different cost axes", () => {
  assert.deepEqual(Object.keys(PROMPTS), ["geometry", "lettering"]);
  assert.notEqual(PROMPTS.geometry, PROMPTS.lettering);
});

const run = (args) =>
  spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    // A key that cannot authenticate: even a regression past the refusals
    // could not spend anything.
    env: { ...process.env, FAL_KEY: "not-a-real-key", FAL_BILLING_KEY: "" },
    encoding: "utf8",
    timeout: 60_000,
  });

test("nothing is sent without --i-accept-the-cost, an approved endpoint and known flags", () => {
  const plan = run(["--out=unused.json"]);
  assert.equal(plan.status, 1);
  assert.match(plan.stderr, /Would send 6 paid generation\(s\) to google\/nano-banana-2\.1/);
  assert.match(plan.stderr, /thinking_level "minimal"/);
  assert.match(plan.stderr, /Nothing was sent/);

  // Nano Banana 2 is a flat surcharge already measured (policy 16.8); an
  // unlisted endpoint has no row. Neither is this script's to measure.
  for (const endpoint of ["fal-ai/nano-banana-2", "fal-ai/flux/dev"]) {
    const refused = run([`--endpoint=${endpoint}`, "--out=unused.json", "--i-accept-the-cost"]);
    assert.equal(refused.status, 1, endpoint);
    assert.match(refused.stderr, /not a token-billed endpoint/, endpoint);
  }
  for (const args of [["-repeats=2"], ["--repeats=11", "--out=x.json"], ["--spacing-seconds=30", "--out=x.json"], ["--repeats=2"]]) {
    const refused = run([...args, "--i-accept-the-cost"]);
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.stderr, /Nothing was sent/, args.join(" "));
  }
});
