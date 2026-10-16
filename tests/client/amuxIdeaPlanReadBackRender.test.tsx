import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AmuxIdeaPlanReadBackButton,
  AmuxIdeaPlanReadBackNotice,
  type ReadBackView,
} from "@/components/admin/AmuxIdeaPlanApprovalPanel";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import {
  PLAN_SETTLED_AFTER_MS,
  decidePlanReadBack,
  planReadBackSeconds,
} from "@/lib/amux/ideaPlanReadBackCore";

// "Check what was recorded" after a plan approval whose answer was lost. The operator pressed it and saw no
// reaction: the unknown state and the processing state read almost the same and nothing showed that a read
// was running. Every answer now says something different, the read shows busy, a failed read says so, and
// nothing here posts the approval again.

const attempt = (startedAt: number) => ({ startedAt, unitIds: ["u1", "u2"] });
const read = (...states: string[]) => states.map((decisionState, index) => ({ id: `u${index + 1}`, decisionState }));
const text = (markup: string) => markup.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

test("a read-back is one of recorded, not recorded, settling, mixed or failed, and only a settled read with nothing approved frees the approval", () => {
  const started = 1_000_000;
  const at = (offset: number) => started + offset;
  const decide = (units: Array<{ id: string; decisionState: string }> | null, now: number, withAttempt = true) =>
    decidePlanReadBack({ attempt: withAttempt ? attempt(started) : null, units, now });
  const window = PLAN_SETTLED_AFTER_MS;

  // The units' states are the four the analysis result reports: proposed, approved, rejected, expired.
  assert.deepEqual(decide(read("approved", "approved"), at(5_000)), { kind: "recorded" });
  assert.deepEqual(decide(read("proposed", "proposed"), at(window + 1)), { kind: "not_recorded" });
  assert.deepEqual(decide(read("proposed", "proposed"), at(30_000)), { kind: "settling", remainingMs: window - 30_000 });
  assert.deepEqual(decide(read("proposed", "proposed"), at(window)), { kind: "not_recorded" },
    "the window is over exactly when no time is left");

  // Review finding: only `approved` is evidence of a commit. An unapproved proposal expires on its own and a
  // rejection is the owner's refusal; neither is a registered plan, and neither may announce one.
  assert.deepEqual(decide(read("expired", "expired"), at(window + 1)), { kind: "not_recorded" },
    "expired proposals after a failed approval: not recorded, never 'cards were registered'");
  assert.deepEqual(decide(read("rejected", "rejected"), at(window + 1)), { kind: "not_recorded" });
  assert.deepEqual(decide(read("expired", "expired"), at(10_000)), { kind: "settling", remainingMs: window - 10_000 },
    "and before the window they say nothing either");
  assert.deepEqual(decide(read("approved", "expired"), at(window + 60_000)), { kind: "mixed" },
    "one approved and one expired is a half-recorded plan, however late it is");
  assert.deepEqual(decide(read("approved", "proposed"), at(window + 60_000)), { kind: "mixed" });

  // Production, 2026-10-16: a unit of the attempt that is missing from the read used to be neither "decided" nor
  // "proposed", so the panel waited for all or none forever (10+ minutes) with every visible unit untouched.
  const missingOne = [{ id: "u1", decisionState: "proposed" }];
  assert.deepEqual(decide(missingOne, at(window + 600_000)), { kind: "not_recorded" },
    "one unit missing, the other untouched: the settled read releases the approval");
  assert.deepEqual(decide(missingOne, at(10_000)), { kind: "settling", remainingMs: window - 10_000 },
    "and before the window it counts down");
  assert.deepEqual(decide([], at(window + 1)), { kind: "not_recorded" },
    "nothing of the attempt in the read, nothing approved: not recorded after the window");
  assert.deepEqual(decide([{ id: "other", decisionState: "approved" }], at(5_000)),
    { kind: "settling", remainingMs: window - 5_000 }, "a unit outside the attempt says nothing about it");
  assert.deepEqual(decide([{ id: "u2", decisionState: "approved" }], at(5_000)), { kind: "mixed" },
    "an approved unit with another one missing is not a whole plan");

  assert.deepEqual(decide(null, at(5_000)), { kind: "read_failed" }, "a failed read is not an answer about the approval");
  assert.deepEqual(decide(read("proposed"), at(5_000), false), { kind: "no_attempt" });
  assert.equal(planReadBackSeconds(120_001), 121);
  assert.equal(planReadBackSeconds(1), 1, "never shows 0 while time is left");
  assert.ok(PLAN_SETTLED_AFTER_MS > 120_000 + 5_000, "the window outlasts the plan transaction and its wait");
});

for (const locale of ["ko", "en"] as const) {
  const m = adminAmuxIdeaInputMessages[locale];
  const notice = (view: ReadBackView, clock = 0) =>
    renderToStaticMarkup(createElement(AmuxIdeaPlanReadBackNotice, { m, view, clock }));
  const outcome = (kind: "recorded" | "not_recorded" | "read_failed" | "mixed"): ReadBackView =>
    ({ kind: "outcome", outcome: { kind }, settlesAt: 0 });
  const settling = (remainingMs: number): ReadBackView =>
    ({ kind: "outcome", outcome: { kind: "settling", remainingMs }, settlesAt: remainingMs });

  test(`${locale}: the busy state, the three outcomes and a failed read are each visibly different`, () => {
    assert.equal(notice({ kind: "none" }), "", "nothing is shown before the first check");
    const busy = notice({ kind: "reading" });
    assert.ok(busy.includes('role="status"') && busy.includes('data-testid="amux-plan-readback-reading"'));
    assert.equal(text(busy), m.planApprovalReading);

    const recorded = notice(outcome("recorded"));
    assert.ok(recorded.includes('data-testid="amux-plan-readback-recorded"') && recorded.includes('role="status"'));
    assert.equal(text(recorded), m.planApprovalRecorded);

    const notRecorded = notice(outcome("not_recorded"));
    assert.ok(notRecorded.includes('data-testid="amux-plan-readback-not_recorded"') && notRecorded.includes('role="alert"'));
    assert.equal(text(notRecorded), m.planApprovalNotRecorded);

    const waiting = notice(settling(95_000), 0);
    assert.ok(waiting.includes('data-testid="amux-plan-readback-settling"'));
    assert.equal(text(waiting), m.planApprovalSettling(95), "the seconds left are on screen");
    assert.equal(text(notice(settling(95_000), 40_000)), m.planApprovalSettling(55), "and they count down with the clock");
    assert.equal(text(notice(settling(95_000), 95_000)), m.planApprovalSettled, "when the wait is over it says so");

    const failed = notice(outcome("read_failed"));
    assert.ok(failed.includes('data-testid="amux-plan-readback-read_failed"') && failed.includes('role="alert"'));
    assert.equal(text(failed), m.planApprovalReadFailed);
    assert.equal(text(notice(outcome("mixed"))), m.planApprovalMixed);

    // None of them repeats another's words, nor the standing "unknown" explanation they replace.
    const sentences = [m.planApprovalReading, m.planApprovalRecorded, m.planApprovalNotRecorded, m.planApprovalSettling(95),
      m.planApprovalSettled, m.planApprovalReadFailed, m.planApprovalMixed, m.planApprovalUnknown, m.planApprovalStillProcessing];
    assert.equal(new Set(sentences).size, sentences.length);
    assert.ok(m.planApprovalNotRecorded.length > 0 && text(notRecorded).length > 0);
  });

  test(`${locale}: the check button is disabled and busy only while a read runs`, () => {
    const button = (view: ReadBackView) => renderToStaticMarkup(createElement(AmuxIdeaPlanReadBackButton, { m, view, onClick: () => {} }));
    const idle = button({ kind: "none" });
    assert.equal(idle.includes('disabled=""'), false);
    assert.ok(idle.includes('aria-busy="false"'));
    const busy = button({ kind: "reading" });
    assert.ok(busy.includes('disabled=""') && busy.includes('aria-busy="true"'));
    assert.equal(text(busy), m.planApprovalReadBack);
    assert.equal(button(outcome("read_failed")).includes('disabled=""'), false, "a failed read can be asked again");
  });
}

test("the read-back only reads: it never posts the approval again, and its outcomes drive the panel", () => {
  const source = readFileSync("components/admin/AmuxIdeaPlanApprovalPanel.tsx", "utf8");
  const start = source.indexOf("const readBack = async () => {");
  const body = source.slice(start, source.indexOf("const setMetric", start));
  assert.ok(start > 0 && body.length > 200);
  assert.equal(/method:\s*"POST"|approve\(|adminFetch\(/.test(body), false, "no request is sent from the read-back");
  assert.ok(body.includes('setReadBackView({ kind: "reading" })'), "the busy state is set before the read");
  assert.ok(body.includes("if (readBackView.kind === \"reading\") return;"), "a second press while reading does nothing");
  assert.ok(body.includes("decidePlanReadBack("));
  // The approval returns only when the attempt is released: recorded or settled-and-not-recorded.
  const release = body.slice(body.indexOf('case "recorded":'), body.indexOf('case "settling":'));
  assert.ok(release.includes("writePending(ideaId, null)") && release.includes('setState("idle")'));
  for (const kind of ["read_failed", "settling", "mixed"]) {
    const branch = body.slice(body.indexOf(`case "${kind}":`));
    assert.equal(branch.slice(0, branch.indexOf("return;")).includes("writePending(ideaId, null)"), false,
      `${kind} keeps the attempt, so the approval stays refused`);
  }
  // A recorded plan leaves no proposals, so the notice outlives the list.
  assert.ok(source.includes("if (listed.length === 0) return <>{readBackNotice}{dialog}</>;"));
  // A new approval clears the old answer.
  assert.ok(source.includes('setReadBackView({ kind: "none" });'));
});
