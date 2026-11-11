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
  // A draft with a patch is never put to the Decision Maker today; the card says so.
  assert.match(adminEngineeringAgentMessages.ko.contextDmNotFiled, /patch가 있는 초안은 DM에 보내지 않습니다/);
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
