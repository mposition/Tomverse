import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import {
  BRANCH_WITHOUT_PULL_REQUEST_REASON,
  PUBLISHER_CARD_KEY,
  READ_AFTER_WRITE_ATTEMPTS,
  decideLookup,
  expectedPublishCommit,
  publisherPrBody,
  publisherPrTitle,
  publisherReviewPrBody,
  publisherReviewPrTitle,
  runPublisherCycle,
} from "../scripts/engineering-agent-publisher-core.mjs";
import {
  PUBLISHER_TOKEN_PERMISSIONS,
  PUBLISHER_VARIABLES,
  appJwt,
  bindableDiffDigest,
  stoppableWorkspace,
  tokenPermissionsAllowed,
} from "../scripts/engineering-agent-publisher.mjs";
import {
  ENGINEERING_PUBLISHER_FEATURES,
  ENGINEERING_PUBLISHER_FEATURES_HEADER,
  prBodyCarriesMarker,
  publisherOpensReviewDrafts,
  publisherResumesPullRequests,
  shouldSendSuccessHeartbeat,
  unknownOutcomeDecisionCauseKey,
  unknownOutcomeDecisionWorkItemId,
} from "../lib/engineeringAgentCore.ts";

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

const fakeWorld = ({ work, halt = "none", diff = { digest: "d".repeat(64) }, headAfterPull, moveDuringDiff = false, lastLook = { verdict: "no_objection" }, build, pushOk = true, remoteAfterPush, createPull, pulls, branchBefore = null, commitAt = {}, refHiddenReads = 0, pullHiddenReads = 0 } = {}) => {
  const calls = [];
  const tokens = { minted: 0, revoked: 0 };
  let branch = branchBefore;
  const openPulls = [...(pulls ?? [])];
  // GitHub showing our own write late: a ref read answers 404, a list leaves the new pull request out.
  let hiddenRef = 0;
  let hiddenPull = 0;
  const pauses = [];
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
        if (hiddenRef > 0) {
          hiddenRef -= 1;
          return null;
        }
        return branch;
      },
      pullsForHead: async () => {
        if (hiddenPull > 0) {
          hiddenPull -= 1;
          return openPulls.filter((pull) => pull.number !== 42);
        }
        return [...openPulls];
      },
      pullDiffDigest: async () => {
        if (moveDuringDiff) branch = "8".repeat(40);
        return diff;
      },
      createPull: async (input) => {
        calls.push({ path: "github:createPull", input });
        const answer = createPull ?? { status: "created", number: 42 };
        if (answer.status === "created") {
          hiddenPull = pullHiddenReads;
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
      hiddenRef = refHiddenReads;
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
    pause: async (ms) => void pauses.push(ms),
  };
  return { ports, calls, tokens, pauses };
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
  assert.equal(pr.draft, false, "an ordinary item is a ready pull request");
});

test("an owner review item opens a draft pull request that says what marking it ready does", async () => {
  const world = fakeWorld({ work: writeWork({ ownerReview: true }) });
  assert.deepEqual(await runPublisherCycle(world.ports), { finishedNormally: true, halt: "none", reason: "confirmed" });
  const pr = world.calls.find((call) => call.path === "github:createPull").input;
  assert.equal(pr.draft, true);
  assert.equal(pr.title, publisherReviewPrTitle(RUN));
  assert.equal(pr.body, publisherReviewPrBody(RUN, "card_1"));
  assert.ok(prBodyCarriesMarker(pr.body, RUN), "a lookup still finds it by its marker");
  assert.match(pr.body, /Owner review \(T2\)/);
  assert.match(pr.body, /secrets/);
  // Only `true` makes a review item: a missing or odd value is the ordinary one.
  for (const ownerReview of [undefined, "true", 1]) {
    const other = fakeWorld({ work: writeWork({ ownerReview }) });
    await runPublisherCycle(other.ports);
    const opened = other.calls.find((call) => call.path === "github:createPull").input;
    assert.equal(opened.draft, false);
    assert.equal(opened.title, publisherPrTitle(RUN));
  }
});

test("the title leads with the card's code the app sends, and leaves off anything that is not one", async () => {
  assert.equal(publisherPrTitle(RUN, "AMUX-FILEREQ-005"), `AMUX-FILEREQ-005 engineering-agent: run ${RUN}`);
  assert.equal(publisherReviewPrTitle(RUN, "AMUX-MODELTIER-002"),
    `AMUX-MODELTIER-002 engineering-agent: run ${RUN} (owner review)`);
  // An older app sends no code, and a value that is not a card code (a
  // card's title, an unpadded number, lowercase) is never written to the title.
  for (const cardKey of [undefined, null, "", "Add Guest vs Free copy", "AMUX-FILEREQ-5",
    "amux-filereq-005", "AMUX-FILEREQ-005 extra", 5]) {
    assert.equal(publisherPrTitle(RUN, cardKey), `engineering-agent: run ${RUN}`, String(cardKey));
  }
  const world = fakeWorld({ work: writeWork({ ownerReview: true, cardKey: "AMUX-FILEREQ-005" }) });
  assert.deepEqual(await runPublisherCycle(world.ports), { finishedNormally: true, halt: "none", reason: "confirmed" });
  const pr = world.calls.find((call) => call.path === "github:createPull").input;
  assert.equal(pr.title, `AMUX-FILEREQ-005 engineering-agent: run ${RUN} (owner review)`);
  // The publisher's copy of the grammar is the app's display key grammar, so
  // a valid code is never dropped from a title (the core imports nothing).
  const app = readFileSync(new URL("../lib/amux/cardDisplayKeyCore.ts", import.meta.url), "utf8");
  const grammar = app.match(/export const AMUX_CARD_DISPLAY_KEY_PATTERN =\s*"([^"]+)";/)?.[1];
  assert.ok(grammar, "the app's display key grammar is found");
  assert.equal(PUBLISHER_CARD_KEY.source, grammar);
});

test("a publisher names review drafts in a header the app reads; nothing else counts as naming them", () => {
  assert.equal(publisherOpensReviewDrafts("review_draft"), true);
  assert.equal(publisherOpensReviewDrafts("other, review_draft"), true);
  for (const header of [null, "", "review_drafts", "Review_Draft", "x review_draft"]) {
    assert.equal(publisherOpensReviewDrafts(header), false);
  }
  const source = readFileSync(new URL("../scripts/engineering-agent-publisher.mjs", import.meta.url), "utf8");
  assert.match(source, /\[ENGINEERING_PUBLISHER_FEATURES_HEADER\]: ENGINEERING_PUBLISHER_FEATURES,/,
    "every call to the app names the features");
  assert.equal(publisherOpensReviewDrafts(ENGINEERING_PUBLISHER_FEATURES), true);
  assert.equal(publisherResumesPullRequests(ENGINEERING_PUBLISHER_FEATURES), true);
  for (const header of [null, "", "review_draft", "pull_request_resumes", "x pull_request_resume"]) {
    assert.equal(publisherResumesPullRequests(header), false, String(header));
  }
  assert.equal(ENGINEERING_PUBLISHER_FEATURES_HEADER, ENGINEERING_PUBLISHER_FEATURES_HEADER.toLowerCase());
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
    { pushOk: true, refHiddenReads: READ_AFTER_WRITE_ATTEMPTS },
    { createPull: { status: "unknown" } },
    { pullHiddenReads: READ_AFTER_WRITE_ATTEMPTS },
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
    Buffer.concat([Buffer.from("diff --git a/x b/x" + String.fromCharCode(10) + "+nul "), Buffer.from([0]), Buffer.from(" here")]),
    Buffer.concat([Buffer.from("diff --git a/x b/x" + String.fromCharCode(10)), Buffer.alloc(1024 * 1024, 0x61)]),
  ]) {
    assert.deepEqual(bindableDiffDigest(bad), { refused: true });
  }
});

test("a head that moves while the diff is read binds nothing", async () => {
  const world = fakeWorld({ work: writeWork(), moveDuringDiff: true });
  const round = await runPublisherCycle(world.ports);
  assert.deepEqual([round.finishedNormally, round.reason], [false, "pull_request_head_changed"]);
  assert.equal(world.calls.some((call) => call.path === "publish/result"), false, "left for the next lookup");
});

test("once stopping, the workspace refuses a push that was already on its way", async () => {
  let stopping = false;
  const pushed = [];
  const open = stoppableWorkspace(async () => ({
    build: async () => "built",
    push: async (sha) => void pushed.push(sha),
    commitObjectAt: async () => "object",
    dispose: async () => "disposed",
  }), () => stopping);
  const workspace = await open("b".repeat(40));
  // The SIGTERM lands while the last look is answering.
  stopping = true;
  assert.throws(() => workspace.push("c".repeat(40)), /stopping/);
  assert.throws(() => workspace.build({}), /stopping/);
  assert.deepEqual(pushed, []);
  assert.equal(await workspace.dispose(), "disposed", "cleaning up still works");
  await assert.rejects(open("b".repeat(40)), /stopping/);
});

test("a write GitHub shows late is read again, never written again (AMUX-FILEGEN-003)", async () => {
  // The ref read right after the push answers 404 twice, the new pull request is
  // missing from the first list: the round still confirms, with one push and one create.
  const world = fakeWorld({ work: writeWork({ ownerReview: true }), refHiddenReads: 2, pullHiddenReads: 1 });
  assert.deepEqual(await runPublisherCycle(world.ports), { finishedNormally: true, halt: "none", reason: "confirmed" });
  assert.equal(world.calls.filter((call) => call.path === "git:push").length, 1);
  assert.equal(world.calls.filter((call) => call.path === "github:createPull").length, 1);
  assert.equal(world.pauses.length, 3, "a pause before each read taken again");
  assert.equal(result(world.calls).outcome, "confirmed");

  // Never shown: left for a lookup, named apart from a branch that moved.
  const unseen = fakeWorld({ work: writeWork(), refHiddenReads: READ_AFTER_WRITE_ATTEMPTS });
  assert.equal((await runPublisherCycle(unseen.ports)).reason, "push_not_shown");
  assert.equal(unseen.calls.some((call) => call.path === "github:createPull"), false, "no pull request for a branch not seen");
  assert.equal(unseen.pauses.length, READ_AFTER_WRITE_ATTEMPTS - 1);
  // A branch at another commit is not waited for.
  const moved = fakeWorld({ work: writeWork(), remoteAfterPush: "9".repeat(40) });
  assert.equal((await runPublisherCycle(moved.ports)).reason, "branch_changed_after_push");
  assert.equal(moved.pauses.length, 0);
});

const resumeSetup = () => {
  const consumedWork = writeWork({ ownerReview: true });
  const object = expectedPublishCommit(consumedWork, DATE);
  const consumed = { commitDigest: sha256(object), expectedTreeId: TREE };
  const lookup = (overrides = {}) => ({
    mode: "lookup", workItemId: consumedWork.workItemId, runId: RUN, branch: BRANCH, fencingToken: "32",
    ownerReview: true, consumed, ...overrides,
  });
  return { object, lookup };
};

test("a lookup tells a branch at the allowed commit with no pull request apart, and opens nothing on its own", async () => {
  const { object, lookup } = resumeSetup();
  const at = fakeWorld({ work: lookup(), branchBefore: COMMIT, pulls: [], commitAt: { [COMMIT]: object } });
  await runPublisherCycle(at.ports);
  assert.deepEqual([result(at.calls).outcome, result(at.calls).reason], ["lookup_impossible", BRANCH_WITHOUT_PULL_REQUEST_REASON]);
  assert.equal(at.calls.some((call) => call.path === "github:createPull"), false, "no approval, no pull request");
  // Only `true` carries the approval.
  for (const resumePullRequest of ["true", 1, undefined]) {
    const odd = fakeWorld({ work: lookup({ resumePullRequest, cardRef: "card_1" }), branchBefore: COMMIT, pulls: [], commitAt: { [COMMIT]: object } });
    await runPublisherCycle(odd.ports);
    assert.equal(odd.calls.some((call) => call.path === "github:createPull"), false, String(resumePullRequest));
  }
  const foreign = fakeWorld({ work: lookup(), branchBefore: COMMIT, pulls: [], commitAt: { [COMMIT]: `${object}x` } });
  await runPublisherCycle(foreign.ports);
  assert.equal(result(foreign.calls).reason, "commit_not_allowed");
});

test("an approved resume opens the one pull request for the allowed commit and binds it, without a push", async () => {
  const { object, lookup } = resumeSetup();
  const world = fakeWorld({
    work: lookup({ resumePullRequest: true, cardRef: "card_1" }), branchBefore: COMMIT, pulls: [], commitAt: { [COMMIT]: object }, pullHiddenReads: 1,
  });
  assert.deepEqual(await runPublisherCycle(world.ports), { finishedNormally: true, halt: "none", reason: "lookup_found_result" });
  assert.equal(world.calls.some((call) => call.path === "git:push"), false, "nothing is pushed");
  const creates = world.calls.filter((call) => call.path === "github:createPull");
  assert.equal(creates.length, 1);
  const pr = creates[0].input;
  assert.deepEqual([pr.head, pr.draft, pr.title, pr.body], [BRANCH, true, publisherReviewPrTitle(RUN), publisherReviewPrBody(RUN, "card_1")]);
  assert.ok(prBodyCarriesMarker(pr.body, RUN), "the run's marker, so any later lookup finds it");
  const reported = result(world.calls);
  assert.equal(reported.outcome, "lookup_found_result");
  assert.deepEqual([reported.pullRequest.prNumber, reported.pullRequest.headSha, reported.pullRequest.verifiedHeadSha], [42, COMMIT, COMMIT]);
  assert.equal(reported.pullRequest.snapshot.treeId, TREE);
  assert.deepEqual(world.tokens, { minted: 1, revoked: 1 });
});

test("an approved resume refuses anything but the allowed commit, and never guesses a lost answer", async () => {
  const { object, lookup } = resumeSetup();
  const resume = lookup({ resumePullRequest: true, cardRef: "card_1" });
  const ours = { number: 42, state: "open", baseRef: "develop", baseSha: "f".repeat(40), headRef: BRANCH, headSha: COMMIT, body: publisherReviewPrBody(RUN, "card_1") };
  for (const [setup, outcome, reason] of [
    [{ commitAt: { [COMMIT]: `${object}x` } }, "lookup_impossible", "commit_not_allowed"],
    [{ commitAt: {} }, "lookup_impossible", "pull_request_count"],
    [{ commitAt: { [COMMIT]: object }, createPull: { status: "rejected" } }, "lookup_impossible", "pull_request_create_rejected"],
    [{ commitAt: { [COMMIT]: object }, pulls: [ours] }, "lookup_found_result", undefined],
    [{ commitAt: { [COMMIT]: object }, work: lookup({ resumePullRequest: true }) }, "lookup_impossible", "content_check_failed"],
  ]) {
    const world = fakeWorld({ work: resume, branchBefore: COMMIT, pulls: [], ...setup });
    await runPublisherCycle(world.ports);
    assert.deepEqual([result(world.calls).outcome, result(world.calls).reason], [outcome, reason], reason ?? outcome);
    const creates = world.calls.filter((call) => call.path === "github:createPull").length;
    assert.equal(creates, reason === "pull_request_create_rejected" ? 1 : 0, `${reason}: at most the one create`);
    assert.equal(world.calls.some((call) => call.path === "git:push"), false);
  }
  const lost = fakeWorld({ work: resume, branchBefore: COMMIT, pulls: [], commitAt: { [COMMIT]: object }, createPull: { status: "unknown" } });
  assert.deepEqual([(await runPublisherCycle(lost.ports)).reason, result(lost.calls)], ["pull_request_outcome_unknown", undefined]);
  assert.equal(lost.calls.filter((call) => call.path === "github:createPull").length, 1, "never a second create");
});

test("an unknown outcome's decision names the publish item it is about", () => {
  const id = "3614692c-f817-40d9-ab83-889384cddbf5";
  assert.equal(unknownOutcomeDecisionWorkItemId(unknownOutcomeDecisionCauseKey(id, 31n)), id);
  for (const key of ["registration:x", `unknown:${id}`, `unknown:${id}:`, "unknown::3", `unknown:${id}:x`]) {
    assert.equal(unknownOutcomeDecisionWorkItemId(key), null, key);
  }
});
