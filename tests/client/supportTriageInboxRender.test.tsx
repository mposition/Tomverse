import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TraceAnalysisBlock, TriageProposal } from "@/components/admin/FeedbackInboxPanel";
import { SupportTriageHealthLine } from "@/components/admin/SupportTriageModelPanel";
import { adminFeedbackInboxMessages } from "@/lib/adminMessages/feedbackInbox";

/**
 * What the owner sees of support triage in Support › Feedback: the proposal on
 * a report and the panel's health line.
 */

const m = adminFeedbackInboxMessages.en;
const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

const idle = { worker: null, retention: null, reportsToday: 0, failedRunsToday: 0, stale: false };

test("the health line says nothing has run and raises no warning before triage is used", () => {
  const out = html(<SupportTriageHealthLine health={idle} m={m} />);
  assert.ok(out.includes(`${m.triageHealthWorker}: ${m.triageHealthNever}`));
  assert.ok(!out.includes("support-triage-health-stale"));
});

test("the health line names the last runs and today's counts, and warns when overdue", () => {
  const out = html(
    <SupportTriageHealthLine
      m={m}
      health={{
        worker: { at: "2026-11-04T01:00:00.000Z", outcome: "success" },
        retention: { at: "2026-11-04T01:00:10.000Z", outcome: "partial" },
        reportsToday: 3,
        failedRunsToday: 1,
        stale: true,
      }}
    />
  );
  assert.ok(out.includes("(success)"));
  assert.ok(out.includes("(partial)"));
  assert.ok(out.includes(`${m.triageHealthReportsToday}: 3`));
  assert.ok(out.includes(`${m.triageHealthFailedToday}: 1`));
  assert.ok(out.includes("support-triage-health-stale"));
  assert.ok(out.includes('role="alert"'));
});

test("a proposal offers its draft only when the reply can still be sent", () => {
  const triage = {
    lane: "billing_human",
    laneSource: "llm",
    replyDraft: "We are looking at your charge.",
    duplicateOf: [],
  };
  const open = html(<TriageProposal triage={triage} m={m} onUseDraft={() => undefined} />);
  assert.ok(open.includes("feedback-triage-proposal"));
  assert.ok(open.includes(m.triageLanes.billing_human));
  assert.ok(open.includes("We are looking at your charge."));
  assert.ok(open.includes("feedback-triage-use-draft"));
  const closed = html(<TriageProposal triage={triage} m={m} />);
  assert.ok(closed.includes("We are looking at your charge."));
  assert.ok(!closed.includes("feedback-triage-use-draft"));
});

test("the error analysis shows the cause and first step, then where the fix went", () => {
  const analysis = {
    status: "done" as const,
    kind: "code_fix",
    confidence: "high",
    cause: "A null model id.",
    recommendation: "Check the route.",
    handedOff: false,
    prNumber: null,
  };
  const analysed = html(<TraceAnalysisBlock analysis={analysis} m={m} />);
  assert.ok(analysed.includes(m.traceAnalysisKinds.code_fix));
  assert.ok(analysed.includes("A null model id."));
  assert.ok(analysed.includes("Check the route."));
  assert.ok(!analysed.includes(m.traceAnalysisFixRunning));
  assert.ok(!analysed.includes("feedback-trace-analysis-pr"));
  const running = html(<TraceAnalysisBlock analysis={{ ...analysis, handedOff: true }} m={m} />);
  assert.ok(running.includes(m.traceAnalysisFixRunning));
  const opened = html(<TraceAnalysisBlock analysis={{ ...analysis, handedOff: true, prNumber: 12 }} m={m} />);
  assert.match(opened, /href="https:\/\/github\.com\/mposition\/Tomverse\/pull\/12"/);
  assert.ok(!opened.includes(m.traceAnalysisFixRunning));
  assert.ok(html(<TraceAnalysisBlock analysis={{ status: "failed" }} m={m} />).includes(m.traceAnalysisFailed));
});
