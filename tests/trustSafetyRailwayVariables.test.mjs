import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_ONLY_NAMES,
  RUNNER_ALLOWED_NAMES,
  UNJUDGED,
  buildVariableManifest,
  compareEnvironment,
} from "../scripts/trust-safety-railway-variables-core.mjs";

/**
 * O3 of docs/policy/trust-safety-compliance-agent.md §12 (3) hands this
 * comparison to a script so the operator runs and signs instead of reading a
 * dashboard. These hold it to the boundary §4 of that policy draws.
 */

const both = () => [...RUNNER_ALLOWED_NAMES];

test("the allowlist is the two names §4 fixes, and the ping URL is not one", () => {
  assert.deepEqual(RUNNER_ALLOWED_NAMES, [
    "TRUST_SAFETY_OBSERVER_SECRET",
    "TRUST_SAFETY_OBSERVER_URL",
  ]);
  assert.deepEqual(APP_ONLY_NAMES, ["TRUST_SAFETY_OBSERVER_PING_URL"]);
  assert.equal(RUNNER_ALLOWED_NAMES.includes("TRUST_SAFETY_OBSERVER_PING_URL"), false);
});

test("the declared and effective names matching is a match", () => {
  const result = compareEnvironment({
    environment: "production",
    declared: both(),
    effective: both(),
  });
  assert.equal(result.verdict, "match");
});

test("a name Railway has but nobody declared is a mismatch, and is named", () => {
  const result = compareEnvironment({
    environment: "production",
    declared: both(),
    effective: [...both(), "SOMETHING_ELSE"],
  });
  assert.equal(result.verdict, "mismatch");
  const finding = result.findings.find((entry) => entry.id === "effective-matches-declared");
  assert.equal(finding.ok, false);
  assert.match(finding.because, /set but not declared: SOMETHING_ELSE/);
});

test("a declared name that is not set is a mismatch too", () => {
  const result = compareEnvironment({
    environment: "staging",
    declared: both(),
    effective: ["TRUST_SAFETY_OBSERVER_URL"],
  });
  assert.equal(result.verdict, "mismatch");
  assert.match(
    result.findings.find((entry) => entry.id === "effective-matches-declared").because,
    /declared but not set: TRUST_SAFETY_OBSERVER_SECRET/,
  );
});

test("each of §4's four refusals is caught by name", () => {
  const cases = [
    ["DATABASE_URL", /product database credential/],
    ["GITHUB_TOKEN", /GitHub token/],
    ["ANTHROPIC_API_KEY", /LLM provider key/],
    ["TRUST_SAFETY_OBSERVER_PING_URL", /dead-man ping URL/],
  ];
  for (const [name, because] of cases) {
    const result = compareEnvironment({
      environment: "production",
      declared: both(),
      effective: [...both(), name],
    });
    assert.equal(result.verdict, "mismatch", `${name} must be refused`);
    const finding = result.findings.find((entry) => entry.id === "effective-forbidden");
    assert.equal(finding.ok, false);
    assert.match(finding.because, because);
  }
});

test("the ping URL on the runner is refused even though it is an expected name elsewhere", () => {
  // §4 keeps it in the app alone, so its presence on the runner is a finding
  // rather than a match against the app's allowlist.
  const result = compareEnvironment({
    environment: "production",
    declared: ["TRUST_SAFETY_OBSERVER_PING_URL"],
    effective: ["TRUST_SAFETY_OBSERVER_PING_URL"],
  });
  assert.equal(result.verdict, "mismatch");
  assert.equal(result.findings.find((entry) => entry.id === "declared-allowed").ok, false);
  assert.equal(result.findings.find((entry) => entry.id === "effective-forbidden").ok, false);
});

test("a fact that could not be read is unreadable, never a match", () => {
  const noDeclaration = compareEnvironment({ environment: "dev", effective: both() });
  assert.equal(noDeclaration.verdict, "unreadable");
  const noRailway = compareEnvironment({ environment: "dev", declared: both() });
  assert.equal(noRailway.verdict, "unreadable");
  // An absent answer must not be read as an empty set: an empty set matches an
  // empty allowlist and would report a pass.
  assert.notEqual(
    compareEnvironment({ environment: "dev", declared: undefined, effective: undefined }).verdict,
    "match",
  );
});

test("a service declared for no environment says so instead of passing quietly", () => {
  // Today the trust-safety runner is not in `.railway/agent-runners.ts` at all.
  const result = compareEnvironment({ environment: "production", declared: [], effective: [] });
  assert.equal(result.verdict, "mismatch");
  assert.match(
    result.findings.find((entry) => entry.id === "declared").because,
    /declares no variables/,
  );
  assert.equal(result.findings.find((entry) => entry.id === "declared-complete").ok, false);
});

test("the manifest prints the two things it cannot judge", () => {
  const manifest = buildVariableManifest({
    environments: [{ environment: "production", declared: both(), effective: both() }],
    appVariableNames: [...APP_ONLY_NAMES],
  });
  assert.equal(manifest.verdict, "match");
  assert.deepEqual(manifest.unjudged, [...UNJUDGED]);
  assert.equal(manifest.unjudged.length, 2);
  assert.match(manifest.unjudged[0], /credential/);
  assert.match(manifest.unjudged[1], /build stage/);
});

test("the app side is judged by name and the manifest carries no value", () => {
  const missing = buildVariableManifest({
    environments: [{ environment: "production", declared: both(), effective: both() }],
    appVariableNames: ["SOMETHING_ELSE"],
  });
  assert.equal(missing.app.ok, false);
  assert.equal(missing.verdict, "mismatch");

  // §4 forbids the ping URL's value in a log, a manifest or a route response.
  // Nothing in this module can carry one, and a caller that tried has nowhere
  // to put it -- the inputs are name lists.
  const manifest = buildVariableManifest({
    environments: [
      { environment: "production", declared: both(), effective: both() },
    ],
    appVariableNames: [...APP_ONLY_NAMES],
  });
  const text = JSON.stringify(manifest);
  assert.equal(/https?:\/\//.test(text), false, "no URL may appear in the manifest");
  assert.equal(/Bearer|secret=|token=/i.test(text), false);
});

test("one environment mismatching makes the manifest a mismatch", () => {
  const manifest = buildVariableManifest({
    environments: [
      { environment: "production", declared: both(), effective: both() },
      { environment: "staging", declared: both(), effective: ["TRUST_SAFETY_OBSERVER_URL"] },
    ],
    appVariableNames: [...APP_ONLY_NAMES],
  });
  assert.equal(manifest.verdict, "mismatch");
  assert.equal(manifest.comparisons.length, 2);
  assert.equal(manifest.comparisons[0].verdict, "match");
  assert.equal(manifest.comparisons[1].verdict, "mismatch");
});
