import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DRAFT_NEW_SCOPE,
  chatComposerDraftPutSchema,
  decideDraftCas,
  parseStoredDraftReferences,
  validateDraftReferencesForScope,
} from "../lib/chatComposerDraftCore.ts";
import {
  CHAT_ATTEMPT_ID_REUSED,
  chatResponseAttemptFailureCodeSchema,
  chatResponseAttemptFingerprint,
  chatResponseAttemptRequestPayloadDigest,
  chatResponseAttemptTerminalStatusSchema,
  decideAttemptCheckpoint,
  decideAttemptClaim,
  decideAttemptTerminal,
  publicChatResponseAttempt,
  validateAttemptLease,
  validateAttemptTerminalMetadata,
} from "../lib/chatResponseAttemptCore.ts";

test("draft writes keep exact text and ordered opaque references", () => {
  const parsed = chatComposerDraftPutSchema.parse({
    expectedRevision: 0,
    text: "  keep my spacing  ",
    attachmentReferences: [{ uploadId: "up_1" }, { attachmentId: "att_2" }],
  });
  assert.equal(parsed.text, "  keep my spacing  ");
  assert.deepEqual(parsed.attachmentReferences, [
    { uploadId: "up_1" },
    { attachmentId: "att_2" },
  ]);
  assert.throws(() =>
    chatComposerDraftPutSchema.parse({
      expectedRevision: 0,
      text: "x",
      attachmentReferences: [{ uploadId: "up_1", objectKey: "secret" }],
    })
  );
  assert.throws(() =>
    parseStoredDraftReferences([{ attachmentId: "att_2" }, { attachmentId: "att_2" }])
  );
});

test("new drafts accept uploads only while stored scopes may use bound attachments", () => {
  assert.equal(validateDraftReferencesForScope(CHAT_DRAFT_NEW_SCOPE, [{ uploadId: "up_1" }]), true);
  assert.equal(
    validateDraftReferencesForScope(CHAT_DRAFT_NEW_SCOPE, [{ attachmentId: "att_1" }]),
    false
  );
  assert.equal(validateDraftReferencesForScope("conv_1", [{ attachmentId: "att_1" }]), true);
});

test("draft revisions are create-or-exact-CAS and never last-write-wins", () => {
  assert.deepEqual(decideDraftCas(null, 0), { action: "create", nextRevision: 1 });
  assert.deepEqual(decideDraftCas(null, 1), { action: "conflict", currentRevision: null });
  assert.deepEqual(decideDraftCas(4, 4), { action: "update", nextRevision: 5 });
  assert.deepEqual(decideDraftCas(4, 3), { action: "conflict", currentRevision: 4 });
});

const fingerprintInput = {
  conversationId: "conv_1",
  sourceUserMessageId: "msg_1",
  requestedModelId: "provider/model",
  requestPayloadDigest: "a".repeat(64),
};

test("attempt fingerprint is deterministic and length-delimited", () => {
  const first = chatResponseAttemptFingerprint(fingerprintInput);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, chatResponseAttemptFingerprint(fingerprintInput));
  assert.notEqual(
    first,
    chatResponseAttemptFingerprint({ ...fingerprintInput, requestedModelId: "provider/other" })
  );
});

test("request digests ignore object key order but preserve transcript order", () => {
  const first = chatResponseAttemptRequestPayloadDigest({
    modelId: "provider/model",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ],
  });
  assert.equal(
    first,
    chatResponseAttemptRequestPayloadDigest({
      messages: [
        { content: "first", role: "user" },
        { content: "second", role: "assistant" },
      ],
      modelId: "provider/model",
    })
  );
  assert.notEqual(
    first,
    chatResponseAttemptRequestPayloadDigest({
      modelId: "provider/model",
      messages: [
        { role: "assistant", content: "second" },
        { role: "user", content: "first" },
      ],
    })
  );
});

test("attempt fingerprint accepts the validated full claim record", () => {
  assert.match(
    chatResponseAttemptFingerprint({
      assistantMessageId: "assistant_1",
      conversationId: "conversation_1",
      sourceUserMessageId: "message_1",
      requestedModelId: "provider/model-a",
      requestPayloadDigest: "a".repeat(64),
      ownerId: "worker_1",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }),
    /^[0-9a-f]{64}$/
  );
});

test("claim reattaches only the same account and fingerprint", () => {
  const identity = {
    assistantMessageId: "assistant_1",
    userId: "user_1",
    conversationId: "conv_1",
    sourceUserMessageId: "msg_1",
    requestedModelId: "provider/model",
    fingerprint: "b".repeat(64),
  };
  assert.deepEqual(decideAttemptClaim(null, identity), { action: "create" });
  assert.deepEqual(decideAttemptClaim(identity, identity), { action: "reattach" });
  assert.deepEqual(decideAttemptClaim(identity, { ...identity, userId: "user_2" }), {
    action: "conflict",
    code: CHAT_ATTEMPT_ID_REUSED,
  });
});

const activeAttempt = {
  status: "streaming",
  checkpointRevision: 2,
  expectedRevision: 2,
  ownerId: "worker_1",
  expectedOwnerId: "worker_1",
  leaseExpiresAt: new Date("2026-09-13T01:01:00.000Z"),
  now: new Date("2026-09-13T01:00:00.000Z"),
  committedContent: "committed",
};

test("checkpoint and terminal CAS preserve the committed prefix", () => {
  assert.deepEqual(decideAttemptCheckpoint({ ...activeAttempt, nextContent: "committed more" }), {
    action: "update",
    nextRevision: 3,
  });
  assert.deepEqual(decideAttemptCheckpoint({ ...activeAttempt, nextContent: "changed" }), {
    action: "refuse",
    reason: "committed_prefix_changed",
  });
  assert.deepEqual(
    decideAttemptTerminal({ ...activeAttempt, finalContent: "committed done", terminalStatus: "completed" }),
    { action: "update", nextRevision: 3 }
  );
  assert.equal(
    decideAttemptCheckpoint({ ...activeAttempt, ownerId: "worker_2", nextContent: "committed" }).reason,
    "owner_mismatch"
  );
  assert.equal(
    decideAttemptCheckpoint({
      ...activeAttempt,
      leaseExpiresAt: activeAttempt.now,
      nextContent: "committed",
    }).reason,
    "lease_expired"
  );
});

test("attempt leases are positive and bounded to five minutes", () => {
  const now = new Date("2026-09-13T01:00:00.000Z");
  assert.equal(
    validateAttemptLease({ now, leaseExpiresAt: new Date("2026-09-13T01:05:00.000Z") }),
    "valid"
  );
  assert.equal(validateAttemptLease({ now, leaseExpiresAt: now }), "lease_expired");
  assert.equal(
    validateAttemptLease({ now, leaseExpiresAt: new Date("2026-09-13T01:05:00.001Z") }),
    "lease_too_long"
  );
});

test("terminal metadata accepts only safe status-consistent classifications", () => {
  assert.equal(chatResponseAttemptTerminalStatusSchema.parse("completed"), "completed");
  assert.equal(chatResponseAttemptTerminalStatusSchema.safeParse("streaming").success, false);
  assert.equal(chatResponseAttemptTerminalStatusSchema.safeParse("unknown").success, false);
  assert.equal(
    validateAttemptTerminalMetadata({
      status: "failed",
      finishReason: "error",
      failureCode: "provider_unavailable",
    }),
    true
  );
  assert.equal(
    validateAttemptTerminalMetadata({
      status: "completed",
      finishReason: "stop",
      failureCode: null,
    }),
    true
  );
  assert.equal(
    validateAttemptTerminalMetadata({
      status: "cancelled",
      finishReason: "cancelled",
      failureCode: "internal_error",
    }),
    false
  );
  assert.equal(
    chatResponseAttemptFailureCodeSchema.safeParse(
      "HTTP 500: provider said secret=request-body"
    ).success,
    false
  );
});

test("attempt public state omits the fingerprint, owner and lease", () => {
  const publicState = publicChatResponseAttempt({
    assistantMessageId: "assistant_1",
    userId: "user_1",
    conversationId: "conv_1",
    sourceUserMessageId: "msg_1",
    fingerprint: "c".repeat(64),
    requestedModelId: "provider/model",
    actualModelId: null,
    provider: null,
    status: "claimed",
    partialContent: "",
    checkpointRevision: 0,
    ownerId: "worker_1",
    leaseExpiresAt: new Date("2026-09-13T01:01:00.000Z"),
    finishReason: null,
    failureCode: null,
    terminalAt: null,
    createdAt: new Date("2026-09-13T01:00:00.000Z"),
    updatedAt: new Date("2026-09-13T01:00:00.000Z"),
  });
  assert.equal("fingerprint" in publicState, false);
  assert.equal("ownerId" in publicState, false);
  assert.equal("leaseExpiresAt" in publicState, false);
});
