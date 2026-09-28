import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import {
  decideLookup,
  expectedPublishCommit,
  publisherPrBody,
  publisherPrTitle,
  runPublisherCycle,
} from "../scripts/engineering-agent-publisher-core.mjs";
import {
  PUBLISHER_TOKEN_PERMISSIONS,
  PUBLISHER_VARIABLES,
  appJwt,
  bindableDiffDigest,
  tokenPermissionsAllowed,
} from "../scripts/engineering-agent-publisher.mjs";
import { prBodyCarriesMarker, shouldSendSuccessHeartbeat } from "../lib/engineeringAgentCore.ts";

// The publisher service's cycle (docs/policy/engineering-agent.md §7-2,
// §8-§10) against fake ports: what it asks the app and GitHub, in what order,
// what it refuses before the first public write, and what it leaves for a
// lookup instead of guessing.

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const BASE = "b".repeat(40);
const TREE = "e".repeat(40);
const COMMIT = "c".repeat(40);
const DATE = "1759000000 +1000";
const RUN = "123456789012";
const BRANCH = `agent/engineering/${RUN}`;
const patch = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";

const writeWork = (overrides = {}) => {
  const work = {
    mode: "write",
    workItemId: "11111111-1111-4111-8111-111111111111",
    runId: RUN,
    branch: BRANCH,
    fencingToken: "7",
    cardRef: "card_1",
    baseSha: BASE,
    patchBody: patch,
    patchDigest: sha256(patch),
    expectedTreeId: TREE,
    ...overrides,
  };
  return { ...work, commitDigest: overrides.commitDigest ?? sha256(expectedPublishCommit(work, DATE)) };
};

const fakeWorld = ({ work, halt = "none", diff = { digest: "d".repeat(64) }, headAfterPull, lastLook = { verdict: "no_objection" }, build, pushOk = true, remoteAfterPush, createPull, pulls, branchBefore = null, commitAt = {} } = {}) => {
  const calls = [];
  const tokens = { minted: 0, revoked: 0 };
  let branch = branchBefore;
  const openPulls = pulls ?? [];
  const app = async (path, body) => {
    calls.push({ path, body });
    if (path === "publish/claim") return { status: 200, json: { work, halt } };
    if (path === "publish/last-look") return { status: 200, json: lastLook };
    if (path === "publish/result") return { status: 200, json: { state: "done" } };
    return { status: 404, json: null };
  };
  const github = (token) => {
    assert.equal(token, "installation-token");
    return {
      branchOid: async (name) => {
        calls.push({ path: "github:branchOid", name });
        return branch;
      },
      pullsForHead: async () => openPulls,
      pullDiffDigest: async () => diff,
      createPull: async (input) => {
        calls.push({ path: "github:createPull", input });
        const answer = createPull ?? { status: "created", number: 42 };
        if (answer.status === "created") {
          openPulls.push({ number: 42, state: "open", baseRef: "develop", baseSha: "f".repeat(40), headRef: BRANCH, headSha: headAfterPull ?? COMMIT, body: input.body });
        }
        return answer;
      },
    };
  };
  const workspace = async (baseSha) => ({
    baseCommitterDate: baseSha === null ? null : DATE,
    build: async (input) => {
      calls.push({ path: "git:build", input });
      if (build !== undefined) return build(input);
      return { treeId: TREE, commitSha: COMMIT, commitObject: expectedPublishCommit(work, DATE) };
    },
    push: async (sha, name, token) => {
      calls.push({ path: "git:push", sha, name, token });
      branch = remoteAfterPush === undefined ? sha : remoteAfterPush;
      return pushOk;
    },
    commitObjectAt: async (sha) => commitAt[sha] ?? null,
    dispose: async () => undefined,
  });
  const ports = {
    app,
    mintToken: async () => {
      calls.push({ path: "github:mint" });
      tokens.minted += 1;
      return { token: "installation-token", revoke: async () => void (tokens.revoked += 1) };
    },
    github,
    workspace,
  };
  return { ports, calls, tokens };
};

const paths = (calls) => calls.map((call) => call.path);
const result = (calls) => calls.find((call) => call.path === "publish/result")?.body;

test("a write claim is rebuilt, looked at last, pushed once to a new branch, and reported with its binding", async () => {
  const work = writeWork();
  const world = fakeWorld({ work });
  const outcome = await runPublisherCycle(world.ports);
  assert.deepEqual(outcome, { finishedNormally: true, halt: "none", reason: "confirmed" });
  assert.deepEqual(paths(world.calls), [
    "publish/claim",
    "github:mint",
    "git:build",
    "github:branchOid",
    "publish/last-look",
    "git:push",
    "github:branchOid",
    "github:createPull",
    "github:branchOid",
    "publish/result",
  ]);
  const push = world.calls.find((call) => call.path === "git:push");
  assert.deepEqual([push.sha, push.name], [COMMIT, BRANCH]);
  const look = world.calls.find((call) => call.path === "publish/last-look").body;
  assert.equal(look.commitDigest, work.commitDigest, "the last look is asked about the exact commit object");
  const pr = world.calls.find((call) => call.path === "github:createPull").input;
  assert.equal(pr.title, publisherPrTitle(RUN));
  assert.ok(prBodyCarriesMarker(pr.body, RUN), "the body's first line is the run's marker");
  assert.equal(pr.head, BRANCH);
  const reported = result(world.calls);
  assert.equal(reported.outcome, "confirmed");
  assert.deepEqual(reported.pullRequest, {
    prNumber: 42,
    headSha: COMMIT,
    verifiedHeadSha: COMMIT,
    snapshot: { baseSha: "f".repeat(40), diffDigest: "d".repeat(64), treeId: TREE, invalidatedReviewIds: [] },
  });
  assert.deepEqual(world.tokens, { minted: 1, revoked: 1 }, "the token lives for this one item");
});

test("nothing claimed mints nothing; a switch or halt refusal is a quiet round", async () => {
  const none = fakeWorld({ work: null });
  assert.deepEqual(await runPublisherCycle(none.ports), { finishedNormally: true, halt: "none", reason: "nothing_to_publish" });
  assert.equal(none.tokens.minted, 0);
  const refused = fakeWorld();
  refused.ports.app = async () => ({ status: 409, json: { refused: "maintenance_not_allowed" } });
  assert.equal((await runPublisherCycle(refused.ports)).finishedNormally, true);
  assert.equal(refused.tokens.minted, 0);
});

test("every difference before the push refuses, and nothing is pushed", async () => {
  const cases = [
    [{ work: writeWork({ commitDigest: "0".repeat(64) }) }, "revalidation_refused", "commit_digest_mismatch"],
    [{ work: writeWork({ patchDigest: "0".repeat(64) }) }, "revalidation_refused", "content_check_failed"],
    [{ work: writeWork(), build: () => null }, "revalidation_refused", "patch_does_not_apply"],
    [{ work: writeWork(), build: (input) => ({ treeId: "9".repeat(40), commitSha: COMMIT, commitObject: input.message }) }, "revalidation_refused", "tree_mismatch"],
    [{ work: writeWork(), build: () => ({ treeId: TREE, commitSha: COMMIT, commitObject: "tree x\n" }) }, "revalidation_refused", "commit_mismatch"],
    [{ work: writeWork(), branchBefore: "a".repeat(40) }, "lookup_impossible", "branch_exists"],
    [{ work: writeWork(), lastLook: { verdict: "refuse", reason: "halted" } }, "refused_before_write", "last_look_refused"],
  ];
  for (const [setup, outcome, reason] of cases) {
    const world = fakeWorld(setup);
    await runPublisherCycle(world.ports);
    const reported = result(world.calls);
    assert.equal(reported.outcome, outcome, reason);
    assert.equal(reported.reason, reason);
    assert.equal(reported.pullRequest, null);
    assert.equal(paths(world.calls).includes("git:push"), false, `${reason}: nothing is pushed`);
    assert.equal(world.tokens.revoked, world.tokens.minted);
  }
  const secret = writeWork({ patchBody: `${patch}+AKIAABCDEFGHIJKLMNOP\n` });
  const secretWorld = fakeWorld({ work: { ...secret, patchDigest: sha256(secret.patchBody) } });
  await runPublisherCycle(secretWorld.ports);
  assert.equal(result(secretWorld.calls)?.reason, "content_check_failed");
});

test("an answer the publisher does not know is left for a lookup, never guessed or retried", async () => {
  for (const setup of [
    { pushOk: false, remoteAfterPush: null },
    { pushOk: true, remoteAfterPush: "9".repeat(40) },
    { createPull: { status: "unknown" } },
  ]) {
    const world = fakeWorld({ work: writeWork(), ...setup });
    const outcome = await runPublisherCycle(world.ports);
    assert.equal(outcome.finishedNormally, false);
    assert.equal(result(world.calls), undefined, "no result is reported");
    assert.equal(world.calls.filter((call) => call.path === "git:push").length, 1, "one push, never two");
  }
  const rejected = fakeWorld({ work: writeWork(), createPull: { status: "rejected" } });
  await runPublisherCycle(rejected.ports);
  assert.equal(result(rejected.calls).outcome, "pr_create_rejected", "a 4xx is a definite answer");
});

test("a lookup reports only what it read completely, and anything unclear goes to a person", async () => {
  const consumedWork = writeWork();
  const object = expectedPublishCommit(consumedWork, DATE);
  const consumed = { commitDigest: sha256(object), expectedTreeId: TREE };
  const lookup = (overrides) => ({ mode: "lookup", workItemId: consumedWork.workItemId, runId: RUN, branch: BRANCH, fencingToken: "8", consumed, ...overrides });
  const ours = { number: 42, state: "open", baseRef: "develop", baseSha: "f".repeat(40), headRef: BRANCH, headSha: COMMIT, body: publisherPrBody(RUN, "card_1") };

  const empty = fakeWorld({ work: lookup() });
  await runPublisherCycle(empty.ports);
  assert.equal(result(empty.calls).outcome, "lookup_no_prior_write");

  const found = fakeWorld({ work: lookup(), branchBefore: COMMIT, pulls: [ours], commitAt: { [COMMIT]: object } });
  await runPublisherCycle(found.ports);
  const reported = result(found.calls);
  assert.equal(reported.outcome, "lookup_found_result");
  assert.equal(reported.pullRequest.snapshot.treeId, TREE);
  assert.equal(paths(found.calls).includes("git:push"), false, "a lookup only reads");

  for (const [overrides, reason] of [
    [{ work: lookup({ consumed: null }), branchBefore: COMMIT, pulls: [ours] }, "write_without_capability"],
    [{ work: lookup(), branchBefore: COMMIT, pulls: [] }, "pull_request_count"],
    [{ work: lookup(), branchBefore: COMMIT, pulls: [{ ...ours, body: "hello" }], commitAt: { [COMMIT]: object } }, "pull_request_not_ours"],
    [{ work: lookup(), branchBefore: COMMIT, pulls: [ours], commitAt: { [COMMIT]: `${object}x` } }, "commit_not_allowed"],
  ]) {
    const world = fakeWorld(overrides);
    await runPublisherCycle(world.ports);
    assert.deepEqual([result(world.calls).outcome, result(world.calls).reason], ["lookup_impossible", reason]);
  }
  assert.equal(decideLookup({ runId: RUN, branch: BRANCH, consumed: null, branchOid: null, pulls: [], headCommitObject: null }).outcome, "lookup_no_prior_write");
});

test("the App token carries the three permissions the policy names and never workflows", () => {
  assert.deepEqual(PUBLISHER_TOKEN_PERMISSIONS, { contents: "write", pull_requests: "write", metadata: "read" });
  assert.equal(tokenPermissionsAllowed({ contents: "write", pull_requests: "write", metadata: "read" }), true);
  assert.equal(tokenPermissionsAllowed({ contents: "write", pull_requests: "write", metadata: "read", workflows: "write" }), false);
  assert.equal(tokenPermissionsAllowed({ contents: "write", pull_requests: "write" }), false);
  assert.equal(tokenPermissionsAllowed(null), false);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = appJwt("12345", privateKey.export({ type: "pkcs8", format: "pem" }), 1_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), { iat: 999_940, exp: 1_000_540, iss: "12345" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")));
  assert.deepEqual(PUBLISHER_VARIABLES.filter((name) => /ANTHROPIC|DATABASE|AMUX|OPENAI/.test(name)), [], "no model key, no database, no AMUX secret");
});

test("the publisher imports node builtins and the dependency-free core, and nothing else", () => {
  const allowedLib = new Set(["lib/engineeringAgentCore.ts", "lib/engineeringAgentSecretPatterns.ts"]);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../"), `${file} imports ${specifier}`);
      const target = normalize(join(dirname(file), specifier)).replaceAll("\\", "/");
      assert.ok(target.startsWith("scripts/engineering-agent-") || allowedLib.has(target), `${file} reaches ${target}`);
      visit(target);
    }
  };
  visit("scripts/engineering-agent-publisher.mjs");
  assert.ok(seen.has("lib/engineeringAgentCore.ts"));
});

test("a round while anything halts is never reported as healthy, whatever it did", async () => {
  const quiet = fakeWorld({ work: null, halt: "unbound_app_ref" });
  const nothing = await runPublisherCycle(quiet.ports);
  assert.equal(nothing.halt, "unbound_app_ref");
  assert.equal(shouldSendSuccessHeartbeat(nothing), false);
  const lookup = fakeWorld({ work: { mode: "lookup", workItemId: "w", runId: RUN, branch: BRANCH, fencingToken: "1", consumed: null }, halt: "circuit_open" });
  const looked = await runPublisherCycle(lookup.ports);
  assert.equal(result(lookup.calls).outcome, "lookup_no_prior_write", "lookups continue while halted");
  assert.equal(shouldSendSuccessHeartbeat(looked), false);
  const silent = fakeWorld({ work: null, halt: undefined });
  silent.ports.app = async () => ({ status: 200, json: { work: null } });
  assert.equal((await runPublisherCycle(silent.ports)).halt, "unknown", "no halt named is not none");
});

test("a refused claim still carries the halt, and a halted quiet round is not healthy", async () => {
  const world = fakeWorld({ work: null });
  world.ports.app = async () => ({ status: 409, json: { refused: "maintenance_not_allowed", halt: "state_mismatch" } });
  const round = await runPublisherCycle(world.ports);
  assert.equal(round.finishedNormally, true);
  assert.equal(shouldSendSuccessHeartbeat(round), false, "off, but halted: no success signal");
  world.ports.app = async () => ({ status: 409, json: { refused: "maintenance_not_allowed" } });
  assert.equal((await runPublisherCycle(world.ports)).halt, "unknown");
});

test("nothing is bound unless the pull request, the branch and the pushed commit are one commit", async () => {
  const moved = fakeWorld({ work: writeWork(), headAfterPull: "9".repeat(40) });
  const round = await runPublisherCycle(moved.ports);
  assert.deepEqual([round.finishedNormally, round.reason], [false, "pull_request_head_changed"]);
  assert.equal(moved.calls.some((call) => call.path === "publish/result"), false, "left for a lookup");

  const refusedDiff = fakeWorld({ work: writeWork(), diff: { refused: true } });
  await runPublisherCycle(refusedDiff.ports);
  assert.deepEqual([result(refusedDiff.calls).outcome, result(refusedDiff.calls).reason], ["lookup_impossible", "diff_not_bindable"], "a diff no review can bind goes to a person");

  const unread = fakeWorld({ work: writeWork(), diff: null });
  assert.equal((await runPublisherCycle(unread.ports)).reason, "snapshot_unreadable");
  assert.equal(result(unread.calls), undefined);

  const ours = { number: 42, state: "open", baseRef: "develop", baseSha: "f".repeat(40), headRef: BRANCH, headSha: COMMIT, body: publisherPrBody(RUN, "card_1") };
  const object = expectedPublishCommit(writeWork(), DATE);
  assert.deepEqual(
    decideLookup({ runId: RUN, branch: BRANCH, consumed: { commitDigest: sha256(object), expectedTreeId: TREE }, branchOid: "9".repeat(40), pulls: [ours], headCommitObject: object }),
    { outcome: "lookup_impossible", reason: "branch_not_at_head" },
  );
});

test("only a diff AMUX would bind is hashed", () => {
  const good = Buffer.from("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
  assert.match(bindableDiffDigest(good).digest, /^[0-9a-f]{64}$/);
  for (const bad of [
    Buffer.from("not a diff"),
    Buffer.from("diff --git a/x b/x\nGIT binary patch\n"),
    Buffer.from("diff --git a/x b/x\n+hidden \u202e text\n"),
    Buffer.from([0x64, 0x69, 0x66, 0x66, 0xff]),
  ]) {
    assert.deepEqual(bindableDiffDigest(bad), { refused: true });
  }
});
