import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Support triage never fills in or suggests a closing outcome code (policy
 * docs/policy/support-triage.md section 2, item 5). "Reply with this draft"
 * opens the closing dialog with the draft as the reply and no outcome: the
 * operator picks one before the dialog can confirm. Coarse on purpose, like
 * tests/feedbackWithheldCloseSurface.test.mjs: it asks what the screen is
 * wired to, not what it looks like.
 */

const panel = readFileSync(
  fileURLToPath(new URL("../components/admin/FeedbackInboxPanel.tsx", import.meta.url)),
  "utf8"
);

test("the triage draft opens the closing dialog without an outcome", () => {
  const start = panel.indexOf("onUseDraft={");
  assert.ok(start > 0);
  const handler = panel.slice(start, panel.indexOf("/>", start));
  assert.match(handler, /draft: \{ userReply \}/);
  assert.doesNotMatch(handler, /outcomeCode/);
});

test("a dialog opened from a draft without an outcome cannot confirm until one is chosen", () => {
  assert.match(panel, /draft \? \(draft\.outcomeCode \?\? ""\)/);
  assert.match(panel, /disabled=\{busy \|\| !replyValid \|\| outcomeCode === ""\}/);
});
