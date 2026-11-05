import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { randomUUID } from "node:crypto";

import { claimAmuxIdeaLane } from "@/lib/amux/ideaLaneService";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError } from "@/lib/amux/ideaSubmissionService";
import { commitTraceReportIdea } from "@/lib/amux/ideaTraceReportSubmissionService";
import { prisma } from "@/lib/prisma";
import { SUPPORT_TRIAGE_ENABLED_SETTING_KEY, SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY } from "@/lib/supportTriageLlmSetting";
import {
  TRACE_ANALYSIS_MODE_SETTING_KEY,
  TRACE_ANALYSIS_USAGE_SETTING_KEY,
  runTraceReportAnalysisQuietly,
  submitTraceFix,
  type TraceAnalysisLlm,
} from "@/lib/traceReportAnalysis";
import {
  TRACE_ANALYSIS_MAX_ATTEMPTS,
  TRACE_ANALYSIS_PER_DAY,
  TRACE_ANALYSIS_PER_PASS,
  TRACE_FIX_HANDOFFS_PER_DAY,
  readStoredTraceAnalysis,
  traceFixRequestId,
  type TraceAnalysisFacts,
} from "@/lib/traceReportAnalysisCore";

// Verified-trace analysis (docs/policy/trace-feedback-automation.md §8a).
//
// What needs a database: the mode row, the case rows the pass reads and writes
// back, and the provider events it joins by trace.

const SECRET_WORDS = "my-private-report-words";
const OWNER = "owner-user-id";

const reset = async () => {
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-trace-" } } });
  await prisma.providerErrorEvent.deleteMany({ where: { traceId: { startsWith: "trace-analysis-" } } });
  await prisma.appSetting.deleteMany({
    where: { key: { in: [TRACE_ANALYSIS_MODE_SETTING_KEY, TRACE_ANALYSIS_USAGE_SETTING_KEY, SUPPORT_TRIAGE_ENABLED_SETTING_KEY] } },
  });
};

const setMode = (value: string) =>
  prisma.appSetting.createMany({
    data: [
      { key: TRACE_ANALYSIS_MODE_SETTING_KEY, value },
      { key: SUPPORT_TRIAGE_ENABLED_SETTING_KEY, value: "true" },
    ],
  });

const report = async (suffix: string, classification = "application_candidate") => {
  await prisma.feedback.create({
    data: { id: `fb-trace-${suffix}`, type: "bug", message: SECRET_WORDS, path: `/${SECRET_WORDS}` },
  });
  return prisma.feedbackAutoFixCase.create({
    data: {
      id: `case-trace-${suffix}`,
      feedbackId: `fb-trace-${suffix}`,
      traceId: `trace-analysis-${suffix}`,
      occurrenceId: `occurrence-${suffix}`,
      fingerprint: "AI_REQUEST_FAILED|release-1",
      sourceRelease: "release-1",
      state: "ineligible",
      classification,
      // With no evidence row, errorCode is the client's own text.
      diagnosticSummary: { traceId: `trace-analysis-${suffix}`, occurrenceId: `occurrence-${suffix}`, routeClass: "chat", httpStatus: 500, errorCode: SECRET_WORDS },
    },
  });
};

const stored = async (id: string) =>
  readStoredTraceAnalysis((await prisma.feedbackAutoFixCase.findUniqueOrThrow({ where: { id } })).diagnosticSummary);

const answer = (kind: "code_fix" | "needs_more_evidence" = "code_fix", confidence: "low" | "high" = "high") =>
  ({ kind, confidence, cause: "A null model id.", recommendation: "Check the route.", modelId: "model-a" });

const recordingLlm = (result = answer()) => {
  const calls: TraceAnalysisFacts[] = [];
  const llm: TraceAnalysisLlm = async (facts) => {
    calls.push(facts);
    return result;
  };
  return { calls, llm };
};

const recordingSubmit = () => {
  const ideas: { ownerUserId: string; caseId: string; requestId: string; idea: string }[] = [];
  return {
    ideas,
    submit: async (input: { ownerUserId: string; caseId: string; requestId: string; idea: string }) => {
      ideas.push(input);
      return { ideaId: `idea-${ideas.length}` };
    },
  };
};

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("off by default: no setting means no call and nothing written", async () => {
  await report("off");
  const { calls, llm } = recordingLlm();
  assert.equal((await runTraceReportAnalysisQuietly({ llm })).mode, "off");
  assert.equal(calls.length, 0);
  assert.equal(await stored("case-trace-off"), null);
});

test("analyze: the model gets recorded facts only, and its answer is stored once", async () => {
  await setMode("analyze");
  const row = await report("facts");
  await prisma.providerErrorEvent.create({
    data: { provider: "openai", phase: "stream", diagnosticCode: "X", traceId: row.traceId, message: SECRET_WORDS },
  });
  const { calls, llm } = recordingLlm();
  const { ideas, submit } = recordingSubmit();
  const pass = await runTraceReportAnalysisQuietly({ llm, submit });
  assert.deepEqual(pass, { mode: "analyze", analyzed: 1, failed: 0, handedOff: 0 });
  const sent = JSON.stringify(calls[0]);
  assert.ok(sent.includes("AI_REQUEST_FAILED"));
  assert.ok(sent.includes('"diagnosticCode":"X"'));
  for (const hidden of [SECRET_WORDS, row.traceId, "occurrence-facts"]) assert.ok(!sent.includes(hidden), hidden);
  const analysis = await stored(row.id);
  assert.equal(analysis?.status, "done");
  // Analyze never reaches for the lane, and a second pass does not pay again.
  assert.equal(ideas.length, 0);
  await runTraceReportAnalysisQuietly({ llm, submit });
  assert.equal(calls.length, 1);
});

test("a failed call is counted and stops at the attempt limit", async () => {
  await setMode("analyze");
  const row = await report("fail");
  let calls = 0;
  const llm: TraceAnalysisLlm = async () => {
    calls += 1;
    return null;
  };
  // Each tick is past the claim the one before took.
  for (let i = 0; i < TRACE_ANALYSIS_MAX_ATTEMPTS + 2; i += 1) {
    await runTraceReportAnalysisQuietly({ llm, now: new Date(Date.now() + i * 3 * 60_000) });
  }
  assert.equal(calls, TRACE_ANALYSIS_MAX_ATTEMPTS);
  const analysis = await stored(row.id);
  assert.equal(analysis?.status === "failed" && analysis.attempts, TRACE_ANALYSIS_MAX_ATTEMPTS);
});

test("a process that dies after the call still used its attempt", async () => {
  await setMode("analyze");
  const row = await report("died");
  let calls = 0;
  const llm: TraceAnalysisLlm = async () => {
    calls += 1;
    throw new Error("process died");
  };
  for (let i = 0; i < TRACE_ANALYSIS_MAX_ATTEMPTS + 2; i += 1) {
    await runTraceReportAnalysisQuietly({ llm, now: new Date(Date.now() + i * 3 * 60_000) });
  }
  assert.equal(calls, TRACE_ANALYSIS_MAX_ATTEMPTS);
  assert.equal(await stored(row.id), null);
});

test("a pass whose claim was taken does not write over the one that holds it", async () => {
  await setMode("analyze");
  const row = await report("fence");
  const slow: TraceAnalysisLlm = async () => {
    // Another pass takes the case after this claim lapsed.
    await prisma.feedbackAutoFixCase.update({
      where: { id: row.id },
      data: { diagnosticSummary: { llmAnalysisClaim: "someone-else" } },
    });
    return answer();
  };
  assert.equal((await runTraceReportAnalysisQuietly({ llm: slow })).analyzed, 1);
  assert.equal(await stored(row.id), null);
});

test("support triage's Off stops the paid calls and the handoffs", async () => {
  await setMode(`fix:${OWNER}`);
  await report("triage-off");
  await prisma.appSetting.update({ where: { key: SUPPORT_TRIAGE_ENABLED_SETTING_KEY }, data: { value: "false" } });
  const { calls, llm } = recordingLlm();
  const { ideas, submit } = recordingSubmit();
  await runTraceReportAnalysisQuietly({ llm, submit });
  assert.equal(calls.length, 0);
  assert.equal(ideas.length, 0);
});

test("failed submits piled up over days do not all land on one day", async () => {
  await setMode(`fix:${OWNER}`);
  for (let i = 0; i < TRACE_FIX_HANDOFFS_PER_DAY + 2; i += 1) await report(`pile-${i}`);
  const { llm } = recordingLlm();
  const day = 24 * 60 * 60_000;
  // Submitting is off for two days: each stops at its first refused case.
  for (const ago of [2, 1]) {
    await runTraceReportAnalysisQuietly({
      llm,
      now: new Date(Date.now() - ago * day),
      submit: async () => {
        throw new Error("submission_disabled");
      },
    });
  }
  const { ideas, submit } = recordingSubmit();
  await runTraceReportAnalysisQuietly({ llm, submit });
  await runTraceReportAnalysisQuietly({ llm, submit });
  assert.equal(ideas.length, TRACE_FIX_HANDOFFS_PER_DAY);
});

test("switching off during a pass stops the next call and any idea", async () => {
  await setMode(`fix:${OWNER}`);
  await report("stop-a");
  await report("stop-b");
  let calls = 0;
  const llm: TraceAnalysisLlm = async () => {
    calls += 1;
    await prisma.appSetting.update({ where: { key: TRACE_ANALYSIS_MODE_SETTING_KEY }, data: { value: "off" } });
    return answer();
  };
  const { ideas, submit } = recordingSubmit();
  await runTraceReportAnalysisQuietly({ llm, submit });
  assert.equal(calls, 1);
  assert.equal(ideas.length, 0);
});

test("lowering fix to analyze during a pass keeps analysing but opens no idea", async () => {
  await setMode(`fix:${OWNER}`);
  await report("lower-a");
  await report("lower-b");
  let calls = 0;
  const llm: TraceAnalysisLlm = async () => {
    calls += 1;
    await prisma.appSetting.update({ where: { key: TRACE_ANALYSIS_MODE_SETTING_KEY }, data: { value: "analyze" } });
    return answer();
  };
  const { ideas, submit } = recordingSubmit();
  await runTraceReportAnalysisQuietly({ llm, submit });
  assert.equal(calls, 2);
  assert.equal(ideas.length, 0);
});

test("fixes waiting out the daily limit do not crowd out a new report", async () => {
  await setMode(`fix:${OWNER}`);
  const waiting = { status: "done", at: new Date().toISOString(), modelId: "m", kind: "code_fix", confidence: "high", cause: "c", recommendation: "r" };
  await prisma.feedback.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({ id: `fb-trace-wait-${i}`, type: "bug", message: "x" })),
  });
  await prisma.feedbackAutoFixCase.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      feedbackId: `fb-trace-wait-${i}`,
      traceId: `trace-analysis-wait-${i}`,
      state: "ineligible",
      classification: "application_candidate",
      diagnosticSummary: { llmAnalysis: waiting },
    })),
  });
  const row = await report("after-the-queue");
  const { ideas, submit } = recordingSubmit();
  await runTraceReportAnalysisQuietly({ llm: recordingLlm().llm, submit });
  assert.equal(ideas.length, TRACE_FIX_HANDOFFS_PER_DAY);
  assert.equal((await stored(row.id))?.status, "done");
});

test("a saved model that is not enabled claims nothing and spends nothing", async () => {
  await setMode(`fix:${OWNER}`);
  const row = await report("disabled-model");
  await prisma.appSetting.upsert({
    where: { key: SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY },
    create: { key: SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY, value: "no-such-model" },
    update: { value: "no-such-model" },
  });
  try {
    const { ideas, submit } = recordingSubmit();
    assert.deepEqual(await runTraceReportAnalysisQuietly({ submit }), { mode: "fix", analyzed: 0, failed: 0, handedOff: 0 });
    assert.equal(ideas.length, 0);
    const summary = (await prisma.feedbackAutoFixCase.findUniqueOrThrow({ where: { id: row.id } })).diagnosticSummary as Record<string, unknown>;
    assert.equal(summary.llmAnalysisAttempts, undefined);
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY } });
  }
});

test("one pass takes a bounded number of reports", async () => {
  await setMode("analyze");
  for (let i = 0; i < TRACE_ANALYSIS_PER_PASS + 2; i += 1) await report(`bound-${i}`);
  const { calls, llm } = recordingLlm();
  await runTraceReportAnalysisQuietly({ llm });
  assert.equal(calls.length, TRACE_ANALYSIS_PER_PASS);
});

test("fix: a code defect becomes one idea with no trace or report text, under the saved owner", async () => {
  await setMode(`fix:${OWNER}`);
  const row = await report("fix");
  const { llm } = recordingLlm();
  const { ideas, submit } = recordingSubmit();
  assert.equal((await runTraceReportAnalysisQuietly({ llm, submit })).handedOff, 1);
  assert.equal(ideas[0].ownerUserId, OWNER);
  assert.equal(ideas[0].requestId, traceFixRequestId(row.id));
  assert.ok(ideas[0].idea.startsWith("Fix a production error: AI_REQUEST_FAILED"));
  for (const hidden of [SECRET_WORDS, row.traceId, "occurrence-fix"]) assert.ok(!ideas[0].idea.includes(hidden), hidden);
  const analysis = await stored(row.id);
  assert.equal(analysis?.status === "done" && analysis.handoff?.ideaId, "idea-1");
  await runTraceReportAnalysisQuietly({ llm, submit });
  assert.equal(ideas.length, 1);
});

test("fix: what the server ruled out, a low-confidence answer or another kind opens nothing", async () => {
  await setMode(`fix:${OWNER}`);
  await report("limit", "operational_limit");
  await report("provider", "provider_transient");
  const { ideas, submit } = recordingSubmit();
  await runTraceReportAnalysisQuietly({ llm: recordingLlm().llm, submit });
  assert.equal(ideas.length, 0);
  await report("low");
  await runTraceReportAnalysisQuietly({ llm: recordingLlm(answer("code_fix", "low")).llm, submit });
  await report("other");
  await runTraceReportAnalysisQuietly({ llm: recordingLlm(answer("needs_more_evidence")).llm, submit });
  assert.equal(ideas.length, 0);
});

test("fix: a lost answer retries with the same request id; the daily limit holds across passes", async () => {
  await setMode(`fix:${OWNER}`);
  const first = await report("retry");
  const { llm } = recordingLlm();
  const requests: string[] = [];
  await runTraceReportAnalysisQuietly({
    llm,
    submit: async ({ requestId }) => {
      requests.push(requestId);
      throw new Error("lost");
    },
  });
  const { ideas, submit } = recordingSubmit();
  await runTraceReportAnalysisQuietly({ llm, submit });
  assert.equal(ideas[0].requestId, requests[0]);
  assert.equal(ideas[0].requestId, traceFixRequestId(first.id));

  for (let i = 0; i < TRACE_FIX_HANDOFFS_PER_DAY + 1; i += 1) await report(`cap-${i}`);
  await runTraceReportAnalysisQuietly({ llm, submit });
  await runTraceReportAnalysisQuietly({ llm, submit });
  assert.equal(ideas.length, TRACE_FIX_HANDOFFS_PER_DAY);
});

test("a model turned off starts nothing, not even a fix for what was already analysed", async () => {
  await setMode("analyze");
  const row = await report("later");
  await runTraceReportAnalysisQuietly({ llm: recordingLlm().llm });
  await prisma.appSetting.update({ where: { key: TRACE_ANALYSIS_MODE_SETTING_KEY }, data: { value: `fix:${OWNER}` } });
  const { ideas, submit } = recordingSubmit();
  await runTraceReportAnalysisQuietly({ llm: null, submit });
  assert.equal(ideas.length, 0);
  await runTraceReportAnalysisQuietly({ llm: recordingLlm().llm, submit });
  assert.equal(ideas[0].requestId, traceFixRequestId(row.id));
});

test("the idea is the saved owner's: an account that stopped being an owner submits nothing", async () => {
  const email = "trace-analysis-owner@example.test";
  await prisma.user.deleteMany({ where: { email } });
  const user = await prisma.user.create({ data: { email } });
  const saved = { ...process.env };
  const code = async () =>
    submitTraceFix({ ownerUserId: user.id, caseId: "case-a", requestId: traceFixRequestId("case-a"), idea: "Fix a production error: X" }).then(
      () => "submitted",
      (error) => (error instanceof IdeaSubmissionError ? error.code : String(error))
    );
  try {
    process.env.ADMIN_EMAILS = email;
    process.env.ADMIN_OWNER_EMAILS = email;
    process.env.ADMIN_USER_IDS = "";
    // Past the owner check, as far as the submission switch this suite leaves off.
    delete process.env.TOMVERSE_AMUX_V4_IDEA_SUBMIT;
    assert.equal(await code(), "submission_disabled");
    process.env.ADMIN_OWNER_EMAILS = "someone-else@example.test";
    assert.equal(await code(), "forbidden");
    await prisma.user.delete({ where: { id: user.id } });
    assert.equal(await code(), "forbidden");
  } finally {
    process.env = saved;
    await prisma.user.deleteMany({ where: { email } });
  }
});

test("the daily limit counts every call, retries included, and holds on the next pass", async () => {
  await setMode("analyze");
  await report("spent");
  const day = new Date().toISOString().slice(0, 10);
  await prisma.appSetting.create({
    data: {
      key: TRACE_ANALYSIS_USAGE_SETTING_KEY,
      value: JSON.stringify({ day, analyses: TRACE_ANALYSIS_PER_DAY - 1, handoffs: 0 }),
    },
  });
  let calls = 0;
  const llm: TraceAnalysisLlm = async () => {
    calls += 1;
    return null;
  };
  await runTraceReportAnalysisQuietly({ llm });
  await runTraceReportAnalysisQuietly({ llm, now: new Date(Date.now() + 3 * 60_000) });
  assert.equal(calls, 1);
});

test("overlapping passes call the model once for a report", async () => {
  await setMode("analyze");
  await report("overlap");
  let calls = 0;
  const llm: TraceAnalysisLlm = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return answer();
  };
  await Promise.all([runTraceReportAnalysisQuietly({ llm }), runTraceReportAnalysisQuietly({ llm })]);
  assert.equal(calls, 1);
});

test("finished reports do not crowd out a new one", async () => {
  await setMode("analyze");
  const done = { status: "done", at: new Date().toISOString(), ...answer("needs_more_evidence") };
  await prisma.feedback.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({ id: `fb-trace-done-${i}`, type: "bug", message: "x" })),
  });
  await prisma.feedbackAutoFixCase.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      feedbackId: `fb-trace-done-${i}`,
      traceId: `trace-analysis-done-${i}`,
      state: "ineligible",
      classification: "evidence_incomplete",
      diagnosticSummary: { llmAnalysis: done },
    })),
  });
  const row = await report("new");
  await runTraceReportAnalysisQuietly({ llm: recordingLlm().llm });
  assert.equal((await stored(row.id))?.status, "done");
});

test("the idea is stored for the owner, audited as the system's, and the lane takes it", async () => {
  const ownerUserId = `trace-analysis-idea-${randomUUID()}`;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY ??= "trace-analysis-test-audit-integrity-key-0000000000";
  const keys = {
    masterKeyId: "synthetic-master",
    masterKeyVersion: 1,
    masterKey: Buffer.alloc(32, 1),
    digestKeyId: "synthetic-digest",
    digestKey: Buffer.alloc(32, 2),
  };
  const requestId = traceFixRequestId(`case-${ownerUserId}`);
  const inspected = inspectAmuxIdeaSubmission(
    JSON.stringify({ version: 1, requestId, input: { version: 1, idea: "Fix a production error: X", repositories: [], pullRequests: [] } })
  );
  assert.ok(inspected.ok);
  const ideaId = randomUUID();
  try {
    await prisma.$transaction((tx) =>
      commitTraceReportIdea(tx, { ownerUserId, caseId: "case-a", inspected, ideaId, keys: keys as never })
    );
    const idea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } });
    assert.equal(idea.actorUserId, ownerUserId);
    assert.equal(idea.submissionOrigin, "owner");
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "trace_report_analysis.idea_submitted", targetId: ideaId },
    });
    // The system's act, not the owner's: no person on the row, the owner in the metadata.
    assert.equal(audit.actorUserId, null);
    const metadata = audit.metadata as Record<string, unknown>;
    assert.equal(metadata.systemActor, "trace-report-analysis");
    assert.equal(metadata.authorizedByUserId, ownerUserId);
    // No key store here, so the claim cannot open it: it still counts as this idea's run.
    process.env.AMUX_IDEA_LANE_MAX_ATTEMPTS_PER_DAY = "100";
    await claimAmuxIdeaLane({ actorUserId: ownerUserId });
    assert.equal(await prisma.amuxIdeaLaneAttempt.count({ where: { ideaId } }), 1);
  } finally {
    await prisma.amuxIdeaSubmission.deleteMany({ where: { actorUserId: ownerUserId } });
  }
});
