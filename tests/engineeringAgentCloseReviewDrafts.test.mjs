import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PUBLISHER_REPOSITORY,
  closeableReviewDrafts,
  decideReviewDraftClose,
  runPublisherCycle,
} from "../scripts/engineering-agent-publisher-core.mjs";
import {
  ENGINEERING_PUBLISHER_FEATURES,
  prBodyMarker,
  publisherClosesSupersededReviewDrafts,
} from "../lib/engineeringAgentCore.ts";

// Owner decision 2026-11-23, from AMUX-CRAWL-003: each retry of a T2 card
// opened one more review draft pull request and left the earlier ones open
// (seventeen in nine hours). The app names the drafts a newer pull request of
// the same card replaced, or whose card is done; the publisher reads each
// again and closes only its own open draft into develop. The DB read is in
// tests/integration/amux-dm-owner-settlement.db.test.ts.

const RUN_A = "111111111111";
const RUN_B = "222222222222";
const draftOf = (runId, prNumber) => ({ prNumber, runId, branch: `agent/engineering/${runId}` });
const pullOf = (draft, over = {}) => ({
  number: draft.prNumber, state: "open", draft: true, baseRef: "develop", headRef: draft.branch,
  headRepo: PUBLISHER_REPOSITORY, authorType: "Bot", body: `${prBodyMarker(draft.runId)}\n\nOwner review (T2).`, ...over,
});

const world = ({ claim, pulls = {}, closeOk = true, mintFails = false }) => {
  const calls = [];
  const tokens = { minted: 0, revoked: 0 };
  const ports = {
    app: async (path) => {
      calls.push(path);
      return path === "publish/claim" ? claim : { status: 404, json: null };
    },
    mintToken: async () => {
      calls.push("mint");
      if (mintFails) throw new Error("token_unavailable");
      tokens.minted += 1;
      return { token: "t", revoke: async () => void (tokens.revoked += 1) };
    },
    github: () => ({
      pullByNumber: async (number) => {
        calls.push(`read:${number}`);
        const pull = pulls[number];
        if (pull instanceof Error) throw pull;
        return pull ?? null;
      },
      closePull: async (number) => {
        calls.push(`close:${number}`);
        return closeOk;
      },
    }),
    workspace: async () => { throw new Error("no workspace for a close"); },
  };
  return { ports, calls, tokens };
};

test("the claim's list is taken only as numbers and run ids whose branch is that run's; a number twice is closed once", () => {
  const a = draftOf(RUN_A, 4208);
  assert.deepEqual(closeableReviewDrafts([a, { ...a }, draftOf(RUN_B, 4209)]), [a, draftOf(RUN_B, 4209)]);
  for (const bad of [null, "x", { prNumber: 0, runId: RUN_A, branch: a.branch }, { prNumber: 1.5, runId: RUN_A, branch: a.branch },
    { prNumber: 7, runId: "abc", branch: "agent/engineering/abc" }, { prNumber: 7, runId: RUN_A, branch: "main" },
    { prNumber: 7, runId: RUN_A, branch: `agent/engineering/${RUN_B}` }, { prNumber: "7", runId: RUN_A, branch: a.branch }]) {
    assert.deepEqual(closeableReviewDrafts([bad]), [], JSON.stringify(bad));
  }
  assert.deepEqual(closeableReviewDrafts(undefined), []);
  assert.deepEqual(closeableReviewDrafts({}), []);
});

test("only the publisher's own open draft into develop, carrying its run's marker, is closed", () => {
  const draft = draftOf(RUN_A, 4208);
  assert.equal(decideReviewDraftClose(draft, pullOf(draft)), "close");
  assert.equal(decideReviewDraftClose(draft, null), "not_found");
  assert.equal(decideReviewDraftClose(draft, pullOf(draft, { state: "closed" })), "not_open");
  assert.equal(decideReviewDraftClose(draft, pullOf(draft, { draft: false })), "not_draft",
    "a pull request a person marked ready is theirs");
  for (const over of [{ baseRef: "main" }, { headRef: `agent/engineering/${RUN_B}` }, { headRepo: "someone/Tomverse" },
    { headRepo: null }, { authorType: "User" }, { body: prBodyMarker(RUN_B) }, { body: `x\n${prBodyMarker(RUN_A)}` }]) {
    assert.equal(decideReviewDraftClose(draft, pullOf(draft, over)), "not_ours", JSON.stringify(over));
  }
});

test("after the claim's work, each named draft is read and closed once, under one token; the round's result is kept", async () => {
  const a = draftOf(RUN_A, 4208);
  const b = draftOf(RUN_B, 4209);
  const c = draftOf("333333333333", 4210);
  const { ports, calls, tokens } = world({
    claim: { status: 200, json: { work: null, halt: "none", closeReviewDrafts: [a, b, c, { junk: true }] } },
    pulls: { 4208: pullOf(a), 4209: pullOf(b, { draft: false }), 4210: new Error("github_read_failed") },
  });
  const result = await runPublisherCycle(ports);
  assert.deepEqual(result, { finishedNormally: true, halt: "none", reason: "nothing_to_publish",
    closedReviewDrafts: [{ prNumber: 4208, outcome: "closed" }, { prNumber: 4209, outcome: "not_draft" },
      { prNumber: 4210, outcome: "unreadable" }] });
  assert.deepEqual(calls, ["publish/claim", "mint", "read:4208", "close:4208", "read:4209", "read:4210"]);
  assert.deepEqual(tokens, { minted: 1, revoked: 1 });
});

test("a close whose answer is lost is not repeated; no token, nothing tried; a refused claim or no list closes nothing", async () => {
  const a = draftOf(RUN_A, 4208);
  const lost = world({ claim: { status: 200, json: { work: null, halt: "none", closeReviewDrafts: [a] } },
    pulls: { 4208: pullOf(a) }, closeOk: false });
  assert.deepEqual((await runPublisherCycle(lost.ports)).closedReviewDrafts, [{ prNumber: 4208, outcome: "close_unknown" }]);
  assert.equal(lost.calls.filter((call) => call === "close:4208").length, 1);

  const noToken = world({ claim: { status: 200, json: { work: null, halt: "none", closeReviewDrafts: [a] } }, mintFails: true });
  assert.deepEqual((await runPublisherCycle(noToken.ports)).closedReviewDrafts, [{ prNumber: 4208, outcome: "not_tried" }]);

  const refused = world({ claim: { status: 409, json: { refused: "publish_not_allowed", closeReviewDrafts: [a] } } });
  const quiet = await runPublisherCycle(refused.ports);
  assert.equal(quiet.closedReviewDrafts, undefined);
  assert.deepEqual(refused.calls, ["publish/claim"]);

  const none = world({ claim: { status: 200, json: { work: null, halt: "none" } } });
  assert.deepEqual(await runPublisherCycle(none.ports), { finishedNormally: true, halt: "none", reason: "nothing_to_publish" });
  assert.deepEqual(none.calls, ["publish/claim"], "no list: no token is minted");
});

test("the publisher names the feature; the app sends the list only to a publisher that names it", () => {
  assert.equal(publisherClosesSupersededReviewDrafts(ENGINEERING_PUBLISHER_FEATURES), true);
  for (const header of [null, "", "review_draft,pull_request_resume,patch_chunks,change_digest_v2", "close_superseded_review_draft"])
    assert.equal(publisherClosesSupersededReviewDrafts(header), false, String(header));
  const route = readFileSync("app/api/internal/engineering-agent/publish/claim/route.ts", "utf8");
  assert.match(route, /publisherClosesSupersededReviewDrafts\(features\) \?\s+await readEngineeringAgentSupersededReviewDrafts\(prisma\)\.catch\(\(\) => \[\]\) : undefined/);
  // Only the fresh answer carries it: a replay or a refusal never does.
  assert.equal(route.match(/\.\.\.\(closeReviewDrafts \? \{ closeReviewDrafts \} : \{\}\)/g)?.length, 1);
  assert.ok(route.indexOf("closeReviewDrafts } : {}") > route.indexOf("work: outcome.value"));
  assert.ok(route.indexOf("const closeReviewDrafts") > route.indexOf('outcome.kind === "replay"'));
});

test("the read names only open, current, unobserved review drafts a newer run replaced or whose card is done, while publishing is on", () => {
  const store = readFileSync("lib/engineeringAgentStore.ts", "utf8");
  const read = store.slice(store.indexOf("export async function readEngineeringAgentSupersededReviewDrafts"),
    store.indexOf("/** `open -> closed` when the pull request closes"));
  assert.match(read, /if \(!engineeringAgentV22ReviewPrEnabled\(env\[ENGINEERING_AGENT_V22_REVIEW_PR_ENV\]\)\) return \[\];/);
  assert.match(read, /if \(!switches\.publishAllowed \|\| engineeringAgentHalted\(await readEngineeringAgentHaltState\(db\)\)\) return \[\];/);
  assert.match(read, /WHERE b\."state" = 'open' AND b\."supersededAt" IS NULL\s+AND b\."approvalObservation" IS NULL AND b\."mergeObservation" IS NULL/);
  assert.match(read, /w\."kind" = 'publish' AND w\."causeKey" = \$\{ENGINEERING_AGENT_V22_REVIEW_CAUSE_PREFIX\} \|\| b\."runId"/);
  assert.match(read, /nr\."cardId" = r\."cardId" AND nr\."id" <> r\."id" AND nr\."startedAt" > r\."startedAt"/);
  assert.match(read, /card\."status" = 'done'/);
  assert.doesNotMatch(read, /UPDATE|INSERT|DELETE/, "a read only");
});

test("the publisher's one new GitHub write is closing a pull request by number", () => {
  const source = readFileSync("scripts/engineering-agent-publisher.mjs", "utf8");
  assert.match(source, /githubRequest\(token, "PATCH", `\/repos\/\$\{OWNER\}\/\$\{REPOSITORY\}\/pulls\/\$\{number\}`, \{\s+body: \{ state: "closed" \},/);
  assert.deepEqual([...source.matchAll(/githubRequest\(token, "(POST|PATCH|PUT|DELETE)"/g)].map((match) => match[1]).sort(),
    ["PATCH", "POST"], "opening a pull request and closing one");
  assert.match(source, /headRepo: value\?\.head\?\.repo\?\.full_name \?\? null/);
  assert.equal(PUBLISHER_REPOSITORY, "mposition/Tomverse");
});
