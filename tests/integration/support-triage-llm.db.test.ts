import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";
import { parseTriageAnswer, type TriageLlm, type TriageLlmInput } from "@/lib/supportTriageLlm";
import { runSupportTriageWorker } from "@/lib/supportTriageWorker";

// The LLM step of the support-triage worker: one call per report, its lane,
// duplicates and reply draft written with the ready row; a money or
// trust-and-safety keyword keeps its human lane; no answer keeps the keyword lane.

const PREFIX = "fb-llm-";

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageGroup"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageRun"`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_delete"`);
  }
  await resetTestFixture(prisma, `TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
};

const report = (id: string, data: Record<string, unknown> = {}) =>
  prisma.feedback.create({ data: { id: `${PREFIX}${id}`, type: "bug", message: "The answer stops halfway.", ...data } });

const rows = () =>
  prisma.supportTriageSuggestion.findMany({
    where: { feedbackId: { startsWith: PREFIX }, state: "ready" },
    orderBy: { feedbackId: "asc" },
    select: { feedbackId: true, lane: true, laneSource: true, duplicateOfFeedbackIds: true, replyDraft: true },
  });

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("the model's lane, duplicates and draft are written with the ready row", async () => {
  await report("a", { message: "Answers stop halfway since this morning." });
  await report("b", { message: "Replies cut off in the middle." });
  const seen: TriageLlmInput[] = [];
  const llm: TriageLlm = async (input) => {
    seen.push(input);
    const other = input.candidates.find((c) => c.id.startsWith(PREFIX));
    return { lane: "bug_unverified", duplicateOf: other ? [other.id] : [], replyDraft: "Thanks, we are looking into it." };
  };
  const result = await runSupportTriageWorker({ llm });
  assert.equal(result.ready, 2);
  assert.equal(seen.length, 2);
  // A report is never offered as its own duplicate.
  for (const input of seen) {
    assert.ok(input.report.message.length > 0);
  }
  assert.deepEqual(await rows(), [
    {
      feedbackId: `${PREFIX}a`,
      lane: "bug_unverified",
      laneSource: "llm",
      duplicateOfFeedbackIds: [`${PREFIX}b`],
      replyDraft: "Thanks, we are looking into it.",
    },
    {
      feedbackId: `${PREFIX}b`,
      lane: "bug_unverified",
      laneSource: "llm",
      duplicateOfFeedbackIds: [`${PREFIX}a`],
      replyDraft: "Thanks, we are looking into it.",
    },
  ]);
  // The audit entry carries counts only, never the draft.
  const audits = JSON.stringify(await prisma.adminAuditLog.findMany({ select: { summary: true, metadata: true } }));
  assert.ok(!audits.includes("looking into it"));
});

test("a money keyword keeps the billing lane whatever the model says", async () => {
  await report("pay", { type: "other", message: "I was charged twice, please refund me." });
  const llm: TriageLlm = async () => ({ lane: "feature_request", duplicateOf: [], replyDraft: "Noted." });
  await runSupportTriageWorker({ llm });
  const [row] = await rows();
  assert.equal(row.lane, "billing_human");
  assert.equal(row.laneSource, "keyword");
  // The draft is still useful to the operator and is kept.
  assert.equal(row.replyDraft, "Noted.");
});

test("no answer, or the step off, leaves the keyword lane and no draft", async () => {
  await report("a");
  await runSupportTriageWorker({ llm: async () => null });
  await report("b");
  await runSupportTriageWorker({ llm: null });
  assert.deepEqual(
    (await rows()).map((r) => [r.feedbackId, r.lane, r.laneSource, r.duplicateOfFeedbackIds, r.replyDraft]),
    [
      [`${PREFIX}a`, "bug_unverified", "keyword", [], null],
      [`${PREFIX}b`, "bug_unverified", "keyword", [], null],
    ]
  );
});

test("an answer is kept only where it fits: a known lane, offered ids, a bounded draft", () => {
  const offered = new Set(["x", "y"]);
  assert.equal(parseTriageAnswer({ lane: "urgent", duplicateOf: [], replyDraft: "" }, offered), null);
  assert.equal(parseTriageAnswer({ lane: "other", duplicateOf: "x", replyDraft: "" }, offered), null);
  assert.equal(parseTriageAnswer(null, offered), null);
  const answer = parseTriageAnswer(
    { lane: "other", duplicateOf: ["x", "x", "invented", "y"], replyDraft: ` ${"d".repeat(3000)} ` },
    offered
  );
  assert.deepEqual(answer?.duplicateOf, ["x", "y"]);
  assert.equal(answer?.replyDraft.length, 2000);
});
