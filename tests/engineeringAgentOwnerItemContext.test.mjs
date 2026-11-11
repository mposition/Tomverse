// What the engineering agent's owner queue shows beside each item (operator,
// 2026-11-11: a draft card with only a reason code, run id, base and digest
// cannot be decided; it must say which card, which pull request, what changed,
// what each button does, and what the reviewers -- the Decision Maker included
// -- said).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminEngineeringAgentMessages } from "../lib/adminMessages/engineeringAgent.ts";
import {
  engineeringAgentItemPullRequest,
  engineeringAgentMismatchPublishItemId,
  engineeringAgentPatchFiles,
} from "../lib/engineeringAgentOwnerItemContextCore.ts";

test("a patch's files are listed with their added and removed line counts", () => {
  const patch = [
    "diff --git a/lib/a.ts b/lib/a.ts",
    "index 1111111..2222222 100644",
    "--- a/lib/a.ts",
    "+++ b/lib/a.ts",
    "@@ -1,3 +1,4 @@",
    " keep",
    "-old",
    "+new",
    "+added",
    "--- not a header inside a hunk",
    "diff --git a/docs/b.md b/docs/b.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/docs/b.md",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual(engineeringAgentPatchFiles(patch), [
    { path: "lib/a.ts", added: 2, removed: 2 },
    { path: "docs/b.md", added: 2, removed: 0 },
  ]);
  assert.deepEqual(engineeringAgentPatchFiles(""), []);
  assert.deepEqual(engineeringAgentPatchFiles("diff --git a/x b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n"), [
    { path: "x", added: 1, removed: 1 },
  ]);
});

test("a published-item mismatch names its publish item; other causes name none", () => {
  assert.equal(engineeringAgentMismatchPublishItemId("review_pr:abc_123"), "abc_123");
  assert.equal(engineeringAgentMismatchPublishItemId("review_pr:"), null);
  assert.equal(engineeringAgentMismatchPublishItemId("run_attempt:r1"), null);
  assert.equal(engineeringAgentMismatchPublishItemId("merged_without_approval:b1"), null);
});

test("a binding reads its GitHub observations and never guesses one", () => {
  assert.deepEqual(
    engineeringAgentItemPullRequest({
      prNumber: 3702, state: "closed", supersededAt: null,
      approvalObservation: { verdict: "approved" }, mergeObservation: { merged: true },
    }),
    { prNumber: 3702, state: "closed", current: true, approvalVerdict: "approved", merged: true },
  );
  assert.deepEqual(
    engineeringAgentItemPullRequest({
      prNumber: 1, state: "open", supersededAt: new Date(0), approvalObservation: null, mergeObservation: ["x"],
    }),
    { prNumber: 1, state: "open", current: false, approvalVerdict: null, merged: null },
  );
});

test("every reason the agent writes on an owner item is explained in both languages", () => {
  const reasons = [
    // t2_draft (lib/engineeringAgentV22TierPromotion.ts, V22StoredCandidate, V22ProductStore)
    "tier_pending", "tier_two", "tier_evidence_unavailable", "patch_unavailable",
    "publication_not_authorized", "publication_state_changed", "publish_refused",
    // state_mismatch (lib/amux/reviewPullRequest.ts refusals, adapter, observer, run sweep)
    "review_not_required", "task_not_in_review", "not_the_workers_review", "review_pr_conflict",
    "adapter_closed", "attempt_ended_run_active", "pr_file_state_mismatch", "merged_without_approval",
  ];
  for (const locale of ["en", "ko"]) {
    for (const reason of reasons) {
      assert.ok(adminEngineeringAgentMessages[locale].reasonText[reason], `${locale}: ${reason}`);
    }
  }
  // Approving a T2 draft applies nothing and opens no pull request (`docs/policy/engineering-agent.md §7`);
  // the screen must not let a person think otherwise.
  assert.match(adminEngineeringAgentMessages.ko.actionsT2[0], /PR을 열거나 코드를 적용하지 않습니다/);
  assert.match(adminEngineeringAgentMessages.en.actionsT2[0], /opens no pull request and applies nothing/);
  // A T2 draft is put to the Decision Maker for advice only behind its switch,
  // and its advice is never presented as a decision.
  assert.match(adminEngineeringAgentMessages.ko.contextDmNotFiled, /TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW/);
  assert.match(adminEngineeringAgentMessages.ko.contextDmAdviceNote, /조언일 뿐입니다/);
  assert.match(adminEngineeringAgentMessages.en.contextDmAdviceNote, /approves, rejects and applies nothing/);
});

test("the read writes nothing and shows Decision Maker bodies only to ops:write", () => {
  const read = readFileSync("lib/engineeringAgentConsoleRead.ts", "utf8");
  assert.doesNotMatch(read, /\$executeRaw|\.update\(|\.updateMany\(|\.create\(|\.upsert\(|\.delete/);
  assert.match(read, /!canReadDm\s*\?\s*\{ state: "restricted" \}/);
  assert.match(read, /readAmuxDmLocalCardState\(cardId\)/);
  const page = readFileSync("app/(site)/(application)/admin/engineering-agent/page.tsx", "utf8");
  assert.match(page, /hasAdminPermission\(session, "ops:write"\)/);
  const panel = readFileSync("components/admin/AdminEngineeringAgentPanel.tsx", "utf8");
  // The patch stays text; the context adds no new control.
  assert.match(panel, /function OwnerItemContext\(/);
  assert.doesNotMatch(panel.slice(panel.indexOf("function OwnerItemContext(")), /<button|adminFetch|dangerouslySetInnerHTML/);
});

// Operator, 2026-11-11: an owner queue card with an open T2 draft or state
// mismatch decides it on the card, with the console's own rule and buttons.
import {
  engineeringAgentCardItems,
  engineeringAgentDraftRejudgeable,
} from "../lib/engineeringAgentOwnerItemContextCore.ts";

const v22Run = (over = {}) => ({
  cardId: "card-a", modeAtStart: "t1", amuxAttemptId: "attempt-1", card: { sourceSystem: "admin-idea-v4" }, ...over,
});
const draft = (over = {}) => ({
  id: "item-1", kind: "t2_draft", state: "open", reason: "patch_unavailable", causeKey: "run:1",
  createdAt: new Date("2026-11-11T01:00:00.000Z"), patchBody: "diff --git a/lib/a.ts b/lib/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
  patchDigest: "d".repeat(64), baseSha: "b".repeat(40), run: v22Run(), ...over,
});

test("a draft may be judged again only as a kept v22 patch of a v4 idea card started in T1", () => {
  assert.equal(engineeringAgentDraftRejudgeable(draft(), v22Run()), true);
  assert.equal(engineeringAgentDraftRejudgeable(draft({ patchBody: null }), v22Run()), false);
  assert.equal(engineeringAgentDraftRejudgeable(draft({ reason: "tier_pending" }), v22Run()), false);
  assert.equal(engineeringAgentDraftRejudgeable(draft({ kind: "state_mismatch" }), v22Run()), false);
  assert.equal(engineeringAgentDraftRejudgeable(draft(), v22Run({ modeAtStart: "t2" })), false);
  assert.equal(engineeringAgentDraftRejudgeable(draft(), v22Run({ amuxAttemptId: null })), false);
  assert.equal(engineeringAgentDraftRejudgeable(draft(), v22Run({ card: { sourceSystem: "workboard" } })), false);
  assert.equal(engineeringAgentDraftRejudgeable(draft(), null), false);
});

test("the console and the owner queue card share the one rejudge rule", () => {
  const consoleRead = readFileSync("lib/engineeringAgentConsoleRead.ts", "utf8");
  assert.match(consoleRead, /rejudgeable: engineeringAgentDraftRejudgeable\(item, run\)/);
  assert.doesNotMatch(consoleRead, /sourceSystem === "admin-idea-v4"/);
  const core = readFileSync("lib/engineeringAgentOwnerItemContextCore.ts", "utf8");
  assert.match(core, /rejudgeable: engineeringAgentDraftRejudgeable\(row, row\.run\)/);
});

test("a card's open drafts and mismatches are attached to it, a review_pr mismatch through its published item", () => {
  const mismatch = {
    ...draft({ id: "item-2", kind: "state_mismatch", reason: "bound_review_pr_not_recorded",
      causeKey: "review_pr:publish-1", patchBody: null, patchDigest: null, baseSha: null, run: null }),
    createdAt: new Date("2026-11-11T02:00:00.000Z"),
  };
  const rows = [
    mismatch,
    draft(),
    draft({ id: "other-card", run: v22Run({ cardId: "card-b" }) }),
    draft({ id: "settled", state: "closed" }),
    draft({ id: "decision", kind: "decision" }),
    { ...mismatch, id: "orphan", causeKey: "review_pr:unknown" },
  ];
  const byCard = engineeringAgentCardItems(["card-a"], rows, new Map([["publish-1", v22Run()]]));
  assert.deepEqual([...byCard.keys()], ["card-a"]);
  const items = byCard.get("card-a");
  assert.deepEqual(items.map((item) => [item.id, item.kind]), [["item-1", "t2_draft"], ["item-2", "state_mismatch"]]);
  assert.equal(items[0].rejudgeable, true);
  assert.equal(items[0].createdAt, "2026-11-11T01:00:00.000Z");
  assert.deepEqual(items[0].files, [{ path: "lib/a.ts", added: 1, removed: 1 }]);
  assert.equal(items[0].fileCount, 1);
  assert.equal(items[1].rejudgeable, false);
  assert.equal(items[1].patchBody, null);
  assert.equal(engineeringAgentCardItems([], rows, new Map()).size, 0);
});

test("the card read writes nothing and the card posts only through the engineering routes", () => {
  const consoleRead = readFileSync("lib/engineeringAgentConsoleRead.ts", "utf8");
  const cardRead = consoleRead.slice(consoleRead.indexOf("export async function readEngineeringAgentCardItems("));
  assert.match(cardRead, /state: "open"/);
  assert.doesNotMatch(cardRead, /\$executeRaw|\.update\(|\.updateMany\(|\.create\(|\.upsert\(|\.delete/);
  const card = readFileSync("components/admin/AmuxOwnerQueueEngineeringItems.tsx", "utf8");
  assert.doesNotMatch(card, /adminFetch|dangerouslySetInnerHTML/);
  assert.match(card, /postEngineeringAgentAction\(request\)/);
  for (const confirm of ["confirmApprove", "confirmReject", "confirmRejudge", "confirmMismatchRecordReviewPr"]) {
    assert.match(card, new RegExp(`m\.${confirm}`));
  }
  assert.match(card, /"record_bound_review_pr"/);
  const panel = readFileSync("components/admin/AdminEngineeringAgentPanel.tsx", "utf8");
  assert.match(panel, /engineeringAgentDecisionRequest\(item, decision\)/);
  assert.match(panel, /engineeringAgentRejudgeRequest\(item\)/);
});
