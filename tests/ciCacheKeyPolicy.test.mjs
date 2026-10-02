import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CACHE_FAMILIES, judgeCacheKeys, readCacheSteps } from "../scripts/ci-cache-key-policy.mjs";

const wf = (name, body) => ({ path: `.github/workflows/${name}.yml`, text: body });

/** A workflow with one cache step, parameterised so each case states only what it changes. */
const oneStep = ({ path = ".next/cache", key, restoreKeys = [], uses = "actions/cache@v5" }) =>
  [
    "on: pull_request",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: " + uses,
    "        with:",
    "          path: " + path,
    ...(key === undefined ? [] : ["          key: " + key]),
    ...(restoreKeys.length === 0
      ? []
      : ["          restore-keys: |", ...restoreKeys.map((entry) => "            " + entry)]),
    "",
  ].join("\n");

const rules = (sources) => judgeCacheKeys(sources).findings.map((finding) => finding.rule);

const OS = "${{ runner.os }}";
const LOCK = "${{ hashFiles('package-lock.json') }}";

test("a namespaced key with a namespaced restore-key is accepted", () => {
  const result = judgeCacheKeys([
    wf("ci", oneStep({ key: `${OS}-next-v2-pr-${LOCK}-abc`, restoreKeys: [`${OS}-next-v2-pr-${LOCK}-`] })),
  ]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.problems, []);
});

test("a restore-key that names only the cache family is refused", () => {
  for (const broad of [`${OS}-next-`, `${OS}-next`, `${OS}-`]) {
    assert.ok(
      rules([wf("ci", oneStep({ key: `${OS}-next-v2-pr-${LOCK}-abc`, restoreKeys: [broad] }))]).includes(
        "restore_key_names_only_the_family",
      ),
      `expected "${broad}" to be refused`,
    );
  }
});

test("a blank restore-keys entry is dropped rather than refused", () => {
  // A blank line in a `restore-keys: |` block is whitespace, not a prefix that
  // matches everything -- `actions/cache` never asks for it. Refusing it would
  // fail a workflow over its own formatting; the rule has to bite on a real
  // prefix instead.
  const read = readCacheSteps(
    [
      "on: pull_request",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/cache@v5",
      "        with:",
      "          path: .next/cache",
      "          key: " + `${OS}-next-v2-pr-${LOCK}-abc`,
      "          restore-keys: |",
      "            " + `${OS}-next-v2-pr-${LOCK}-`,
      "",
      "",
    ].join("\n"),
  );
  assert.deepEqual(read.steps[0].restoreKeys, [`${OS}-next-v2-pr-${LOCK}-`]);
});

test("the family boundary is the whole token, not a character count", () => {
  // `next-v` is longer than the family prefix and still narrower than a
  // namespace, but it is not a prefix of the family token, so the prefix rule
  // is what must catch a typo like this rather than the family rule.
  const found = rules([
    wf("ci", oneStep({ key: `${OS}-next-v2-pr-${LOCK}-abc`, restoreKeys: [`${OS}-next-v2-`] })),
  ]);
  assert.deepEqual(found, []);
});

test("a restore-key that is not a prefix of its own key is refused", () => {
  const found = rules([
    wf("ci", oneStep({ key: `${OS}-next-v2-pr-${LOCK}-abc`, restoreKeys: [`${OS}-next-v2-admin-e2e-${LOCK}-`] })),
  ]);
  assert.ok(found.includes("restore_key_not_a_prefix"));
});

test("two workflows declaring the same key are refused, and one workflow's two jobs are not", () => {
  const key = `${OS}-playwright-v2-pr-${LOCK}-chromium`;
  const shared = judgeCacheKeys([
    wf("a", oneStep({ path: "~/.cache/ms-playwright", key })),
    wf("b", oneStep({ path: "~/.cache/ms-playwright", key })),
  ]);
  assert.deepEqual(
    shared.findings.map((finding) => finding.rule),
    ["key_shared_across_workflows"],
  );
  assert.equal(shared.findings[0].detail, key);

  const twoJobsOneWorkflow = [
    "on: pull_request",
    "jobs:",
    "  one:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/cache@v5",
    "        with:",
    "          path: ~/.cache/ms-playwright",
    "          key: " + key,
    "  two:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/cache@v5",
    "        with:",
    "          path: ~/.cache/ms-playwright",
    "          key: " + key,
    "",
  ].join("\n");
  assert.deepEqual(judgeCacheKeys([wf("a", twoJobsOneWorkflow)]).findings, []);
});

test("a cache path outside the governed families is not judged", () => {
  const result = judgeCacheKeys([
    wf("ci", oneStep({ path: "~/.cargo/registry", key: `${OS}-rust-${LOCK}`, restoreKeys: [`${OS}-`] })),
  ]);
  assert.deepEqual(result.findings, []);
});

test("restore and save variants are read, and a save step needs no key", () => {
  const restoreOnly = readCacheSteps(
    oneStep({ key: `${OS}-next-v2-pr-${LOCK}-abc`, uses: "actions/cache/restore@v5" }),
  );
  assert.equal(restoreOnly.steps.length, 1);
  assert.equal(restoreOnly.steps[0].mode, "restore");

  const saveNoKey = judgeCacheKeys([wf("ci", oneStep({ uses: "actions/cache/save@v5" }))]);
  assert.deepEqual(saveNoKey.problems, []);
  assert.deepEqual(saveNoKey.findings, []);
});

test("a key missing from a restoring step is a problem, not a silent pass", () => {
  const result = judgeCacheKeys([wf("ci", oneStep({ uses: "actions/cache@v5" }))]);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0].problem, /key_missing/);
});

test("an unparseable workflow is a problem rather than a pass", () => {
  const result = judgeCacheKeys([wf("bad", "on: [\n")]);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0].problem, /yaml_unparseable/);
});

test("the governed families are the two the audit measured", () => {
  assert.deepEqual(
    CACHE_FAMILIES.map((entry) => entry.path),
    [".next/cache", "~/.cache/ms-playwright"],
  );
});

test("this repository's committed workflows pass the policy", () => {
  const dir = ".github/workflows";
  const sources = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ path: `${dir}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
  assert.ok(sources.length > 20, "expected the whole workflow directory");
  const result = judgeCacheKeys(sources);
  assert.deepEqual(result.problems, [], "every workflow must be readable");
  assert.deepEqual(
    result.findings.map((finding) => `${finding.rule}: ${finding.workflowPath}`),
    [],
  );
});

test("every governed cache step in this repository carries a namespace segment", () => {
  const dir = ".github/workflows";
  const seen = [];
  for (const name of readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry))) {
    const read = readCacheSteps(readFileSync(join(dir, name), "utf8"));
    assert.ok(read.steps, `${name} must parse`);
    for (const step of read.steps) {
      const family = CACHE_FAMILIES.find((entry) => step.paths.includes(entry.path));
      if (!family || step.key === null) continue;
      const prefix = `${OS}-${family.family}-`;
      assert.ok(step.key.startsWith(prefix), `${name} # ${step.jobId}: key must start with ${prefix}`);
      const rest = step.key.slice(prefix.length);
      // `v<n>-<namespace>-` at minimum: the version lets a poisoned generation
      // be abandoned without an operator deleting entries by hand, and the
      // namespace is what keeps two workflows off one entry.
      assert.match(
        rest,
        /^v\d+-[a-z0-9-]+-\$\{\{ hashFiles/,
        `${name} # ${step.jobId}: expected v<n>-<namespace>- after ${prefix}, got "${rest}"`,
      );
      seen.push(`${name}#${step.jobId}`);
    }
  }
  assert.ok(seen.length >= 16, `expected the governed steps to be found, saw ${seen.length}`);
});
