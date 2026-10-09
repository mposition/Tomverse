import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  analyseCredentialReachability,
  credentialForbiddenPaths,
} from "../lib/agentCredentialReachability.ts";
import { AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS } from "../lib/agentCredentialReviewedExclusions.ts";

const wf = (name, text) => ({ path: `.github/workflows/${name}.yml`, blobSha: "a".repeat(40), text });
const analyse = (workflows, overrides = {}) =>
  analyseCredentialReachability({ workflows, exclusions: [], cacheIsolationRecorded: false, ...overrides });

const READ_ONLY_PR = `
name: ci
on:
  pull_request:
    branches: [develop]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        env:
          SHA: \${{ github.sha }}
`;

test("a read-only pull request workflow forbids nothing", () => {
  const result = analyse([wf("ci", READ_ONLY_PR)]);
  assert.equal(result.status, "analysed");
  assert.equal(result.forbidsAll, false);
  assert.deepEqual(result.pathRules, []);
});

test("a hyphenated needs job name does not become an unknown expression context", () => {
  const text = READ_ONLY_PR.replace(
    "    steps:\n",
    "    needs: [static-and-unit]\n    if: ${{ needs.static-and-unit.result == 'success' }}\n    steps:\n",
  );
  const result = analyse([wf("ci", text)]);
  assert.equal(result.status, "analysed");
  assert.equal(result.forbidsAll, false);
  const unknown = text.replace("needs.static-and-unit.result", "unknownContext.value");
  assert.equal(analyse([wf("ci", unknown)]).forbidsAll, true);
});

test("every way a job gets a writable credential is caught", () => {
  const variants = {
    "a secret": `      - run: deploy\n        env:\n          TOKEN: \${{ secrets.DEPLOY_TOKEN }}\n`,
    "bracketed secrets": `      - run: x\n        env:\n          T: \${{ secrets['X'] }}\n`,
    "all secrets": `      - run: x\n        env:\n          T: \${{ toJSON(secrets) }}\n`,
    "an unknown context": `      - run: x\n        env:\n          T: \${{ someContext.value }}\n`,
  };
  for (const [label, step] of Object.entries(variants)) {
    const text = READ_ONLY_PR.replace("      - run: npm test\n        env:\n          SHA: ${{ github.sha }}\n", step);
    assert.equal(analyse([wf("ci", text)]).forbidsAll, true, label);
  }
  const permissionCases = {
    "write scope": READ_ONLY_PR.replace("  contents: read", "  contents: write"),
    "id-token": READ_ONLY_PR.replace("  contents: read", "  id-token: write"),
    "write-all": READ_ONLY_PR.replace("permissions:\n  contents: read", "permissions: write-all"),
    "omitted everywhere": READ_ONLY_PR.replace("permissions:\n  contents: read\n", ""),
    "an expression": READ_ONLY_PR.replace("  contents: read", "  contents: ${{ inputs.level }}"),
    "an environment": READ_ONLY_PR.replace("    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    environment: production"),
  };
  for (const [label, text] of Object.entries(permissionCases)) {
    assert.equal(analyse([wf("ci", text)]).forbidsAll, true, label);
  }
  assert.equal(
    analyse([wf("ci", READ_ONLY_PR.replace("${{ github.sha }}", "${{ secrets.GITHUB_TOKEN }}"))]).forbidsAll,
    false,
    "the job's own token is judged by its permissions, not as a secret",
  );
});

test("a path filter narrows the result to its paths; an ignore list forbids the rest", () => {
  const withPaths = READ_ONLY_PR.replace(
    "    branches: [develop]",
    "    branches: [develop]\n    paths:\n      - 'lib/credit*.ts'\n      - 'prisma/**'\n      - '!prisma/seed/**'",
  ).replace("  contents: read", "  contents: write");
  const result = analyse([wf("ci", withPaths)]);
  assert.equal(result.forbidsAll, false);
  assert.deepEqual(
    [...credentialForbiddenPaths(result, ["lib/creditLedger.ts", "lib/chat.ts", "prisma/schema.prisma", "prisma/seed/x.ts"])].sort(),
    ["lib/creditLedger.ts", "prisma/schema.prisma"],
  );

  const withIgnore = READ_ONLY_PR.replace(
    "    branches: [develop]",
    "    branches: [develop]\n    paths-ignore:\n      - 'docs/**'",
  ).replace("  contents: read", "  contents: write");
  const ignored = analyse([wf("ci", withIgnore)]);
  assert.deepEqual([...credentialForbiddenPaths(ignored, ["docs/a.md", "lib/a.ts"])], ["lib/a.ts"]);
});

test("`**` spans zero or more directories, as GitHub's path filters do", () => {
  const withPaths = (pattern) =>
    READ_ONLY_PR.replace("    branches: [develop]", `    branches: [develop]
    paths:
      - '${pattern}'`).replace(
      "  contents: read",
      "  contents: write",
    );
  const forbidden = (pattern, changed) => [...credentialForbiddenPaths(analyse([wf("ci", withPaths(pattern))]), changed)];
  assert.deepEqual(forbidden("**/a.ts", ["a.ts", "lib/deep/a.ts", "lib/b.ts"]), ["a.ts", "lib/deep/a.ts"]);
  assert.deepEqual(forbidden("lib/**/*.ts", ["lib/a.ts", "lib/x/y/a.ts", "app/a.ts"]), ["lib/a.ts", "lib/x/y/a.ts"]);
  assert.deepEqual(forbidden("docs/**", ["docs/a.md", "docs/x/b.md", "lib/a.ts"]), ["docs/a.md", "docs/x/b.md"]);
  // Glued to other characters, `**` is not modelled, and an unknown include forbids.
  assert.deepEqual(forbidden("**.ts", ["lib/a.ts", "docs/b.md"]), ["lib/a.ts", "docs/b.md"]);
});

test("patterns this does not model forbid rather than narrow", () => {
  const text = READ_ONLY_PR.replace(
    "    branches: [develop]",
    "    branches: [develop]\n    paths:\n      - 'lib/[ab].ts'",
  ).replace("  contents: read", "  contents: write");
  const result = analyse([wf("ci", text)]);
  assert.deepEqual([...credentialForbiddenPaths(result, ["lib/anything.ts"])], ["lib/anything.ts"]);
});

test("workflows the agent cannot set off are not reached; ones it can are, with or without paths", () => {
  const credentialed = READ_ONLY_PR.replace("  contents: read", "  contents: write");
  assert.equal(
    analyse([wf("ci", credentialed.replace("branches: [develop]", "branches: [main]"))]).forbidsAll,
    false,
    "a PR against main is not the agent's",
  );
  assert.equal(
    analyse([wf("ci", credentialed.replace("  pull_request:\n    branches: [develop]", "  workflow_dispatch: {}"))]).forbidsAll,
    false,
  );
  for (const on of [
    "  pull_request_target: {}",
    "  issue_comment: {}",
    "  delete: {}",
    "  create: {}",
    "  pull_request_review: {}",
    "  check_suite: {}",
    "  push:\n    branches: ['agent/**']",
    "  push: {}",
    "  pull_request: {}",
  ]) {
    const text = credentialed.replace("  pull_request:\n    branches: [develop]", on);
    assert.equal(analyse([wf("ci", text)]).forbidsAll, true, on);
  }
  assert.equal(
    analyse([wf("ci", credentialed.replace("  pull_request:\n    branches: [develop]", "  push:\n    branches-ignore: ['agent/**']"))]).forbidsAll,
    false,
  );
  assert.equal(
    analyse([wf("ci", credentialed.replace("  pull_request:\n    branches: [develop]", "  push:\n    tags: ['v*']"))]).forbidsAll,
    false,
    "a tags-only push filter never fires on a branch push",
  );
  assert.equal(
    analyse([
      wf("ci", credentialed.replace("  pull_request:\n    branches: [develop]", "  push:\n    tags: ['v*']\n    branches-ignore: ['release/**']")),
    ]).forbidsAll,
    true,
    "a branch filter beside tag filters still judges a branch push",
  );
});

test("workflow_run chains are followed to a fixed point", () => {
  const upstream = READ_ONLY_PR;
  const middle = `
name: middle
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;
  const tail = `
name: tail
on:
  workflow_run:
    workflows: [middle]
permissions:
  contents: write
jobs:
  y:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;
  assert.equal(analyse([wf("ci", upstream), wf("middle", middle), wf("tail", tail)]).forbidsAll, true);
  // `workflows` matches a workflow's name or its file name; a file name must chain too,
  // whether or not the upstream workflow has a name.
  const byFile = middle.replace("workflows: [ci]", "workflows: [ci.yml]");
  assert.equal(analyse([wf("ci", upstream.replace("name: ci", "name: CI")), wf("middle", byFile), wf("tail", tail)]).forbidsAll, true);
  assert.equal(analyse([wf("ci", upstream.replace(/^name: .*$/m, "")), wf("middle", byFile), wf("tail", tail)]).forbidsAll, true);
  // An unnamed workflow is shown, and matched, by its path.
  const byPath = middle.replace("workflows: [ci]", "workflows: ['.github/workflows/ci.yml']");
  assert.equal(analyse([wf("ci", upstream.replace(/^name: .*$/m, "")), wf("middle", byPath), wf("tail", tail)]).forbidsAll, true);
  // A computed upstream entry, or a reached workflow whose name is computed, chains.
  const byExpression = middle.replace("workflows: [ci]", "workflows: ['${{ vars.UPSTREAM }}']");
  assert.equal(analyse([wf("ci", upstream), wf("middle", byExpression), wf("tail", tail)]).forbidsAll, true);
  const byOtherName = middle.replace("workflows: [ci]", "workflows: [Nightly]");
  assert.equal(
    analyse([wf("ci", upstream.replace("name: ci", "name: ${{ vars.N }}")), wf("middle", byOtherName), wf("tail", tail)]).forbidsAll,
    true,
  );
  assert.equal(
    analyse([wf("ci", upstream.replace("branches: [develop]", "branches: [main]")), wf("middle", middle), wf("tail", tail)]).forbidsAll,
    false,
  );
});

test("reusable workflows: local callees are judged, remote ones and inherited secrets are credentials", () => {
  const caller = (uses, extra = "") => `
name: caller
on:
  pull_request:
    branches: [develop]
permissions:
  contents: read
jobs:
  call:
    uses: ${uses}
${extra}`;
  const callee = `
on:
  workflow_call: {}
permissions:
  contents: read
jobs:
  inner:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;
  assert.equal(
    analyse([wf("caller", caller("./.github/workflows/callee.yml")), wf("callee", callee)]).forbidsAll,
    true,
    "calling a reusable workflow is a credential in itself, even a read-only local one",
  );

  // An exclusion on the caller holds only while every local callee is pinned at its own blob.
  const pin = (path, blobSha = "a".repeat(40)) => ({
    workflowPath: `.github/workflows/${path}.yml`,
    jobId: path === "caller" ? "call" : "inner",
    blobSha,
    reason: "reviewed",
    reviewedBy: "owner",
  });
  const pair = [wf("caller", caller("./.github/workflows/callee.yml")), wf("callee", callee)];
  assert.equal(analyse(pair, { exclusions: [pin("caller")] }).forbidsAll, true, "the callee is not pinned");
  assert.equal(analyse(pair, { exclusions: [pin("caller"), pin("callee")] }).forbidsAll, false, "caller and callee both pinned");
  assert.equal(
    analyse(pair, { exclusions: [pin("caller"), pin("callee", "b".repeat(40))] }).forbidsAll,
    true,
    "a callee changed since its review voids the caller's exclusion",
  );
  assert.equal(
    analyse([wf("caller", caller("other/repo/.github/workflows/x.yml@v1"))], { exclusions: [pin("caller")] }).status,
    "failed",
    "a remote callee cannot be read, so no exclusion can cover it",
  );
  assert.equal(
    analyse([wf("caller", caller("./.github/workflows/callee.yml")), wf("callee", callee.replace("contents: read", "contents: write"))]).forbidsAll,
    true,
  );
  assert.equal(
    analyse([wf("caller", caller("./.github/workflows/callee.yml", "    secrets: inherit")), wf("callee", callee)]).forbidsAll,
    true,
  );
  assert.equal(
    analyse([wf("caller", caller("./.github/workflows/callee.yml", "    secrets:\n      token: ${{ secrets.DEPLOY }}")), wf("callee", callee)]).forbidsAll,
    true,
    "a secret handed to a read-only callee is still a credential",
  );
  // A callee that cannot be read -- remote, computed, or missing -- fails the whole analysis,
  // path filter or not: whether it restores a cache or calls further is unknown.
  assert.equal(analyse([wf("caller", caller("other/repo/.github/workflows/x.yml@v1"))]).status, "failed");
  assert.equal(analyse([wf("caller", caller("${{ vars.W }}"))]).status, "failed");
  const filtered = (uses) =>
    caller(uses).replace("    branches: [develop]", `    branches: [develop]
    paths: ['docs/**']`);
  assert.equal(analyse([wf("caller", filtered("other/repo/.github/workflows/x.yml@v1"))]).status, "failed");
  assert.equal(
    analyse([wf("caller", caller("./.github/workflows/callee.yml")), wf("callee", callee.replace("steps: [{ run: echo }]", "uses: other/repo/.github/workflows/y.yml@v1"))]).status,
    "failed",
    "a local callee that calls out is as unreadable as a remote one",
  );
  assert.equal(analyse([wf("caller", caller("./.github/workflows/missing.yml"))]).status, "failed");

  // A read-only callee that restores a cache, called with a credential: the
  // two combine into the cache rule.
  const cachingCallee = callee.replace("steps: [{ run: echo }]", "steps:\n      - uses: actions/cache@v4\n        with: { path: x, key: y }");
  const nightlyCaller = caller("./.github/workflows/callee.yml", "    secrets: inherit").replace(
    "  pull_request:\n    branches: [develop]",
    "  schedule:\n    - cron: '0 0 * * *'",
  );
  const combined = analyse([wf("caller", nightlyCaller), wf("callee", cachingCallee)]);
  assert.equal(combined.forbidsAll, true);
  assert.ok(combined.reasons.some((r) => r.reason === "credential_job_restores_cache"));
});

test("any agent branch a filter could name is reached; only a covering ignore rules it out", () => {
  const credentialed = READ_ONLY_PR.replace("  contents: read", "  contents: write");
  const withPush = (filter) => credentialed.replace("  pull_request:\n    branches: [develop]", `  push:\n${filter}`);
  for (const filter of [
    "    branches: ['agent/engineering/42']",
    "    branches: ['agent/engineering/123456789012']",
    "    branches: ['agent/engineering/4*']",
    "    branches: ['agent/**']",
    "    branches: ['**']",
    "    branches: ['*/engineering/*']",
    "    branches: ['${{ vars.BRANCH }}']",
    "    branches: ['agent/engineering/[0-9]']",
    "    branches: ['main', 'agent/engineering/*', '!agent/engineering/1']",
    "    branches-ignore: ['agent/engineering/1']",
    "    branches-ignore: ['${{ vars.IGNORE }}']",
  ]) {
    assert.equal(analyse([wf("ci", withPush(filter))]).forbidsAll, true, filter);
  }
  for (const filter of [
    "    branches: ['main', 'release/*']",
    "    branches: ['agent/review/*']",
    "    branches: ['agent/engineering/x']",
    "    branches: ['to-develop/**', '**/to-develop/**']",
    "    branches-ignore: ['agent/**']",
    "    branches-ignore: ['agent/engineering/*']",
    "    branches-ignore: ['**']",
  ]) {
    assert.equal(analyse([wf("ci", withPush(filter))]).forbidsAll, false, filter);
  }
});

test("where a job runs can be a credential the file never names", () => {
  const job = (extra, runsOn = "ubuntu-latest") =>
    READ_ONLY_PR.replace("    runs-on: ubuntu-latest", `    runs-on: ${runsOn}${extra}`);
  assert.equal(analyse([wf("ci", job(""))]).forbidsAll, false);
  for (const [label, text] of Object.entries({
    "runs-on expression": job("", "${{ vars.RUNNER }}"),
    "self-hosted": job("", "self-hosted"),
    "self-hosted list": job("", "[self-hosted, linux]"),
    "runner group": job("", "{ group: private }"),
    "container credentials": job("\n    container:\n      image: x\n      credentials:\n        username: u"),
    "container expression": job("\n    container: ${{ vars.IMAGE }}"),
    "service credentials": job("\n    services:\n      db:\n        image: x\n        credentials:\n          username: u"),
    "defaults expression": job("\n    defaults:\n      run:\n        shell: ${{ vars.SHELL }}"),
  })) {
    assert.equal(analyse([wf("ci", text)]).forbidsAll, true, label);
  }
});

test("a human exclusion never lifts the cache rule", () => {
  const nightly = `
name: nightly
on:
  schedule:
    - cron: '0 0 * * *'
permissions:
  contents: write
jobs:
  n:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        with: { path: x, key: y }
`;
  const exclusion = {
    workflowPath: ".github/workflows/nightly.yml",
    jobId: "n",
    blobSha: "a".repeat(40),
    reason: "reviewed",
    reviewedBy: "mposition",
  };
  const result = analyse([wf("nightly", nightly)], { exclusions: [exclusion] });
  assert.equal(result.forbidsAll, true);
  assert.equal(analyse([wf("nightly", nightly)], { exclusions: [exclusion], cacheIsolationRecorded: true }).forbidsAll, false);
});

test("a credentialed job that restores a cache forbids everything until isolation is recorded", () => {
  const nightly = `
name: nightly
on:
  schedule:
    - cron: '0 0 * * *'
permissions:
  contents: write
jobs:
  n:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          cache: npm
`;
  assert.equal(analyse([wf("nightly", nightly)]).forbidsAll, true);
  assert.equal(analyse([wf("nightly", nightly)], { cacheIsolationRecorded: true }).forbidsAll, false);
  assert.equal(analyse([wf("nightly", nightly.replace("contents: write", "contents: read"))]).forbidsAll, false);
});

test("an exclusion narrows only while its blob matches, and a stale one is reported void", () => {
  const credentialed = READ_ONLY_PR.replace("  contents: read", "  contents: write");
  const exclusion = {
    workflowPath: ".github/workflows/ci.yml",
    jobId: "test",
    blobSha: "a".repeat(40),
    reason: "reviewed",
    reviewedBy: "mposition",
  };
  const valid = analyse([wf("ci", credentialed)], { exclusions: [exclusion] });
  assert.equal(valid.forbidsAll, false);
  const stale = analyse([wf("ci", credentialed)], { exclusions: [{ ...exclusion, blobSha: "b".repeat(40) }] });
  assert.equal(stale.forbidsAll, true);
  assert.equal(stale.voidExclusions.length, 1);
});

test("a callee pin covers every job of every reached workflow", () => {
  const caller = `
name: caller
on:
  pull_request:
    branches: [develop]
permissions:
  contents: read
jobs:
  call:
    uses: ./.github/workflows/callee.yml
`;
  const callee = `
on:
  workflow_call: {}
permissions:
  contents: read
jobs:
  harmless:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps: [{ run: echo }]
`;
  const pin = (path, jobId) => ({ workflowPath: `.github/workflows/${path}.yml`, jobId, blobSha: "a".repeat(40), reason: "reviewed", reviewedBy: "owner" });
  const pair = [wf("caller", caller), wf("callee", callee)];
  assert.equal(
    analyse(pair, { exclusions: [pin("caller", "call"), pin("callee", "harmless")] }).forbidsAll,
    true,
    "a callee job left out of the pin runs with the call",
  );
  assert.equal(
    analyse(pair, { exclusions: [pin("caller", "call"), pin("callee", "harmless"), pin("callee", "deploy")] }).forbidsAll,
    false,
  );
});

test("a cache restore that cannot be ruled out counts as one", () => {
  const nightly = (step) => `
name: nightly
on:
  schedule:
    - cron: '0 0 * * *'
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${step}`;
  const restores = (step) =>
    analyse([wf("nightly", nightly(step))]).reasons.some((reason) => reason.reason === "credential_job_restores_cache");
  assert.equal(restores(`      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
`), true, "setup-go caches by default");
  assert.equal(restores(`      - uses: actions/setup-go@v5
`), true);
  // Which input is the off switch depends on the action, and conflating the two
  // was a finding of its own.
  //
  // On setup-node v6 `cache: false` does NOT switch caching off: the action
  // defaults `package-manager-cache` to true and caches as soon as package.json
  // names a package manager, which is the latent path the cache audit recorded
  // in its 4.2. On every other setup action `cache` is its own switch and
  // `package-manager-cache` is not an input it has.
  assert.equal(restores(`      - uses: actions/setup-node@v6
        with:
          cache: false
`), true, "setup-node: cache: false is not the off switch");
  assert.equal(restores(`      - uses: actions/setup-node@v6
        with:
          package-manager-cache: false
`), false, "setup-node: package-manager-cache: false is");
  assert.equal(restores(`      - uses: actions/setup-go@v5
        with:
          cache: false
`), false, "setup-go: its own cache input is the switch");
  assert.equal(restores(`      - uses: actions/setup-go@v5
        with:
          package-manager-cache: false
`), true, "setup-go: an input it does not have suppresses nothing");
  // An explicitly named cache is restored whatever else is set, so
  // package-manager-cache does not take it away.
  assert.equal(restores(`      - uses: actions/setup-node@v6
        with:
          cache: yarn
          package-manager-cache: false
`), true, "a named cache still restores");

  // `cache: true` names no manager and still switches caching on, which is how
  // setup-dotnet enables its NuGet cache. Read as "not named" it fell through
  // the caches-only-when-named list and the step was classified as caching
  // nothing -- a false negative on a credential gate, found by both reviewers
  // of round 9.
  assert.equal(restores(`      - uses: actions/setup-dotnet@v4
        with:
          cache: true
`), true, "boolean true turns it on");
  assert.equal(restores(`      - uses: actions/setup-dotnet@v4
        with:
          cache: 'true'
`), true, "and so does the string");
  assert.equal(restores(`      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8'
`), false, "setup-dotnet caches nothing unasked");
  // These two cache only for a named manager, so reporting them as restoring
  // without one was a false positive.
  assert.equal(restores(`      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
`), false);
  assert.equal(restores(`      - uses: actions/setup-python@v5
        with:
          cache: pip
`), true);
  assert.equal(restores(`      - uses: actions/setup-java@v4
        with:
          cache: gradle
`), true);
  assert.equal(restores(`      - uses: \${{ vars.ACTION }}
`), true, "an action named by expression");
  assert.equal(restores(`      - uses: ./.github/actions/cache
`), true, "an action kept in this repository");
  assert.equal(restores(`      - uses: Actions/Cache@v4
        with: { path: x, key: y }
`), true, "owner and repo are case-insensitive");
  assert.equal(restores(`      - run: echo
`), false);
  assert.equal(restores(`      - uses: docker://alpine
`), true, "a container step is not read");
  assert.equal(
    restores(`      - uses: docker/build-push-action@v6
        with:
          cache-from: type=gha
`),
    true,
    "an action told to read the Actions cache backend",
  );

  // The kinds. The rule itself is unchanged -- any restored cache still forbids
  // every change -- but the kind is what makes a credentialed job moving from a
  // verified package-manager cache to an unverified one a different fact rather
  // than the same reason twice. The posture digest could not see that, and
  // every credentialed cache-restoring job in this repository is in exactly the
  // state where it would have been invisible.
  const kinds = (step) => {
    const reason = analyse([wf("nightly", nightly(step))]).reasons.find(
      (candidate) => candidate.reason === "credential_job_restores_cache",
    );
    return reason === undefined ? null : reason.cacheKinds;
  };
  // Verified is a property of the package manager, not of the setup-* family.
  // Only an allowlisted (action, cache input) pair earns it; a setup step that
  // caches something this cannot name is `unverified`.
  assert.deepEqual(kinds(`      - uses: actions/setup-node@v6
        with:
          cache: npm
`), ["verified_package_manager"]);
  assert.deepEqual(kinds(`      - uses: actions/setup-node@v6
        with:
          node-version: 22
`), ["unverified"], "no cache input: what it would cache is not known here");
  assert.deepEqual(kinds(`      - uses: actions/setup-node@v6
        with:
          cache: yarn
`), ["unverified"], "not on the allowlist");
  assert.deepEqual(kinds(`      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
`), ["unverified"], "setup-go caches GOCACHE, which is build output");
  assert.equal(kinds(`      - uses: actions/setup-node@v6
        with:
          package-manager-cache: false
`), null, "the only off switch under v6");
  assert.deepEqual(kinds(`      - uses: actions/cache@v5
        with: { path: .next/cache, key: k }
`), ["unverified"]);
  assert.deepEqual(kinds(`      - uses: actions/cache/restore@v5
        with: { path: .next/cache, key: k }
`), ["unverified"]);
  assert.deepEqual(kinds(`      - uses: \${{ vars.ACTION }}
`), ["unreadable"]);
  assert.deepEqual(kinds(`      - uses: docker://alpine
`), ["unreadable"]);
  assert.equal(kinds(`      - run: echo
`), null, "no cache, no reason");
  // Both in one job: the record names both rather than collapsing to the weaker
  // one, in a fixed order so the digest is stable.
  assert.deepEqual(
    kinds(`      - uses: actions/setup-node@v6
        with:
          cache: npm
      - uses: actions/cache@v5
        with: { path: .next/cache, key: k }
`),
    ["unverified", "verified_package_manager"],
  );
  // A save step writes and does not read, so it is not a restore.
  assert.equal(
    kinds(`      - uses: actions/cache/save@v5
        with: { path: .next/cache, key: k }
`),
    null,
  );
});

test("on this repository no credentialed job restores a cache at all", () => {
  // Stronger than what the audit found by reading, and it got there in two
  // steps: P7 took the npm cache off the one job an agent-raised event could
  // reach, and the owner's §16 decision took it off the other ten. So the
  // separation this used to measure -- credentialed jobs restoring only a
  // verified cache -- is now the empty case.
  // .github/audits/actions-cache-poisoning-audit-2026-10-03.md F4, 4.3, 10.
  const result = analyse(committedWorkflows());
  assert.equal(result.status, "analysed");
  const cacheReasons = result.reasons.filter((reason) => reason.reason === "credential_job_restores_cache");
  assert.deepEqual(cacheReasons, []);
});

test("the verified-kind rule still has teeth, on a workflow built to trip it", () => {
  // The test above used to assert `cacheReasons.length > 0` so its per-reason
  // assertion could not pass vacuously. At zero that guard fires on a posture
  // that improved, so the exercise moves here rather than being deleted: an
  // unverified cache in a credentialed job must still be reported as such, and
  // a package manager's own cache must still be read as verified.
  const credentialed = READ_ONLY_PR.replace("  contents: read", "  contents: write");
  // Appended to the fixture's existing `steps:` list, which already has one
  // step -- the string ends after it, so these lines continue the sequence.
  const withStep = (step) => `${credentialed}${step.map((line) => `      ${line}`).join("\n")}\n`;

  const unverified = analyse([
    wf(
      "ci",
      withStep([
        "- uses: actions/cache/restore@v5",
        "  with:",
        "    path: .next/cache",
        "    key: ${{ runner.os }}-next-v2-x-abc",
      ]),
    ),
  ]);
  const unverifiedReasons = unverified.reasons.filter((r) => r.reason === "credential_job_restores_cache");
  assert.equal(unverifiedReasons.length, 1);
  assert.deepEqual(unverifiedReasons[0].cacheKinds, ["unverified"]);

  const verified = analyse([
    wf("ci", withStep(["- uses: actions/setup-node@v6", "  with:", "    node-version: 22", "    cache: npm"])),
  ]);
  const verifiedReasons = verified.reasons.filter((r) => r.reason === "credential_job_restores_cache");
  assert.equal(verifiedReasons.length, 1);
  assert.deepEqual(verifiedReasons[0].cacheKinds, ["verified_package_manager"]);
});

test("an ignore list's negation puts back what it ignored, and an unknown one might", () => {
  const credentialed = READ_ONLY_PR.replace("  contents: read", "  contents: write");
  const withIgnore = (patterns) =>
    credentialed.replace("    branches: [develop]", `    branches: [develop]
    paths-ignore: [${patterns}]`);
  const forbidden = (patterns, changed) => [...credentialForbiddenPaths(analyse([wf("ci", withIgnore(patterns))]), changed)];
  assert.deepEqual(forbidden("'**', '!lib/a.ts'", ["lib/a.ts", "lib/b.ts"]), ["lib/a.ts"]);
  assert.deepEqual(forbidden("'**', '!lib/[ab].ts'", ["lib/a.ts"]), ["lib/a.ts"], "an unknown negation is not trusted to keep a file ignored");
  assert.deepEqual(forbidden("'docs/**'", ["docs/a.md", "lib/a.ts"]), ["lib/a.ts"]);

  const push = (ignored) =>
    credentialed.replace(`  pull_request:
    branches: [develop]`, `  push:
    branches-ignore: [${ignored}]`);
  assert.equal(analyse([wf("ci", push("'agent/**'"))]).forbidsAll, false);
  assert.equal(analyse([wf("ci", push("'agent/**', '!agent/engineering/1'"))]).forbidsAll, true, "a negation puts an agent branch back");
  assert.equal(analyse([wf("ci", push("'agent**'"))]).forbidsAll, true, "an unmodelled pattern is not trusted to cover the agent's branches");
});

test("anything unreadable fails the whole analysis", () => {
  assert.equal(analyse([wf("bad", "on: [\n")]).status, "failed");
  assert.equal(analyse([wf("bad", "name: x\n")]).status, "failed");
  assert.equal(analyse([wf("bad", READ_ONLY_PR.replace("branches: [develop]", "branches: 7"))]).status, "failed");
  assert.equal(
    analyse([wf("bad", READ_ONLY_PR.replace("    branches: [develop]", "    branches: [develop]\n    paths: [a]\n    paths-ignore: [b]").replace("contents: read", "contents: write"))]).status,
    "failed",
  );
});

/**
 * The committed workflows, read from Git objects as the app would read them
 * from GitHub, not from the working tree.
 */
const committedWorkflows = () => {
  const root = new URL("..", import.meta.url);
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return git(["ls-tree", "-r", "HEAD", ".github/workflows"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const blobSha = meta.split(" ")[2];
      return { path, blobSha, text: git(["cat-file", "-p", blobSha]) };
    })
    .filter((file) => /\.ya?ml$/.test(file.path));
};

const anonymise = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/**
 * The verdict for every committed workflow, reduced to a digest that names
 * nothing: which (anonymised) jobs hold a credential, why anything is
 * forbidden, and which (anonymised) path rules apply. The policy keeps
 * unresolved reachability out of public files (docs/policy/engineering-agent.md §16), so the pin is a hash.
 *
 * When this fails, a workflow change moved the credential posture. Run the
 * analysis, read what changed with the owner, and only then update the digest.
 */
//
// 62ba14563ed8 (2026-09-28): .github/workflows/engineering-agent-image.yml adds
// one credentialed job -- the image build, packages: write through the job's
// own token, on push to main only. The analysis gives it no reason and no path
// rule: no event the agent raises reaches it. Flagged for the owner's review in
// the pull request that adds it.
//
// 977c24f3e564 (2026-10-03): two changes, and the posture genuinely improved.
//
// The summary now carries each cache reason's kinds, so this pin can see a
// credentialed job move from a verified package-manager cache to an unverified
// one -- the change it most needed to catch and previously could not, since the
// reason string is identical either way.
//
// And the kinds are judged by an allowlist of (setup action, cache input) pairs
// rather than by treating every `actions/setup-*` cache as verified. The
// property belongs to the package manager: `setup-go` caches GOCACHE, which is
// compiled build output with nothing checking it. Independent review caught
// that. Consequently `cache: false` is no longer read as an off switch either,
// because setup-node v6 defaults `package-manager-cache` to true and caches
// whenever package.json names a package manager.
//
// Three credentialed jobs that had no `cache:` input therefore had to say so,
// and now carry `package-manager-cache: false`. They restore nothing, so cache
// reasons fall 14 -> 11 and total reasons 17 -> 14; 22 credentialed jobs and 1
// path rule are unchanged. All 11 remaining read `verified_package_manager`,
// which `npm run check:credential-cache-separation` now holds.
// .github/audits/actions-cache-poisoning-audit-2026-10-03.md P3 and 4.2.
//
// ccf1976a16e4 (2026-10-03): one credentialed job gives up its npm cache, and
// the posture improved by exactly that one fact. Cache reasons 11 -> 10 and
// total reasons 14 -> 13; 22 credentialed jobs, 1 path rule, 8 reached
// workflows and forbidsAll are all unchanged -- the job still holds its
// credential, it just restores nothing now.
//
// It was the only credentialed cache-restoring job in a workflow an event the
// agent raises reaches, which is the condition docs/policy/engineering-agent.md
// §5's cache isolation record rests on and which nothing was keeping. Its own
// `if:` already kept it off an `agent/engineering/` head, but §5 forbids the
// analyser from reading a job condition to narrow a result, and reading a
// trigger without its condition is the mistake the audit's F5 made twice. So
// the owner's decision was to hold the condition as a fact rather than as an
// exemption. `npm run check:agent-pr-cache-isolation` now keeps it, and this
// digest is what makes the job taking a cache back visible here as well.
// .github/audits/actions-cache-poisoning-audit-2026-10-03.md P7.
// 5f27d8ac775e (2026-10-04): the remaining ten credentialed jobs give up their
// npm cache, so cache reasons go 10 -> 0 and total reasons 13 -> 3. The 22
// credentialed jobs, the 1 path rule, the 8 reached workflows and forbidsAll
// are all unchanged -- each job still holds its credential and still restores
// nothing.
//
// This is the owner's §16 decision rather than a performance change. The list
// published by this audit's own first two revisions said which credentialed
// jobs restore caches; it cannot be recalled, so it is being made stale
// instead. The cost was measured at zero before the edit: nothing can write a
// cache in those workflows' scope since `cache-mode: read`, so the restore was
// already a certain miss -- daily-security-audit run 37162314395 logged "npm
// cache is not found" and "cache write denied: token has no writable scopes"
// in one job.
// .github/audits/actions-cache-poisoning-audit-2026-10-03.md 4.3 and 10.
// 2026-10-07 owner-approved false-positive correction: a hyphenated `needs`
// expression stopped inventing a credentialed job, and the two exact
// to-develop opt-in globs stopped matching agent/engineering/<digits>.
// The unexcluded baseline is now 20 credentialed jobs, 1 reason, 1 path rule,
// 7 reached workflows, and still forbids all because of the remaining PAT job.
// The intermediate cf63... value measured only the first correction.
const POSTURE_DIGEST = "ed4f5e71fc85";

test("owner-reviewed workflow exclusion is exact-blob-only", () => {
  const workflows = committedWorkflows();
  const matched = analyseCredentialReachability({ workflows,
    exclusions: AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS,
    cacheIsolationRecorded: true });
  assert.equal(matched.status, "analysed");
  assert.equal(matched.voidExclusions.length, 0);
  assert.equal(matched.forbidsAll, false);
  const stale = analyseCredentialReachability({ workflows: workflows.map((workflow) =>
    workflow.path === AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS[0].workflowPath
      ? { ...workflow, blobSha: "b".repeat(40) } : workflow),
    exclusions: AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS,
    cacheIsolationRecorded: true });
  assert.equal(stale.status, "analysed");
  assert.equal(stale.voidExclusions.length, 1);
  assert.equal(stale.forbidsAll, true);
});

test("on this repository's committed workflows the credential posture is the reviewed one", () => {
  const result = analyseCredentialReachability({
    workflows: committedWorkflows(),
    exclusions: [],
    cacheIsolationRecorded: false,
  });
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.equal(result.forbidsAll, true);
  const reasons = new Set(result.reasons.map((r) => r.reason));
  // No longer present, and asserted as absent rather than dropped: the ten
  // credentialed jobs that asked for an npm cache gave it up (10 below), so a
  // reason of this kind reappearing means a credentialed job took a cache back.
  assert.ok(!reasons.has("credential_job_restores_cache"));
  assert.ok(reasons.size > 0, "the digest must not be computed over no reasons at all");
  assert.ok(result.pathRules.length > 0);

  const summary = [
    ...result.credentialedJobs.map((job) => `job:${anonymise(job.workflowPath)}#${anonymise(job.jobId)}`),
    // The cache kinds are part of the posture, not a detail of it. Without
    // them, adding `.next/cache` to a credentialed job that already restores
    // the npm cache produces the same reason string and leaves this digest
    // unmoved -- and every credentialed cache-restoring job in this repository
    // is in exactly that state, so the change this pin most needs to catch was
    // the one it could not see. The kinds name no workflow, so they can be
    // carried in the clear.
    ...result.reasons.map(
      (r) =>
        `reason:${anonymise(r.workflowPath)}#${r.jobId === null ? "-" : anonymise(r.jobId)}:${r.reason}` +
        (r.reason === "credential_job_restores_cache" ? `:${r.cacheKinds.join("+")}` : ""),
    ),
    ...result.pathRules.map(
      (rule) => `rule:${anonymise(rule.workflowPath)}:${rule.kind}:${anonymise(rule.patterns.join("\n"))}`,
    ),
  ].sort();
  assert.equal(
    anonymise(summary.join("\n")),
    POSTURE_DIGEST,
    "the credential posture of the committed workflows changed; review it with the owner before updating the digest",
  );
});
