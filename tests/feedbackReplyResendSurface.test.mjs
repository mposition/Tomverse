import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The re-send control must offer the text that will actually be sent.
 *
 * The email renders from the completion lifecycle event, which never changes.
 * The report row's own `userReply` is the last thing an operator typed, and
 * the two differ as soon as a report is closed a second time. A button that
 * sends one while showing the other puts words the operator never approved in
 * front of a customer, and a sent email cannot be recalled -- so this is
 * checked as a source rule rather than left to a render test that nobody
 * would think to write for the second-close case.
 *
 * Coarse on purpose (the same trade as tests/adminReauthenticationCta.test.mjs):
 * it answers one question -- which record the control is wired to.
 */

const PANEL = fileURLToPath(
  new URL("../components/admin/FeedbackInboxPanel.tsx", import.meta.url)
);
const LOADER = fileURLToPath(new URL("../lib/adminConsoleData.ts", import.meta.url));

const panel = readFileSync(PANEL, "utf8");
const loader = readFileSync(LOADER, "utf8");

/** The block that renders the re-send affordance, from its own testid. */
const resendBlock = (() => {
  const start = panel.indexOf("canEmailReply(feedback) &&");
  assert.ok(start > 0, "the re-send affordance moved; this test cannot see it");
  const end = panel.indexOf("feedback-reply-resend-preview", start);
  const closing = panel.indexOf("</span>\n                    ) : null}", start);
  assert.ok(end > 0 && closing > 0, "the re-send preview is gone");
  return panel.slice(start, closing);
})();

test("the re-send control is gated and previewed by the completion record", () => {
  assert.match(
    resendBlock,
    /feedback\.completionSnapshot\?\.userReply/,
    "the button must appear only when the completion record has a reply"
  );
  assert.match(
    resendBlock,
    /feedback-reply-resend-preview[\s\S]*feedback\.completionSnapshot\.userReply/,
    "the preview must show the completion record's reply"
  );
  assert.doesNotMatch(
    resendBlock,
    /feedback\.userReply/,
    "the row's latest reply is not what a re-send sends"
  );
});

test("the completion record reaches the console from the lifecycle event", () => {
  assert.match(loader, /stage: "completed"/);
  assert.match(loader, /completionSnapshot/);
  assert.match(
    loader,
    /feedbackLifecycleEvent\.findMany\(\{[\s\S]*feedbackId: \{ in: rows\.map/,
    "the completion records are read for exactly the rows on screen"
  );
});
