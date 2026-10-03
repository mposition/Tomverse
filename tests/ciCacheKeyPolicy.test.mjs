import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  CACHE_FAMILIES,
  WIDELY_READABLE_BRANCHES,
  judgeCacheKeys,
  namespacePrefix,
  reachesWidelyReadableScope,
  saveConditionKeepsToPullRequest,
  readCacheSteps,
} from "../scripts/ci-cache-key-policy.mjs";

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

test("a restore-key broader than its own generation and namespace is refused", () => {
  // `${OS}-next-v2-` is the case an earlier version of this module allowed and
  // an earlier version of this test asserted was fine. It is a prefix of its
  // own key and longer than the family token, and it still matches
  // Linux-next-v2-daily-, Linux-next-v2-admin-e2e- and every other namespace
  // one generation down -- the same shared pool the family-wide fallback made.
  // Independent review caught it.
  for (const broad of [`${OS}-next-`, `${OS}-next`, `${OS}-`, `${OS}-next-v2-`, `${OS}-next-v2-p`]) {
    assert.ok(
      rules([wf("ci", oneStep({ key: `${OS}-next-v2-pr-${LOCK}-abc`, restoreKeys: [broad] }))]).includes(
        "restore_key_broader_than_namespace",
      ),
      `expected "${broad}" to be refused`,
    );
  }
});

test("a restore-key at exactly the namespace boundary, or narrower, is accepted", () => {
  for (const ok of [`${OS}-next-v2-pr-`, `${OS}-next-v2-pr-${LOCK}-`]) {
    assert.deepEqual(
      rules([wf("ci", oneStep({ key: `${OS}-next-v2-pr-${LOCK}-abc`, restoreKeys: [ok] }))]),
      [],
      `expected "${ok}" to be accepted`,
    );
  }
});

test("a governed key must carry v<n>-<namespace>- before its first expression", () => {
  const bad = [
    `${OS}-next-pr-${LOCK}-src`, // no generation
    `${OS}-next-v2-${LOCK}-src`, // no namespace
    `${OS}-next-v2-PR-${LOCK}-src`, // upper case is not the namespace shape
    `${OS}-next-v2-pr-literal`, // no expression at all, so no boundary can be read
  ];
  for (const key of bad) {
    assert.ok(
      rules([wf("ci", oneStep({ key }))]).includes("key_missing_generation_and_namespace"),
      `expected "${key}" to be refused`,
    );
  }
  assert.deepEqual(rules([wf("ci", oneStep({ key: `${OS}-next-v2-admin-e2e-${LOCK}-src` }))]), []);

  // The shape these keys had before this policy existed, on its own family.
  assert.ok(
    rules([
      wf("ci", oneStep({ path: "~/.cache/ms-playwright", key: `${OS}-playwright-${LOCK}-chromium` })),
    ]).includes("key_missing_generation_and_namespace"),
  );

  // A key naming the wrong family for its path is its own finding, so the two
  // failures are not reported as the same thing.
  assert.ok(
    rules([wf("ci", oneStep({ path: "~/.cache/ms-playwright", key: `${OS}-next-v2-pr-${LOCK}-src` }))]).includes(
      "key_missing_family_prefix",
    ),
  );
});

test("namespacePrefix reads the literal region, hyphenated namespaces included", () => {
  assert.equal(namespacePrefix(`${OS}-next-v2-admin-e2e-${LOCK}-src`, "next").prefix, `${OS}-next-v2-admin-e2e-`);
  assert.equal(
    namespacePrefix(`${OS}-playwright-v2-daily-${LOCK}-chromium-webkit`, "playwright").prefix,
    `${OS}-playwright-v2-daily-`,
  );
  assert.equal(namespacePrefix(`${OS}-next-v2-pr-${LOCK}-src`, "playwright").problem, "key_missing_family_prefix");
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

/* ------------------------------------------------------------------------- */
/* The write rule: who may put an entry where every run can read it           */
/* ------------------------------------------------------------------------- */

const onBlock = (yaml) => parseYaml(`${yaml}\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps: []\n`);

test("a run that can land on main or develop is treated as widely readable", () => {
  const wide = [
    "on:\n  schedule:\n    - cron: '0 1 * * *'",
    "on:\n  workflow_dispatch: {}",
    "on:\n  push:\n    branches: [main]",
    "on:\n  push:\n    branches: [develop]",
    "on:\n  push:\n    branches: ['**']",
    "on:\n  push: {}",
    "on:\n  push:\n    branches-ignore: ['feature/**']",
    "on: push",
  ];
  for (const yaml of wide) {
    assert.equal(reachesWidelyReadableScope(onBlock(yaml)), true, yaml);
  }
});

test("every event outside the narrow allowlist reaches, not just the four once named", () => {
  // An earlier version asked about push, schedule, workflow_dispatch and
  // workflow_call and answered "not widely readable" for everything else, so
  // these -- all of which run on the default branch -- read as narrow. It is an
  // allowlist now. Independent review caught this.
  const wide = [
    "on:\n  workflow_run:\n    workflows: [ci]",
    "on:\n  repository_dispatch: {}",
    "on:\n  issue_comment:\n    types: [created]",
    "on:\n  issues: {}",
    "on:\n  pull_request_target: {}",
    "on:\n  pull_request_review: {}",
    "on:\n  check_suite: {}",
    "on:\n  release:\n    types: [published]",
    "on:\n  merge_group: {}",
    "on:\n  deployment_status: {}",
  ];
  for (const yaml of wide) {
    assert.equal(reachesWidelyReadableScope(onBlock(yaml)), true, yaml);
  }
});

test("a pull_request whose types include closed is not treated as narrow", () => {
  // Whether a merged pull request's run still carries the merge ref is not
  // something this module can establish, and this governs a write.
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  pull_request:\n    types: [closed]")), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  pull_request:\n    types: [opened, closed]")), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  pull_request:\n    types: [unknown_future_type]")), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  pull_request:\n    types: []")), true);
});

test("a pull-request-only or feature-branch-only run is not widely readable", () => {
  const narrow = [
    "on:\n  pull_request:\n    types: [opened]",
    "on:\n  pull_request: {}",
    "on: pull_request",
    "on:\n  push:\n    branches: ['to-develop/**', '**/to-develop/**']",
    "on:\n  push:\n    branches: [release-notes]",
    "on:\n  push:\n    tags: ['v*']",
    "on:\n  push:\n    branches-ignore: ['main', 'develop']",
  ];
  for (const yaml of narrow) {
    assert.equal(reachesWidelyReadableScope(onBlock(yaml)), false, yaml);
  }
});

test("an ignore filter must certainly exclude both shared branches, not merely maybe", () => {
  // This was backwards: `patternCouldMatch` answers "could" with true for an
  // unmodelled glob, and the ignore branch read that as "is excluded", so
  // `branches-ignore: ['feat*ure']` passed as keeping a run off main and
  // develop. Independent review caught it. An unmodelled pattern now proves
  // nothing, which is the conservative direction for an exclusion.
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches-ignore: ['feat*ure']")), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches-ignore: ['ma?n', 'develop']")), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches-ignore: ['main']")), true, "develop left in");
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches-ignore: ['**']")), false);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches-ignore: ['main', 'develop']")), false);
});

test("a trigger block that cannot be read is treated as widely readable", () => {
  // Deciding whether a write is allowed, so the unreadable answer has to be
  // the restrictive one.
  assert.equal(reachesWidelyReadableScope({}), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches: 7")), true);
  // Character classes, `?` and `+` are not modelled, so an include list using
  // one could be naming a shared branch.
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches: ['ma?n']")), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches: ['mai[nx]']")), true);
});

test("a `*` inside a branch name is modelled rather than given up on", () => {
  // `feat*ure` compiles: `*` is one segment's worth of anything, and neither
  // main nor develop matches it. Treating every pattern with a `*` as unknown
  // would make ordinary feature-branch filters read as reaching main.
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches: ['feat*ure']")), false);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches: ['mai*']")), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches: ['dev*']")), true);
  assert.equal(reachesWidelyReadableScope(onBlock("on:\n  push:\n    branches: ['feature/*']")), false);
});

const scheduled = (step) =>
  [
    "on:",
    "  schedule:",
    "    - cron: '0 1 * * *'",
    "jobs:",
    "  j:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...step,
    "",
  ].join("\n");

test("the combined cache action is refused in a widely readable workflow", () => {
  const found = rules([
    wf(
      "nightly",
      scheduled([
        "      - uses: actions/cache@v5",
        "        with:",
        "          path: .next/cache",
        `          key: ${OS}-next-v2-x-${LOCK}-a`,
      ]),
    ),
  ]);
  assert.deepEqual(found, ["unguarded_save_in_widely_readable_scope"]);
});

test("restore-only is accepted in a widely readable workflow", () => {
  const found = rules([
    wf(
      "nightly",
      scheduled([
        "      - uses: actions/cache/restore@v5",
        "        with:",
        "          path: .next/cache",
        `          key: ${OS}-next-v2-x-${LOCK}-a`,
      ]),
    ),
  ]);
  assert.deepEqual(found, []);
});

test("a save's condition must provably hold only on a pull-request run", () => {
  // Checking that the text mentioned `github.event_name` or `github.ref` was
  // not enough: `github.event_name == 'schedule'` mentions it and permits a
  // write on the default branch, and `github.ref != 'refs/heads/main'` permits
  // one on develop. Independent review caught both.
  const save = (condition) =>
    wf(
      "nightly",
      scheduled([
        "      - uses: actions/cache/save@v5",
        ...(condition === null ? [] : [`        if: ${condition}`]),
        "        with:",
        "          path: .next/cache",
        `          key: ${OS}-next-v2-x-${LOCK}-a`,
      ]),
    );
  const allowed = [
    "github.event_name == 'pull_request'",
    'github.event_name == "pull_request"',
    "success() && github.event_name == 'pull_request'",
    "github.event_name == 'pull_request' && steps.scope.outputs.code == 'true'",
  ];
  for (const condition of allowed) {
    assert.deepEqual(rules([save(condition)]), [], condition);
    assert.equal(saveConditionKeepsToPullRequest(condition), true, condition);
  }
  const refused = [
    null,
    "",
    "success()",
    "steps.scope.outputs.code == 'true'",
    "github.event_name == 'schedule'",
    "github.ref != 'refs/heads/main'",
    "github.ref == 'refs/heads/develop'",
    "github.event_name == 'pull_request' || github.event_name == 'push'",
    "!(github.event_name == 'pull_request')",
    "github.event_name != 'pull_request'",
  ];
  for (const condition of refused) {
    assert.deepEqual(rules([save(condition)]), ["unguarded_save_in_widely_readable_scope"], String(condition));
    if (condition !== null) assert.equal(saveConditionKeepsToPullRequest(condition), false, condition);
  }
});

test("a restore-key may not be a prefix of another workflow's key", () => {
  // Two shapes the namespace rule alone lets through, both raised in review.
  const MATRIX = "${{ matrix.lane }}";
  const step = (key, restoreKeys = []) =>
    oneStep({ key, restoreKeys, uses: "actions/cache@v5" });

  // A dynamic segment inside the namespace region: A's own namespace ends at
  // `pr-`, so `...-v2-pr-` is a legal restore-key for it and still matches B.
  assert.ok(
    rules([
      wf("a", step(`${OS}-next-v2-pr-${MATRIX}-${LOCK}-src`, [`${OS}-next-v2-pr-`])),
      wf("b", step(`${OS}-next-v2-pr-admin-${LOCK}-src`)),
    ]).includes("restore_key_reaches_another_workflow"),
  );

  // Static namespaces where one is a prefix of the other.
  assert.ok(
    rules([
      wf("a", step(`${OS}-next-v2-pr-${LOCK}-src`, [`${OS}-next-v2-pr-`])),
      wf("b", step(`${OS}-next-v2-pr-admin-${LOCK}-src`)),
    ]).includes("restore_key_reaches_another_workflow"),
  );

  // Namespaces where neither is a prefix of the other stay accepted.
  assert.deepEqual(
    rules([
      wf("a", step(`${OS}-next-v2-pr-${LOCK}-src`, [`${OS}-next-v2-pr-${LOCK}-`])),
      wf("b", step(`${OS}-next-v2-daily-${LOCK}-src`, [`${OS}-next-v2-daily-${LOCK}-`])),
    ]),
    [],
  );

  // Inside one workflow a shared prefix is legal: its jobs are one unit of trust.
  const twoJobs = [
    "on: pull_request",
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/cache@v5",
    "        with:",
    "          path: .next/cache",
    `          key: ${OS}-next-v2-pr-${LOCK}-x`,
    "          restore-keys: |",
    `            ${OS}-next-v2-pr-`,
    "  b:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/cache@v5",
    "        with:",
    "          path: .next/cache",
    `          key: ${OS}-next-v2-pr-${LOCK}-y`,
    "",
  ].join("\n");
  assert.deepEqual(rules([wf("one", twoJobs)]), []);
});

test("the write rule covers every cached path, not only the namespaced families", () => {
  const found = rules([
    wf(
      "nightly",
      scheduled([
        "      - uses: actions/cache@v5",
        "        with:",
        "          path: |",
        "            ~/.cargo/registry",
        "            target",
        `          key: ${OS}-rust-${LOCK}`,
      ]),
    ),
  ]);
  assert.deepEqual(found, ["unguarded_save_in_widely_readable_scope"]);
});

test("a pull-request-only workflow may still use the combined action", () => {
  const found = rules([
    wf("gate", oneStep({ key: `${OS}-next-v2-pr-${LOCK}-abc`, restoreKeys: [`${OS}-next-v2-pr-${LOCK}-`] })),
  ]);
  assert.deepEqual(found, []);
});

test("setup-node's own npm cache is out of scope for these rules", () => {
  // npm ci verifies every tarball against the lockfile, so a tampered entry
  // cannot install different code. Suppressing it would cost every install for
  // no change in what can execute.
  const found = rules([
    wf(
      "nightly",
      scheduled([
        "      - uses: actions/setup-node@v6",
        "        with:",
        "          node-version: 22",
        "          cache: npm",
      ]),
    ),
  ]);
  assert.deepEqual(found, []);
});

test("the widely readable branches are the default branch and the pull-request base", () => {
  assert.deepEqual(WIDELY_READABLE_BRANCHES, ["main", "develop"]);
});

test("no committed workflow writes a cache from a widely readable scope", () => {
  const dir = ".github/workflows";
  const offenders = [];
  for (const name of readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry))) {
    const text = readFileSync(join(dir, name), "utf8");
    const read = readCacheSteps(text);
    assert.ok(read.steps, `${name} must parse`);
    if (!read.widelyReadable) continue;
    for (const step of read.steps) {
      if (step.mode === "restore") continue;
      const guarded =
        step.mode === "save" && typeof step.condition === "string" && /github\.(event_name|ref)\b/.test(step.condition);
      if (!guarded) offenders.push(`${name} # ${step.jobId} (${step.mode})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the workflows that may still write are the pull-request-only ones", () => {
  const dir = ".github/workflows";
  const writers = new Set();
  for (const name of readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry))) {
    const read = readCacheSteps(readFileSync(join(dir, name), "utf8"));
    if (read.widelyReadable) continue;
    if (read.steps.some((step) => step.mode === "cache")) writers.add(name);
  }
  // Pinned so that making another workflow a cache writer is a visible change
  // rather than a silent one.
  assert.deepEqual([...writers].sort(), ["pr-fast-gate.yml", "review-parity-shadow.yml"]);
});
