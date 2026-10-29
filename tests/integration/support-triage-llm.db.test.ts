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
    return {
      contextIds: input.candidates.map((c) => c.id),
      lane: "bug_unverified",
      duplicateOf: other ? [other.id] : [],
      replyDraft: "Thanks, we are looking into it.",
    };
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
  const llm: TriageLlm = async (input) => ({
    contextIds: input.candidates.map((c) => c.id),
    lane: "feature_request",
    duplicateOf: [],
    replyDraft: "Noted.",
  });
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

const answering =
  (lane: "bug_verified" | "bug_unverified" | "other", draft = "Draft."): TriageLlm =>
  async (input) => ({ contextIds: input.candidates.map((c) => c.id), lane, duplicateOf: [], replyDraft: draft });

test("the model cannot raise an unverified report to a verified bug", async () => {
  await report("a");
  await runSupportTriageWorker({ llm: answering("bug_verified") });
  const [row] = await rows();
  assert.equal(row.lane, "bug_unverified");
  assert.equal(row.laneSource, "llm");
});

test("deleting the account of a report the model was shown deletes the suggestion that saw it", async () => {
  await report("seen", { message: "Something only this person wrote." });
  await report("a");
  await runSupportTriageWorker({ llm: answering("other") });
  const before = await prisma.supportTriageSuggestion.findFirstOrThrow({
    where: { feedbackId: `${PREFIX}a` },
    select: { contextFeedbackIds: true },
  });
  assert.ok(before.contextFeedbackIds.includes(`${PREFIX}seen`));
  const { deleteSupportTriageDataForAccount } = await import("@/lib/supportTriageAccountDeletion");
  const counts = await prisma.$transaction((tx) => deleteSupportTriageDataForAccount(tx, [`${PREFIX}seen`]));
  // Its own suggestion and the one that was shown it.
  assert.equal(counts.suggestions, 2);
  assert.equal(await prisma.supportTriageSuggestion.count({ where: { feedbackId: `${PREFIX}a` } }), 0);
});

test("an answer whose shown report was deleted before the result is written is dropped", async () => {
  await report("seen", { message: "Something only this person wrote." });
  await report("a");
  const { startSupportTriageRun } = await import("@/lib/supportTriageRunStore");
  const { claimSupportTriageBatch, runTriageLlm, writeSupportTriageResults } = await import("@/lib/supportTriageWorker");
  const run = await startSupportTriageRun("worker");
  const batch = await claimSupportTriageBatch(run, [`${PREFIX}a`]);
  const answered = await runTriageLlm(answering("other", "Mentions what seen wrote."), batch.claimed, batch.reports);
  assert.ok(answered[0].llm?.contextIds.includes(`${PREFIX}seen`));
  // The shown report's account is deleted while the model was answering.
  await prisma.feedback.update({ where: { id: `${PREFIX}seen` }, data: { message: "[deleted account]" } });
  const result = await writeSupportTriageResults(run, batch.token as string, answered);
  assert.equal(result.ready, 1);
  const [row] = await rows();
  assert.equal(row.laneSource, "keyword");
  assert.equal(row.replyDraft, null);
});

test("the model chosen in the Admin console is saved, audited and preferred over the environment", async () => {
  const { getRuntimeModels } = await import("@/lib/modelRegistry");
  const enabled = (await getRuntimeModels()).find((model) => model.enabled && !model.catalogDeleted);
  assert.ok(enabled, "an enabled model exists");
  const setting = await import("@/lib/supportTriageLlmSetting");
  const session = { user: { id: "admin-llm-test", email: "owner@example.invalid" }, expires: "2099-01-01T00:00:00.000Z" };
  const request = new Request("https://example.invalid/api/admin/support-triage/llm-model", { method: "PUT" });
  try {
    await assert.rejects(
      setting.writeSupportTriageLlmModelSetting({ session: session as never, request, modelId: "no-such-model" }),
      setting.SupportTriageModelRefused
    );
    assert.equal(await setting.readSupportTriageLlmModelSetting(), null);
    // Nothing saved: the environment variable decides.
    const { supportTriageLlmFromEnv } = await import("@/lib/supportTriageLlm");
    assert.deepEqual(await setting.resolveSupportTriageLlmModel({ SUPPORT_TRIAGE_LLM_MODEL_ID: enabled.id }), {
      modelId: enabled.id,
      source: "environment",
    });
    assert.notEqual(await supportTriageLlmFromEnv({ SUPPORT_TRIAGE_LLM_MODEL_ID: enabled.id }), null);
    await setting.writeSupportTriageLlmModelSetting({ session: session as never, request, modelId: enabled.id });
    assert.equal(await setting.readSupportTriageLlmModelSetting(), enabled.id);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "support_triage.llm_model_updated" },
      select: { metadata: true, targetId: true },
    });
    assert.deepEqual(audit.metadata, { modelId: enabled.id });
    // The saved choice wins over an environment variable naming a model that does not exist.
    assert.notEqual(await supportTriageLlmFromEnv({ SUPPORT_TRIAGE_LLM_MODEL_ID: "no-such-model" }), null);
    // Off is saved, so an environment variable naming a usable model cannot turn the step back on.
    await setting.writeSupportTriageLlmModelSetting({ session: session as never, request, modelId: null });
    assert.equal(await setting.readSupportTriageLlmModelSetting(), setting.SUPPORT_TRIAGE_LLM_MODEL_OFF);
    assert.deepEqual(await setting.resolveSupportTriageLlmModel({ SUPPORT_TRIAGE_LLM_MODEL_ID: enabled.id }), {
      modelId: null,
      source: "admin",
    });
    assert.equal(await supportTriageLlmFromEnv({ SUPPORT_TRIAGE_LLM_MODEL_ID: enabled.id }), null);
    assert.equal(await supportTriageLlmFromEnv({}), null);
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: setting.SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY } });
  }
});

test("the Admin switch decides whether the run route works, over the environment variable", async () => {
  const setting = await import("@/lib/supportTriageLlmSetting");
  const { handleSupportTriageRun } = await import("@/lib/supportTriageRoutes");
  const SECRET = "s".repeat(40);
  const post = () =>
    new Request("https://example.invalid/api/internal/support-triage/run", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
  const session = { user: { id: "admin-switch-test", email: "owner@example.invalid" }, expires: "2099-01-01T00:00:00.000Z" };
  const request = new Request("https://example.invalid/api/admin/support-triage/llm-model", { method: "PUT" });
  await report("a");
  try {
    // No saved switch: the environment variable decides, as before.
    assert.deepEqual(await setting.resolveSupportTriageEnabled({ SUPPORT_TRIAGE_ENABLED: "true" }), {
      enabled: true,
      source: "environment",
    });
    // Off in the Admin console beats the environment's true.
    await setting.writeSupportTriageEnabledSetting({ session: session as never, request, enabled: false });
    const off = await handleSupportTriageRun(post(), {
      env: { SUPPORT_TRIAGE_RUN_SECRET: SECRET, SUPPORT_TRIAGE_ENABLED: "true" },
    });
    assert.deepEqual(off.body, { result: "ok", enabled: false });
    assert.equal(await prisma.supportTriageSuggestion.count({ where: { feedbackId: { startsWith: PREFIX } } }), 0);
    // On in the Admin console works with no environment variable at all.
    await setting.writeSupportTriageEnabledSetting({ session: session as never, request, enabled: true });
    const on = await handleSupportTriageRun(post(), { env: { SUPPORT_TRIAGE_RUN_SECRET: SECRET } });
    assert.equal(on.status, 200);
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.ready, 1);
    const audits = await prisma.adminAuditLog.findMany({
      where: { action: "support_triage.enabled_updated" },
      orderBy: { createdAt: "asc" },
      select: { metadata: true },
    });
    assert.deepEqual(
      audits.map((a) => a.metadata),
      [{ enabled: false }, { enabled: true }]
    );
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: setting.SUPPORT_TRIAGE_ENABLED_SETTING_KEY } });
  }
});
