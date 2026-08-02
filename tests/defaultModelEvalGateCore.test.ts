import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyArmOutcome,
  evaluatePreflightArtifact,
} from "@/lib/defaultModelEvalGateCore";

const armSummary = (
  arm: string,
  attempted: number,
  providerErrorRate: number
) => ({ arm, attempted, providerErrorRate });

const preflight = (
  summaries: ReturnType<typeof armSummary>[],
  manifest: Record<string, unknown> = {}
) => ({
  summaries,
  manifest: { allArmsPresent: true, commitSha: "abc123", repeats: 2, ...manifest },
});

const allFourHealthy = [
  armSummary("baseline", 24, 0),
  armSummary("none", 24, 0),
  armSummary("low", 24, 0),
  armSummary("medium", 24, 0),
];

test("an arm that answered is measured", () => {
  assert.equal(
    classifyArmOutcome({ attempted: 300, providerErrorRate: 0.01 }),
    "measured"
  );
  assert.equal(
    classifyArmOutcome({ attempted: 300, providerErrorRate: 0.5 }),
    "measured"
  );
});

test("an arm that never reached the provider is not a quality failure", () => {
  // The distinction this whole classification exists for. A 100% error rate
  // produces a 0% success rate, which reads identically to a model failing
  // every scenario -- and is the state this repository's own environment is
  // in, because the egress proxy blocks api.openai.com.
  assert.equal(
    classifyArmOutcome({ attempted: 300, providerErrorRate: 1 }),
    "provider_unavailable"
  );
  assert.equal(
    classifyArmOutcome({ attempted: 0, providerErrorRate: 0 }),
    "not_run"
  );
});

test("a mostly-failed arm is inconclusive, not a verdict", () => {
  assert.equal(
    classifyArmOutcome({ attempted: 300, providerErrorRate: 0.51 }),
    "inconclusive"
  );
  assert.equal(
    classifyArmOutcome({ attempted: 300, providerErrorRate: 0.99 }),
    "inconclusive"
  );
});

test("a healthy four-arm preflight clears the main run", () => {
  const verdict = evaluatePreflightArtifact(preflight(allFourHealthy));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.commitSha, "abc123");
  assert.equal(verdict.ok && verdict.repeats, 2);
});

test("a preflight where an arm never answered does not clear the main run", () => {
  // "The preflight ran" is not the bar: a preflight in which nothing reached
  // the provider is precisely what the gate exists to catch before 1,200
  // billed calls.
  const verdict = evaluatePreflightArtifact(
    preflight([...allFourHealthy.slice(0, 3), armSummary("medium", 24, 1)])
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.reason, /medium completed no successful call/);
});

test("a preflight missing arms does not clear the main run", () => {
  const verdict = evaluatePreflightArtifact(
    preflight(allFourHealthy.slice(0, 2), { allArmsPresent: false })
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.reason, /all four arms must preflight together/);
});

test("an empty, malformed or absent artefact does not clear the main run", () => {
  for (const artifact of [null, undefined, 42, "{}", {}, { summaries: [] }]) {
    const verdict = evaluatePreflightArtifact(artifact);
    assert.equal(verdict.ok, false, JSON.stringify(artifact));
  }
});

test("the harness gates the main run and never retires anything", () => {
  const source = readFileSync(
    join(process.cwd(), "scripts/evalDefaultModel.mjs"),
    "utf8"
  );
  // The gate applies above a probe-sized run, and can only be bypassed on the
  // record.
  assert.match(source, /PREFLIGHT_REQUIRED_ABOVE_REPEATS/);
  assert.match(source, /preflight-override/);
  assert.match(source, /max-cost-usd/);
  // No write path of any kind: an eval that could change the catalogue would
  // make a numeric threshold sufficient for a retirement, which sections 4.3
  // and 4.6 explicitly say it is not.
  assert.equal(/prisma\./.test(source), false);
  assert.equal(/modelRegistryEntry/i.test(source), false);
  assert.equal(/run-default-model-reconciliation/.test(source), false);
});
