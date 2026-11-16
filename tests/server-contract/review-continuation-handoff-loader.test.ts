import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL = "postgresql://e2e:e2e@127.0.0.1:1/e2e";

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
const core = require(resolve(root, "lib/reviewContinuationHandoffCore.ts"));

let featureEnabled = true;
let parentPresent = true;
let sourcePresent = true;
let sourceConversationDigest = "snapshot-digest";
let parentUnlocked = true;
let sourceUnlocked = true;
let nativeText = "Tomverse proposed option B.";
let nativeReferenceMessageId = "native";
let questionAttachmentCount = 0;
let nativeAttachmentCount = 0;
let assistantResearchRunId: string | null = null;
let nativePendingJobId: string | null = null;
let questionResearchSourceRunCount = 0;
let sourceMode: "legacy" | "recorded" = "legacy";
let manifest: unknown = null;
let descriptorManifestDigestOverride: string | null | undefined;
let malformedDescriptor = false;
let sourceReads = 0;

const question = "Use the second option.";
const answer = "The selected completed answer.";
const descriptor = () => malformedDescriptor ? { bad: true } : {
  version: 1,
  parentConversationId: "parent",
  sourceUserMessageId: "question",
  sourceUserContentDigest: core.reviewHandoffContentDigest(question),
  assistantMessageId: "answer",
  assistantContentDigest: core.reviewHandoffContentDigest(answer),
  sourceMode,
  sourceManifestDigest: descriptorManifestDigestOverride !== undefined
    ? descriptorManifestDigestOverride
    : sourceMode === "recorded" && manifest
      ? core.reviewHandoffContentDigest(JSON.stringify(manifest))
      : null,
  nativeReferences: [{
    messageId: nativeReferenceMessageId,
    role: "assistant",
    contentDigest: core.reviewHandoffContentDigest("Tomverse proposed option B."),
  }],
  nativeOmittedCount: 2,
};

const db = {
  conversationContinuationBridge: {
    findFirst: async () => ({
      reviewHandoff: descriptor(),
      seedMessageCount: 1,
      seedOmittedMessageCount: 2,
      provider: "chatgpt",
      sourceImportedAt: new Date("2026-01-01T00:00:00Z"),
      sourceConversationDigest: "snapshot-digest",
      sourceDigestVersion: 1,
      externalConversationId: sourcePresent ? "source" : null,
      conversation: {
        productKey: "review", kind: "chat", password: null, passwordVersion: 0,
      },
    }),
  },
  conversation: {
    findFirst: async () => parentPresent ? { password: "hash", passwordVersion: 7 } : null,
  },
  externalConversation: {
    findFirst: async () => {
      sourceReads += 1;
      return sourcePresent ? {
        id: "source", conversationDigest: sourceConversationDigest, digestVersion: 1,
        messageCount: 1, password: "hash", passwordVersion: 9,
      } : null;
    },
  },
  chatResponseAttempt: {
    findUnique: async () => ({
      userId: "owner", conversationId: "parent", sourceUserMessageId: "question",
      status: "completed", actualModelId: "model-current", provider: "provider-current",
      partialContent: answer, continuationSourcePlan: manifest,
    }),
  },
  message: {
    findFirst: async (args: { where: { id: string } }) => args.where.id === "question"
      ? { content: question, researchRunId: null, pendingJobId: null,
          _count: { attachments: questionAttachmentCount,
            researchSourceRuns: questionResearchSourceRunCount } }
      : { content: answer, researchRunId: assistantResearchRunId, pendingJobId: null },
    findMany: async () => [{
      id: "native", role: "assistant", content: nativeText,
      researchRunId: null, pendingJobId: nativePendingJobId,
      _count: { attachments: nativeAttachmentCount },
    }],
    count: async () => 1,
  },
  externalMessage: {
    findMany: async () => {
      sourceReads += 1;
      return [{ role: "user", ordinal: 0, content: "Kyoto budget AUD 1,500", truncated: false }];
    },
  },
  $transaction: async (run: (tx: unknown) => unknown) => run(db),
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: db } });
const settings = require(resolve(root, "lib/appSettings.ts"));
mock.module(mod("lib/appSettings.ts"), {
  namedExports: { ...settings, isExternalContinuationEnabled: async () => featureEnabled },
});
const locks = require(resolve(root, "lib/conversationLock.ts"));
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  ...locks,
  hasConversationUnlockGrant: (_request: Request, _user: string, id: string) =>
    id === "parent" ? parentUnlocked : true,
  hasResourceUnlockGrant: () => sourceUnlocked,
} });

const load = async () => {
  const service = await import(mod("lib/reviewContinuationHandoffService.ts"));
  return service.loadReviewContinuationReference({
    userId: "owner",
    conversationId: "target",
    request: new Request("https://tomverse.test/api/chat"),
  });
};

const resetState = () => {
  featureEnabled = true;
  parentPresent = true;
  sourcePresent = true;
  sourceConversationDigest = "snapshot-digest";
  parentUnlocked = true;
  sourceUnlocked = true;
  nativeText = "Tomverse proposed option B.";
  nativeReferenceMessageId = "native";
  questionAttachmentCount = 0;
  nativeAttachmentCount = 0;
  assistantResearchRunId = null;
  nativePendingJobId = null;
  questionResearchSourceRunCount = 0;
  sourceMode = "legacy";
  manifest = null;
  descriptorManifestDigestOverride = undefined;
  malformedDescriptor = false;
  sourceReads = 0;
};

beforeEach(resetState);

test("legacy handoff reconstructs bounded source and native reference without the clicked answer", async () => {
  const loaded = await load();
  assert.equal(loaded.status, "available");
  if (loaded.status !== "available") return;
  assert.match(loaded.sourcePrompt.transcriptText!, /Kyoto budget AUD 1,500/);
  assert.match(loaded.nativeReferenceText!, /option B/);
  assert.doesNotMatch(loaded.nativeReferenceText!, /selected completed answer/);
  assert.equal(loaded.publicMetadata.sourceMode, "legacy");
});

test("malformed descriptor and edited or attachment-bearing native references are unavailable", async () => {
  malformedDescriptor = true;
  assert.equal((await load()).status, "unavailable");
  malformedDescriptor = false;
  nativeText = "edited";
  assert.equal((await load()).status, "unavailable");
  nativeText = "Tomverse proposed option B.";
  nativeAttachmentCount = 1;
  assert.equal((await load()).status, "unavailable");
  nativeAttachmentCount = 0;
  questionAttachmentCount = 1;
  assert.equal((await load()).status, "unavailable");
});

test("a descriptor cannot reintroduce the question or clicked answer as native context", async () => {
  for (const messageId of ["question", "answer"]) {
    resetState();
    nativeReferenceMessageId = messageId;
    const loaded = await load();
    assert.equal(loaded.status, "unavailable");
    if (loaded.status === "unavailable") assert.equal(loaded.reason, "invalid_descriptor");
    assert.equal(sourceReads, 0);
  }
});

test("research and pending-job answer, question, or native context is explicitly unavailable", async () => {
  assistantResearchRunId = "research-answer";
  assert.equal((await load()).status, "unavailable");
  assistantResearchRunId = null;
  questionResearchSourceRunCount = 1;
  assert.equal((await load()).status, "unavailable");
  questionResearchSourceRunCount = 0;
  nativePendingJobId = "pending-native";
  assert.equal((await load()).status, "unavailable");
});

test("parent/source deletion, either lock, and flag off refuse before source text is read", async () => {
  for (const setup of [
    () => { parentPresent = false; },
    () => { parentUnlocked = false; },
    () => { sourcePresent = false; },
    () => { sourceUnlocked = false; },
    () => { featureEnabled = false; },
  ]) {
    resetState();
    setup();
    const loaded = await load();
    assert.equal(loaded.status, "unavailable");
    assert.ok(sourceReads <= 1, "no external message body is read after an access refusal");
  }
});

test("legacy handoff refuses a changed external snapshot instead of reconstructing new recent context", async () => {
  sourceConversationDigest = "changed-snapshot-digest";
  const loaded = await load();
  assert.equal(loaded.status, "unavailable");
  if (loaded.status === "unavailable") assert.equal(loaded.reason, "source_changed");
  assert.equal(sourceReads, 1, "the changed snapshot body is not read");
});

test("recorded manifest attempt binding cannot be reassigned to another provider attempt", async () => {
  const manifestModule = await import(mod("lib/continuationSourceManifest.ts"));
  const seedModule = await import(mod("lib/externalContinuationSeedCore.ts"));
  const plan = seedModule.planContinuationSeed({
    messages: [{ role: "user", ordinal: 0, content: "Kyoto budget AUD 1,500", truncated: false }],
    sourceMessageCount: 1,
  });
  manifest = manifestModule.serializeContinuationSourcePlan({
    plan,
    sourceId: "source",
    sourceConversationDigest: "snapshot-digest",
    sourceDigestVersion: 1,
    attempt: {
      assistantMessageId: "answer",
      sourceUserMessageId: "question",
      attemptIndex: 0,
      actualModelId: "different-model",
      provider: "different-provider",
    },
  });
  sourceMode = "recorded";
  const loaded = await load();
  assert.equal(loaded.status, "unavailable");
  if (loaded.status === "unavailable") assert.equal(loaded.reason, "source_reference_changed");
});

test("a target pins the recorded manifest envelope against later valid mutation", async () => {
  const manifestModule = await import(mod("lib/continuationSourceManifest.ts"));
  const seedModule = await import(mod("lib/externalContinuationSeedCore.ts"));
  const build = (content: string) => manifestModule.serializeContinuationSourcePlan({
    plan: seedModule.planContinuationSeed({
      messages: [{ role: "user", ordinal: 0, content, truncated: false }],
      sourceMessageCount: 1,
    }),
    sourceId: "source",
    sourceConversationDigest: "snapshot-digest",
    sourceDigestVersion: 1,
    attempt: {
      assistantMessageId: "answer", sourceUserMessageId: "question", attemptIndex: 0,
      actualModelId: "model-current", provider: "provider-current",
    },
  });
  manifest = build("Kyoto budget AUD 1,500");
  sourceMode = "recorded";
  descriptorManifestDigestOverride = core.reviewHandoffContentDigest(JSON.stringify(manifest));
  manifest = build("Kyoto budget AUD 1,500 changed");
  const loaded = await load();
  assert.equal(loaded.status, "unavailable");
  if (loaded.status === "unavailable") assert.equal(loaded.reason, "source_manifest_changed");
});
