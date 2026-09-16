import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Closing a report without emailing the reporter must not be a one-way door.
 *
 * The withhold checkbox exists because some closures do not deserve a second
 * email, and without it the only way to avoid one is to leave the report open.
 * But an operator who withholds and then changes their mind needs a way back:
 * nothing was sent, so nothing has been spent, and the answer the reporter
 * asked for is still owed. The way back is the same status button, which is
 * only live while the report carries no completion event.
 *
 * That makes two source rules worth pinning, both of them about a claim the
 * UI makes rather than a render detail:
 *   - "already announced" is read from the completion lifecycle event, never
 *     from the status. A closed report is not a told reporter -- that exact
 *     conflation is what let the 2026-09-15 reply go nowhere.
 *   - the button that sends it stays reachable when the event is missing.
 *
 * Coarse on purpose, like tests/feedbackReplyResendSurface.test.mjs: it asks
 * what the screen is wired to, not what it looks like.
 */

const PANEL = fileURLToPath(
  new URL("../components/admin/FeedbackInboxPanel.tsx", import.meta.url)
);
const COPY = fileURLToPath(new URL("../lib/adminMessages/feedbackInbox.ts", import.meta.url));

const panel = readFileSync(PANEL, "utf8");
const copy = readFileSync(COPY, "utf8");

test("the dialog decides 'already announced' from the completion event", () => {
  const declaration = panel.slice(
    panel.indexOf("const alreadyCompleted"),
    panel.indexOf(";", panel.indexOf("const alreadyCompleted")) + 1
  );
  assert.match(
    declaration,
    /feedback\.completionSnapshot/,
    "the completion event is the only record that the reporter was told"
  );
  assert.doesNotMatch(
    declaration,
    /isTerminalFeedbackStatus|closureOutcome/,
    "a terminal status says the report is closed, not that anyone was told"
  );
});

test("an unannounced closure can still be announced from its status button", () => {
  assert.match(
    panel,
    /const canStillAnnounce =[\s\S]*isTerminalFeedbackStatus\(status\)[\s\S]*!feedback\.completionSnapshot[\s\S]*canEmailReply\(feedback\)/,
    "the re-announce path is gated on a closure nobody was told about"
  );
  assert.match(
    panel,
    /disabled=\{busy \|\| \(feedback\.status === status && !canStillAnnounce\)\}/,
    "the current status stays clickable exactly while the announcement is owed"
  );
});

test("withholding is a per-close choice, off unless asked for", () => {
  assert.match(
    panel,
    /const \[withholdEmail, setWithholdEmail\] = useState\(false\);/,
    "the checkbox starts clear: announcing is what happens by default"
  );
  assert.match(
    panel,
    /withholdEmail \? \{ notifyReporter: false \} : \{\}/,
    "only a ticked box sends the flag, so nothing else can withhold by accident"
  );
});

test("no confirm label promises a send while the box is ticked", () => {
  // The auto-fix draft has its own pair of labels, and "send and resolve" on a
  // button that resolves without sending is the same lie the withhold feature
  // exists to prevent -- just told by the other half of the dialog.
  const label = panel.slice(
    panel.indexOf("{draft"),
    panel.indexOf("</button>", panel.indexOf("{draft"))
  );
  assert.match(
    label,
    /sendAndResolve/,
    "this test is reading the wrong block; the confirm label moved"
  );
  const sendingBranch = label.slice(0, label.indexOf("sendAndResolve"));
  assert.match(
    sendingBranch,
    /!withholdEmail/,
    "the sending label must be unreachable while the announcement is withheld"
  );
});

test("the withheld copy names the way back", () => {
  // Both locales, because an operator reads one of them and acts on it.
  for (const marker of ["same status button again", "같은 상태 버튼을 다시"]) {
    assert.ok(
      copy.includes(marker),
      `the withheld copy must point at the control that finishes the job (${marker})`
    );
  }
  assert.doesNotMatch(
    copy,
    /withheld:\s*"[^"]*이 답변 지금 보내기/,
    "the re-send button needs a completion event; a withheld close has none"
  );
});
