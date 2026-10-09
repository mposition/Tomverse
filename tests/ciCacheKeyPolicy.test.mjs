import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  ALLOWED_SAVE_CONDITIONS,
  CACHE_FAMILIES,
  cacheModeFailures,
  describeFinding,
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

test("every key must carry <family>-v<n>-<namespace>- in fixed text", () => {
  const bad = [
    `${OS}-next-pr-${LOCK}-src`, // no generation
    `${OS}-next-v2-${LOCK}-src`, // no namespace
    `${OS}-next-v2-PR-${LOCK}-src`, // upper case is not the namespace shape
    `${OS}-playwright-${LOCK}-chromium`, // the shape before this policy existed
    // The three shapes round 10 used to defeat the comparator this replaced.
    // None of them can reach the namespace region any more, because an
    // expression may not appear before it.
    `\${{ matrix.prefix }}a-${LOCK}`,
    `\${{ 'a}b' }}-next-v2-pr-${LOCK}`,
    `abc\${{ '' }}-next-v2-pr-${LOCK}`,
  ];
  for (const key of bad) {
    assert.ok(
      rules([wf("ci", oneStep({ path: "node_modules", key }))]).includes("key_missing_generation_and_namespace"),
      `expected "${key}" to be refused`,
    );
  }
  assert.deepEqual(rules([wf("ci", oneStep({ key: `${OS}-next-v2-admin-e2e-${LOCK}-src` }))]), []);
  // A key that is entirely fixed text is fine as long as the head is there --
  // the discipline is about the head, not about having a hash after it.
  assert.deepEqual(rules([wf("ci", oneStep({ key: `${OS}-next-v2-pr-literal` }))]), []);

  // A listed path must declare the family the table names for it, so a key
  // cannot borrow another family's namespace space.
  assert.ok(
    rules([wf("ci", oneStep({ path: "~/.cache/ms-playwright", key: `${OS}-next-v2-pr-${LOCK}-src` }))]).includes(
      "key_family_does_not_match_path",
    ),
  );
});

test("every rule a finding can carry has its own message", () => {
  // A rule with no `case` falls to the generic default, which prints the rule
  // name and nothing an author can act on. Independent review found
  // `key_family_does_not_match_path` in that state and a dead case left behind
  // for a rule that had been removed.
  const cases = [
    ["restore_key_not_a_prefix", "x"],
    ["restore_key_broader_than_namespace", "x"],
    ["key_missing_generation_and_namespace", "x"],
    ["key_family_does_not_match_path", "x"],
    ["key_shared_across_workflows", "x"],
    ["namespace_shared_across_workflows", "x"],
    ["namespace_reaches_another_workflow", "x"],
    ["unguarded_save_in_widely_readable_scope", "x"],
    ["cache_mode_write_capable_in_widely_readable_scope", "x"],
    ["cache_mode_widened_by_job", "x"],
    ["cache_mode_unreadable_on_job", "x"],
  ];
  for (const [rule, detail] of cases) {
    const message = describeFinding({ rule, workflowPath: "w", jobId: "j", detail });
    assert.ok(!message.includes(rule), `${rule} has no message of its own`);
    assert.ok(message.length > 40, `${rule}'s message says too little`);
  }
  // And the generic default still exists for a rule nobody has described yet.
  assert.ok(describeFinding({ rule: "future_rule", workflowPath: "w", jobId: null, detail: "d" }).includes("future_rule"));
});

test("only the ordinary spelling of the leading expression is accepted", () => {
  // GitHub evaluates `${{ runner['os'] }}` the same way, and this refuses it.
  // Deliberate, and in the safe direction: a refusal asks for the ordinary
  // form, where accepting an unrecognised spelling would mean treating a head
  // this cannot read as one it can.
  assert.equal(namespacePrefix(`\${{ runner['os'] }}-next-v2-pr-${LOCK}`, "next").problem, "key_missing_generation_and_namespace");
  assert.equal(namespacePrefix(`\${{ runner.OS }}-next-v2-pr-${LOCK}`, "next").problem, "key_missing_generation_and_namespace");
  assert.equal(namespacePrefix(`\${{ runner.os }}-next-v2-pr-${LOCK}`, "next").problem, null);
  assert.equal(namespacePrefix(`\${{runner.os}}-next-v2-pr-${LOCK}`, "next").problem, null);
});

test("namespacePrefix reads the fixed head and gives it an identity", () => {
  assert.equal(namespacePrefix(`${OS}-next-v2-admin-e2e-${LOCK}-src`, "next").prefix, `${OS}-next-v2-admin-e2e-`);
  assert.equal(namespacePrefix(`${OS}-next-v2-admin-e2e-${LOCK}-src`, "next").identity, "next:v2-admin-e2e-");
  assert.equal(
    namespacePrefix(`${OS}-playwright-v2-daily-${LOCK}-chromium-webkit`, "playwright").identity,
    "playwright:v2-daily-",
  );
  assert.equal(
    namespacePrefix(`${OS}-next-v2-pr-${LOCK}-src`, "playwright").problem,
    "key_family_does_not_match_path",
  );
  // The family comes from the key when no path declares one, which is how a
  // path with no table row is held to the same discipline.
  assert.equal(namespacePrefix(`${OS}-rust-v2-workspaces-${LOCK}`).identity, "rust:v2-workspaces-");
  // Whitespace inside the leading expression does not stop the head matching.
  assert.equal(namespacePrefix(`\${{  runner.os  }}-next-v2-pr-${LOCK}-src`, "next").identity, "next:v2-pr-");
});

test("two workflows holding one namespace are refused however the hashes are written", () => {
  // This is why the comparison is on the namespace and not on the key. Three
  // rounds of review established that hash text can neither prove nor disprove
  // value equality: `hashFiles('package-lock.json')` and
  // `hashFiles('./package-lock.json')` hash the same file through different
  // text, two globs can match the same files, and canonicalising whitespace to
  // make equal values equal text turned `hashFiles('a b.json')` into
  // `hashFiles('ab.json')` and invented a collision.
  const shared = (hash) => oneStep({ key: `${OS}-next-v2-shared-${hash}` });
  const hashes = [
    `\${{ hashFiles('package-lock.json') }}`,
    `\${{ hashFiles('./package-lock.json') }}`,
    `\${{ hashFiles( 'package-lock.json' ) }}`,
    `\${{ hashFiles("package-lock.json") }}`,
    `\${{ hashFiles('**/package-lock.json') }}`,
  ];
  for (const other of hashes.slice(1)) {
    assert.deepEqual(
      rules([wf("a", shared(hashes[0])), wf("b", shared(other))]),
      ["namespace_shared_across_workflows"],
      other,
    );
  }
});

test("a filename with a space is not read as a collision with one without", () => {
  // The canonicalisation that briefly existed removed whitespace inside string
  // literals, so these two became the same expression. They are different files.
  assert.deepEqual(
    rules([
      wf("a", oneStep({ key: `${OS}-next-v2-one-\${{ hashFiles('a b.json') }}` })),
      wf("b", oneStep({ key: `${OS}-next-v2-two-\${{ hashFiles('ab.json') }}` })),
    ]),
    [],
  );
});

test("an expression after the namespace is no longer anyone's business", () => {
  // With the comparison on namespaces, a matrix segment in the hash region
  // cannot reach another workflow: this key still begins with its own
  // namespace, and the other's begins with theirs.
  assert.deepEqual(
    rules([
      wf("a", oneStep({ key: `${OS}-next-v2-pr-\${{ matrix.lane }}-${LOCK}`, restoreKeys: [`${OS}-next-v2-pr-`] })),
      wf("b", oneStep({ key: `${OS}-next-v2-daily-${LOCK}`, restoreKeys: [`${OS}-next-v2-daily-`] })),
    ]),
    [],
  );
});

test("one namespace that prefixes another's is refused across workflows, allowed within one", () => {
  assert.deepEqual(
    rules([
      wf("a", oneStep({ key: `${OS}-next-v2-pr-${LOCK}`, restoreKeys: [`${OS}-next-v2-pr-`] })),
      wf("b", oneStep({ key: `${OS}-next-v2-pr-admin-${LOCK}` })),
    ]),
    ["namespace_reaches_another_workflow"],
  );
  const bothInOne = [
    "on: pull_request",
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/cache@v5",
    "        with:",
    "          path: .next/cache",
    `          key: ${OS}-next-v2-pr-${LOCK}`,
    "  b:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/cache@v5",
    "        with:",
    "          path: .next/cache",
    `          key: ${OS}-next-v2-pr-admin-${LOCK}`,
    "",
  ].join("\n");
  assert.deepEqual(rules([wf("one", bothInOne)]), []);
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
  // Both fire, and both are true: the keys are identical, which makes the
  // namespaces identical too. The namespace one is the rule that would still
  // catch it if only the hash part differed.
  assert.deepEqual(
    shared.findings.map((finding) => finding.rule).sort(),
    ["key_shared_across_workflows", "namespace_shared_across_workflows"],
  );
  assert.equal(shared.findings.find((finding) => finding.rule === "key_shared_across_workflows").detail, key);

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

test("a path with no family row is held to the same discipline", () => {
  // The cache is keyed by key alone: a step's paths are never what separated
  // its entry from anyone else's. So a path with no table row declares its own
  // family token and obeys the same namespace rules. Exempting such paths was
  // the hole both reviewers of round 9 found -- a `node_modules` step could
  // take a restore-key of `Linux-next-v2-` and reach every governed `next`
  // entry in the repository.
  assert.ok(
    rules([wf("ci", oneStep({ path: "~/.cargo/registry", key: `${OS}-rust-${LOCK}` }))]).includes(
      "key_missing_generation_and_namespace",
    ),
  );
  assert.deepEqual(
    rules([wf("ci", oneStep({ path: "~/.cargo/registry", key: `${OS}-rust-v2-workspaces-${LOCK}` }))]),
    [],
  );
  // And a restore-key on such a path may not reach past its own namespace.
  assert.ok(
    rules([
      wf("ci", oneStep({ path: "node_modules", key: `${OS}-next-v2-x-${LOCK}`, restoreKeys: [`${OS}-next-v2-`] })),
    ]).includes("restore_key_broader_than_namespace"),
  );
});

test("two workflows on one path are separated by their namespaces, not by the path", () => {
  const onPath = (name, key, restoreKeys = []) =>
    wf(name, oneStep({ path: "~/.cargo/registry", key, restoreKeys }));
  // Same namespace: one pool.
  assert.ok(
    rules([onPath("a", `${OS}-rust-v2-ws-${LOCK}`), onPath("b", `${OS}-rust-v2-ws-${LOCK}`)]).includes(
      "namespace_shared_across_workflows",
    ),
  );
  // One namespace a prefix of the other's: reachable.
  assert.ok(
    rules([
      onPath("a", `${OS}-rust-v2-ws-${LOCK}`, [`${OS}-rust-v2-ws-`]),
      onPath("b", `${OS}-rust-v2-ws-extra-${LOCK}`),
    ]).includes("namespace_reaches_another_workflow"),
  );
  // Distinct, non-prefixing namespaces on the same path: fine. The path was
  // never the thing keeping them apart.
  assert.deepEqual(
    rules([
      onPath("a", `${OS}-rust-v2-one-${LOCK}`, [`${OS}-rust-v2-one-`]),
      onPath("b", `${OS}-rust-v2-two-${LOCK}`, [`${OS}-rust-v2-two-`]),
    ]),
    [],
  );
});

test("every cache key in this repository carries a family, generation and namespace", () => {
  const dir = ".github/workflows";
  const seen = [];
  for (const name of readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry))) {
    const read = readCacheSteps(readFileSync(join(dir, name), "utf8"));
    assert.ok(read.steps, `${name} must parse`);
    for (const step of read.steps) {
      if (step.key === null) continue;
      const family = CACHE_FAMILIES.find((entry) => step.paths.includes(entry.path));
      const parsed = namespacePrefix(step.key, family ? family.family : null);
      assert.equal(parsed.problem, null, `${name} # ${step.jobId}: ${parsed.problem} for "${step.key}"`);
      seen.push(`${name}#${step.jobId}:${parsed.identity}`);
    }
  }
  // Exact, like the other counts in this file, so adding or removing a cache
  // step is a visible change rather than a number that quietly drifts. It fell
  // from 22 to 17 when the five save steps in the three mixed-trigger workflows
  // were removed: with cache-mode read their token cannot reserve an entry, so
  // each of those steps only ever spent the compression time and warned.
  assert.equal(seen.length, 17, `expected every cache step to be found, saw ${seen.length}`);
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
      // `readCacheSteps` hands back canonical keys, so the prefix is canonical too.
      const prefix = `${OS}-${family.family}-`;
      assert.ok(step.key.startsWith(prefix), `${name} # ${step.jobId}: key must start with ${prefix}`);
      const rest = step.key.slice(prefix.length);
      // `v<n>-<namespace>-` at minimum: the version lets a poisoned generation
      // be abandoned without an operator deleting entries by hand, and the
      // namespace is what keeps two workflows off one entry.
      assert.match(
        rest,
        /^v\d+-[a-z0-9-]+-\$\{\{\s*hashFiles/,
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

// A widely readable workflow that already holds a read-only cache token, so the
// key and write rules below are read on their own. `cacheMode: null` leaves the
// declaration out, which is what the cache-mode rule is about.
const scheduled = (step, { cacheMode = "read" } = {}) =>
  [
    "on:",
    "  schedule:",
    "    - cron: '0 1 * * *'",
    ...(cacheMode === null ? [] : [`cache-mode: ${cacheMode}`]),
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
  // A workflow with both a schedule and a narrow pull_request trigger, which is
  // the real shape of the three that keep a guarded save: widely readable, and
  // with a pull-request run the guard can actually be true on.
  const mixed = (condition) =>
    wf(
      "mixed",
      [
        "on:",
        "  schedule:",
        "    - cron: '0 1 * * *'",
        "  pull_request:",
        "    types: [opened, synchronize]",
        // Read-only token declared, so this test reads only the save guard.
        "cache-mode: read",
        "jobs:",
        "  j:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/cache/save@v5",
        ...(condition === null ? [] : [`        if: ${condition}`]),
        "        with:",
        "          path: .next/cache",
        `          key: ${OS}-next-v2-x-${LOCK}-a`,
        "",
      ].join("\n"),
    );
  const save = mixed;
  // Exactly ALLOWED_SAVE_CONDITIONS, because that is a closed list rather than
  // a shape this module parses. A workflow needing another form adds it there,
  // reviewed -- which is the point: an expression nobody read is not accepted
  // just because it looks like a conjunction.
  const allowed = [...ALLOWED_SAVE_CONDITIONS];
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

  // A condition that merely wraps the comparison in something else is refused:
  // `(github.event_name == 'pull_request') == false` contains no `!` and no `||`
  // and is true on a schedule. The accepted forms are a closed list rather than
  // an expression this module tries to reason about -- two attempts at reasoning
  // were both wrong, and independent review caught each.
  for (const sneaky of [
    "(github.event_name == 'pull_request') == false",
    "github.event_name == 'pull_request' == false",
    "contains('pull_request', github.event_name) == false",
    "github.event_name == 'pull_request' && github.event_name == 'schedule'",
  ]) {
    assert.equal(saveConditionKeepsToPullRequest(sneaky), false, sneaky);
  }
  // A wrapping `${{ }}` is formatting, not meaning.
  assert.equal(saveConditionKeepsToPullRequest("${{ github.event_name == 'pull_request' }}"), true);
});

test("a save guarded on pull_request still needs a narrow pull_request trigger", () => {
  // `types: [closed]` with an event_name guard satisfies the condition and
  // writes from a merged pull request all the same. Independent review raised
  // the combination.
  const save = (on) =>
    wf(
      "x",
      [
        ...on,
        "cache-mode: read",
        "jobs:",
        "  j:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/cache/save@v5",
        "        if: github.event_name == 'pull_request'",
        "        with:",
        "          path: .next/cache",
        `          key: ${OS}-next-v2-x-${LOCK}-a`,
        "",
      ].join("\n"),
    );
  assert.deepEqual(rules([save(["on:", "  pull_request:", "    types: [closed]"])]), [
    "unguarded_save_in_widely_readable_scope",
  ]);
  assert.deepEqual(rules([save(["on:", "  pull_request:", "    types: [opened, closed]"])]), [
    "unguarded_save_in_widely_readable_scope",
  ]);
  // No pull_request trigger at all: the guard can never be true, so a save
  // behind it is dead code at best and a hole at worst.
  assert.deepEqual(rules([save(["on:", "  schedule:", "    - cron: '0 1 * * *'"])]), [
    "unguarded_save_in_widely_readable_scope",
  ]);
  assert.deepEqual(rules([save(["on:", "  schedule:", "    - cron: '0 1 * * *'", "  pull_request:"])]), []);
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
        `          key: ${OS}-rust-v2-workspaces-${LOCK}`,
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

// --- cache-mode: the token-level rule ------------------------------------
//
// Independent review rejected the first implementation of this audit on
// exactly this point: choosing actions/cache/restore and guarding a save on
// `github.event_name` narrows the *declared* steps and leaves the job's cache
// token write-capable, so a dependency install script running on develop or
// main can call the cache API directly and plant an entry a required gate
// restores. Key namespaces are not a permission boundary. `cache-mode` is.

const minimal = (lines) => ["on:", "  schedule:", "    - cron: '0 1 * * *'", ...lines, "jobs:", "  j:", "    runs-on: ubuntu-latest", "    steps: []", ""].join("\n");

test("a widely readable workflow with no cache-mode is refused, even caching nothing", () => {
  // Caching nothing today is not a reason to leave the token write-capable: it
  // is where an added step, or a `uses:` action that caches on its own, would
  // start writing without anyone deciding to.
  assert.deepEqual(rules([wf("x", minimal([]))]), ["cache_mode_write_capable_in_widely_readable_scope"]);
});

test("only read and none satisfy the cache-mode rule", () => {
  for (const mode of ["read", "none"]) {
    assert.deepEqual(rules([wf("x", minimal([`cache-mode: ${mode}`]))]), [], mode);
  }
  for (const mode of ["write", "write-only"]) {
    assert.deepEqual(
      rules([wf("x", minimal([`cache-mode: ${mode}`]))]),
      ["cache_mode_write_capable_in_widely_readable_scope"],
      mode,
    );
  }
});

test("a value GitHub does not define is refused rather than guessed at", () => {
  // Including an expression: the documented key takes one of four literals, so
  // a `${{ }}` value is something this policy cannot evaluate and GitHub may
  // not accept. Refusing is the only answer that cannot be wrong in the
  // dangerous direction.
  for (const mode of ["Read", "readonly", "ro", "true", "${{ github.event_name == 'pull_request' && 'write' || 'read' }}"]) {
    assert.deepEqual(
      rules([wf("x", minimal([`cache-mode: ${JSON.stringify(mode)}`]))]),
      ["cache_mode_write_capable_in_widely_readable_scope"],
      mode,
    );
  }
  // A bare `cache-mode:` with no value parses as null, which is not one of the
  // four either.
  assert.deepEqual(rules([wf("x", minimal(["cache-mode:"]))]), [
    "cache_mode_write_capable_in_widely_readable_scope",
  ]);
});

test("a job may narrow the workflow's cache-mode but not widen it", () => {
  const withJob = (workflowMode, jobMode) =>
    wf(
      "x",
      [
        "on:",
        "  schedule:",
        "    - cron: '0 1 * * *'",
        `cache-mode: ${workflowMode}`,
        "jobs:",
        "  j:",
        "    runs-on: ubuntu-latest",
        `    cache-mode: ${jobMode}`,
        "    steps: []",
        "",
      ].join("\n"),
    );
  assert.deepEqual(rules([withJob("read", "none")]), []);
  assert.deepEqual(rules([withJob("read", "read")]), []);
  assert.deepEqual(rules([withJob("none", "none")]), []);
  // `read` under `none` is an override, not a narrowing: it turns restoring
  // back on. Independent review found the first version of this rule accepting
  // it, because it only asked whether the job value was non-write.
  assert.deepEqual(rules([withJob("none", "read")]), ["cache_mode_widened_by_job"]);
  // A job-level value overrides the workflow's, so this one gets its write
  // capability back however read-only the workflow looks at the top.
  for (const jobMode of ["write", "write-only"]) {
    assert.deepEqual(rules([withJob("read", jobMode)]), ["cache_mode_widened_by_job"], jobMode);
  }
});

test("a pull-request-only workflow is not asked for a cache-mode", () => {
  // Its writes land in refs/pull/<n>/merge, which no other ref restores.
  // Requiring `read` there would stop the entry its own later runs restore --
  // the warming this audit deliberately kept.
  const prOnly = (lines) =>
    wf("x", ["on:", "  pull_request:", "    types: [opened, synchronize]", ...lines, "jobs:", "  j:", "    runs-on: ubuntu-latest", "    steps: []", ""].join("\n"));
  assert.deepEqual(rules([prOnly([])]), []);
  assert.deepEqual(rules([prOnly(["cache-mode: write"])]), []);
});

test("every widely readable workflow in this repository holds a read-only cache token", () => {
  const dir = ".github/workflows";
  const missing = [];
  let checked = 0;
  for (const name of readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry))) {
    const text = readFileSync(join(dir, name), "utf8");
    const document = parseYaml(text);
    if (!reachesWidelyReadableScope(document)) continue;
    checked += 1;
    if (cacheModeFailures(document).length > 0) missing.push(name);
  }
  assert.deepEqual(missing, []);
  // Pinned so that a new workflow arriving without a declaration is a visible
  // change here and not only a red gate somebody silences. 24 until
  // 2026-10-08, when the develop push lane gained the unit tests.
  assert.equal(checked, 25);
});

test("an explicit write stops being allowed the moment a wider trigger is added", () => {
  // Why permitting `cache-mode: write` on a pull-request-only workflow is not a
  // hole. GitHub's own protection is a *default*: a low-trust trigger gets
  // `read` unless a workflow opts out by declaring a write-capable mode. So an
  // explicit `write` left behind on a workflow that later gains `issue_comment`
  // would opt out of exactly that protection. It cannot survive here, because
  // reachesWidelyReadableScope() is an allowlist: the added trigger makes the
  // workflow widely readable and the same rule then refuses the declaration.
  const withTriggers = (...triggerLines) =>
    wf("x", ["on:", ...triggerLines, "cache-mode: write", "jobs:", "  j:", "    runs-on: ubuntu-latest", "    steps: []", ""].join("\n"));
  assert.deepEqual(rules([withTriggers("  pull_request:", "    types: [opened, synchronize]")]), []);
  for (const added of ["  issue_comment:", "  pull_request_target:", "  workflow_run:", "  schedule:\n    - cron: '0 1 * * *'"]) {
    assert.deepEqual(
      rules([withTriggers("  pull_request:", "    types: [opened, synchronize]", added)]),
      ["cache_mode_write_capable_in_widely_readable_scope"],
      added,
    );
  }
});

test("the widening message is true of the failure it is printed for", () => {
  // The message-coverage test above only asks that a rule has a message of its
  // own. Independent review found this one asserting the job "gets back a
  // write-capable token" and that "only read and none may be declared" -- both
  // false of the none-under-read failure, where the job declares `read` and
  // gains only restoring. A sentence a reader acts on has to be true of the
  // case it was printed for, so this reads the real findings.
  const workflow = (workflowMode, jobMode) =>
    parseYaml(
      ["on:", "  schedule:", "    - cron: '0 1 * * *'", `cache-mode: ${workflowMode}`, "jobs:", "  j:", "    runs-on: ubuntu-latest", `    cache-mode: ${jobMode}`, "    steps: []", ""].join("\n"),
    );
  const messageFor = (workflowMode, jobMode) => {
    const found = cacheModeFailures(workflow(workflowMode, jobMode));
    assert.equal(found.length, 1, `${workflowMode}/${jobMode} should produce one finding`);
    return describeFinding({ ...found[0], workflowPath: "w.yml" });
  };

  const restoreAdded = messageFor("none", "read");
  assert.match(restoreAdded, /grants restoring/);
  // It must not tell the reader that `read` is an accepted job value, which is
  // the value being refused here.
  assert.ok(!/may be declared on a job/.test(restoreAdded), restoreAdded);
  assert.ok(!/write-capable/.test(restoreAdded), restoreAdded);

  for (const jobMode of ["write", "write-only"]) {
    assert.match(messageFor("read", jobMode), /grants saving/, jobMode);
  }
});

test("each job-mode finding names the capabilities that pair adds, and no others", () => {
  // Rounds 14 and 15 were both spent here. The first version said every job
  // override "gives back a write-capable token"; the second named the added
  // capability only in the subset branch and left a shared sentence
  // enumerating both, so the none/read failure still claimed saving was back.
  // The property is simple enough to state as one, so this computes the
  // expected words rather than listing sentences.
  const GRANTS = { none: [], read: ["restoring"], "write-only": ["saving"], write: ["restoring", "saving"] };
  const workflow = (workflowMode, jobMode) =>
    parseYaml(
      ["on:", "  schedule:", "    - cron: '0 1 * * *'", `cache-mode: ${workflowMode}`, "jobs:", "  j:", "    runs-on: ubuntu-latest", `    cache-mode: ${jobMode}`, "    steps: []", ""].join("\n"),
    );

  for (const workflowMode of ["read", "none"]) {
    for (const jobMode of ["read", "none", "write", "write-only"]) {
      const added = GRANTS[jobMode].filter((word) => !GRANTS[workflowMode].includes(word));
      const found = cacheModeFailures(workflow(workflowMode, jobMode)).filter((entry) => entry.jobId === "j");
      const where = `${workflowMode}/${jobMode}`;
      if (added.length === 0) {
        assert.deepEqual(found, [], `${where} takes capability away, so it is a narrowing`);
        continue;
      }
      assert.equal(found.length, 1, where);
      const message = describeFinding({ ...found[0], workflowPath: "w.yml" });
      for (const word of added) assert.match(message, new RegExp(word), `${where} must name ${word}`);
      // And must not name one it does not add. This is the half that was
      // missing: a sentence listing both reads as true for every case.
      for (const word of ["restoring", "saving"]) {
        if (added.includes(word)) continue;
        assert.ok(!message.includes(word), `${where} must not name ${word}: ${message}`);
      }
    }
  }

  // A value outside the four is refused for being unreadable, not for what it
  // grants, so its message claims no capability at all.
  const unreadable = cacheModeFailures(workflow("read", '"readonly"')).filter((entry) => entry.jobId === "j");
  assert.deepEqual(unreadable.map((entry) => entry.rule), ["cache_mode_unreadable_on_job"]);
  const unreadableMessage = describeFinding({ ...unreadable[0], workflowPath: "w.yml" });
  for (const word of ["restoring", "saving"]) {
    assert.ok(!unreadableMessage.includes(word), unreadableMessage);
  }
});
