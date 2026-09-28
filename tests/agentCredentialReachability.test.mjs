import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  analyseCredentialReachability,
  credentialForbiddenPaths,
} from "../lib/agentCredentialReachability.ts";

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
  assert.equal(analyse([wf("caller", caller("./.github/workflows/callee.yml")), wf("callee", callee)]).forbidsAll, false);
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
  assert.equal(analyse([wf("caller", caller("other/repo/.github/workflows/x.yml@v1"))]).forbidsAll, true);
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
 * unresolved reachability out of public files (§16), so the pin is a hash.
 *
 * When this fails, a workflow change moved the credential posture. Run the
 * analysis, read what changed with the owner, and only then update the digest.
 */
const POSTURE_DIGEST = "ddbb7fee2d32";

test("on this repository's committed workflows the credential posture is the reviewed one", () => {
  const result = analyseCredentialReachability({
    workflows: committedWorkflows(),
    exclusions: [],
    cacheIsolationRecorded: false,
  });
  assert.equal(result.status, "analysed", JSON.stringify(result.problems ?? []));
  assert.equal(result.forbidsAll, true);
  const reasons = new Set(result.reasons.map((r) => r.reason));
  assert.ok(reasons.has("credential_job_restores_cache"));
  assert.ok([...reasons].some((reason) => reason !== "credential_job_restores_cache"));
  assert.ok(result.pathRules.length > 0);

  const summary = [
    ...result.credentialedJobs.map((job) => `job:${anonymise(job.workflowPath)}#${anonymise(job.jobId)}`),
    ...result.reasons.map(
      (r) => `reason:${anonymise(r.workflowPath)}#${r.jobId === null ? "-" : anonymise(r.jobId)}:${r.reason}`,
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
