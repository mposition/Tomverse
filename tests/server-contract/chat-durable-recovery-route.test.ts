import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

type Session = { user: { id: string; email: string } } | null;
let session: Session = { user: { id: "user_1", email: "owner@example.test" } };
let draftRow: Record<string, unknown> | null = null;
let attemptRow: Record<string, unknown> | null = null;
let attemptReconciledRow: Record<string, unknown> | null | undefined;
let attemptReconcileReads = 0;
let attemptReadExpectedConversationId: string | undefined;
let accessAllowed = true;
let authorizedScopes: string[] = [];
let deniedAccessScopes = new Set<string>();
let rateLimitRefused = false;
let draftReadCount = 0;
let draftAttachmentResolveFailure = false;
let writtenDraftRow: Record<string, unknown> | null = null;
let hydratedDraftRow: Record<string, unknown> | null = null;
let receiptResult: Record<string, unknown> = {
  outcome: "unchanged",
  attachments: [],
};
let receiptInput: Record<string, unknown> | null = null;
let receiptConversation: {
  userId: string;
  password: string | null;
  kind: string;
  productKey: string | null;
} | null = { userId: "user_1", password: null, kind: "chat", productKey: "chat" };
let receiptUnlockGranted = true;

class DraftConflict extends Error {
  readonly code = "CHAT_DRAFT_REVISION_CONFLICT";
  constructor(readonly currentRevision: number | null) {
    super("The Chat draft changed before this request was applied.");
  }
}

class AttachmentResolve extends Error {}

mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      conversation: { findUnique: async () => receiptConversation },
    },
  },
});
mock.module(mod("lib/conversationLock.ts"), {
  namedExports: {
    hasConversationUnlockGrant: () => receiptUnlockGranted,
    conversationLockedResponse: () => Response.json(
      { error: "This conversation is locked.", code: "CONVERSATION_LOCKED" },
      { status: 423 }
    ),
  },
});
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    apiSecurityResponse: (error: unknown) =>
      error instanceof Error && error.message === "RATE_LIMIT_TEST"
        ? Response.json(
            { error: "Too many requests.", code: "RATE_LIMITED" },
            { status: 429 }
          )
        : null,
    consumeApiRateLimit: async () => {
      if (rateLimitRefused) throw new Error("RATE_LIMIT_TEST");
    },
    readLimitedJson: async (request: Request, _limit: number, schema: { parse: (x: unknown) => unknown }) =>
      schema.parse(await request.json()),
  },
});
mock.module(mod("lib/chatDurableRecoveryAccess.ts"), {
  namedExports: {
    authorizeChatRecoveryScope: async ({ scopeKey }: { scopeKey: string }) => {
      authorizedScopes.push(scopeKey);
      return accessAllowed && !deniedAccessScopes.has(scopeKey)
        ? { ok: true, conversationId: null }
        : {
            ok: false,
            response: Response.json(
              { error: "Conversation not found.", code: "CONVERSATION_NOT_FOUND" },
              { status: 404, headers: { "Cache-Control": "no-store" } }
            ),
          };
    },
  },
});
mock.module(mod("lib/chatComposerDraftPersistence.ts"), {
  namedExports: {
    ChatDraftRevisionConflictError: DraftConflict,
    publicChatComposerDraftWithAttachments: async ({ draft }: { draft: Record<string, unknown> }) => {
      if (draftAttachmentResolveFailure) throw new AttachmentResolve();
      hydratedDraftRow = draft;
      return draft;
    },
    readChatComposerDraft: async () => {
      draftReadCount += 1;
      return draftRow;
    },
    readPublicChatComposerDraft: async () => {
      draftReadCount += 1;
      return draftRow;
    },
    writeChatComposerDraft: async ({ draft }: { draft: Record<string, unknown> }) => {
      if (draft.expectedRevision === 99) throw new DraftConflict(4);
      return writtenDraftRow ?? draftRow;
    },
    deleteChatComposerDraft: async () => undefined,
  },
});
mock.module(mod("lib/chatResponseAttemptPersistence.ts"), {
  namedExports: {
    peekChatResponseAttempt: async () => attemptRow,
    readChatResponseAttempt: async (
      _userId: string,
      _assistantMessageId: string,
      expectedConversationId?: string
    ) => {
      attemptReconcileReads += 1;
      attemptReadExpectedConversationId = expectedConversationId;
      return attemptReconciledRow === undefined ? attemptRow : attemptReconciledRow;
    },
  },
});
mock.module(mod("lib/messageAttachmentStorage.ts"), {
  namedExports: { MessageAttachmentResolveError: AttachmentResolve },
});
mock.module(mod("lib/chatDraftMessageConsume.ts"), {
  namedExports: {
    chatDraftMessageReceiptSchema: { parse: (value: unknown) => value },
    reconcileChatDraftMessageReceipt: async (input: Record<string, unknown>) => {
      receiptInput = input;
      return receiptResult;
    },
  },
});
mock.module(mod("lib/messageRequestIdentity.ts"), {
  namedExports: {
    scopedMessageId: () =>
      "22222222-2222-8222-8222-222222222222",
  },
});

let routesPromise: Promise<{
  draftRoute: typeof import("../../app/api/products/chat/drafts/[scopeKey]/route");
  attemptRoute: typeof import("../../app/api/products/chat/attempts/[assistantMessageId]/route");
  receiptRoute: typeof import("../../app/api/conversations/[conversationId]/messages/receipt/route");
}> | null = null;

const loadRoutes = () => {
  routesPromise ??= Promise.all([
    import(`${mod("app/api/products/chat/drafts/[scopeKey]/route.ts")}?test=1`),
    import(`${mod("app/api/products/chat/attempts/[assistantMessageId]/route.ts")}?test=1`),
    import(`${mod("app/api/conversations/[conversationId]/messages/receipt/route.ts")}?test=1`),
  ]).then(([draftRoute, attemptRoute, receiptRoute]) => ({
    draftRoute,
    attemptRoute,
    receiptRoute,
  }));
  return routesPromise;
};

const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://127.0.0.1:3100${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test.beforeEach(() => {
  session = { user: { id: "user_1", email: "owner@example.test" } };
  draftRow = null;
  attemptRow = null;
  attemptReconciledRow = undefined;
  attemptReconcileReads = 0;
  attemptReadExpectedConversationId = undefined;
  accessAllowed = true;
  authorizedScopes = [];
  deniedAccessScopes = new Set();
  rateLimitRefused = false;
  draftReadCount = 0;
  draftAttachmentResolveFailure = false;
  writtenDraftRow = null;
  hydratedDraftRow = null;
  receiptResult = { outcome: "unchanged", attachments: [] };
  receiptInput = null;
  receiptConversation = {
    userId: "user_1", password: null, kind: "chat", productKey: "chat",
  };
  receiptUnlockGranted = true;
});

test("message receipt is authenticated, read-only shaped and no-store", async () => {
  const { receiptRoute } = await loadRoutes();
  const body = {
    draftConsume: {
      scopeKey: "conversation_1",
      expectedRevision: 3,
      requestId: "11111111-1111-4111-8111-111111111111",
    },
    message: {
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      content: "exact question",
    },
  };
  receiptResult = {
    outcome: "committed",
    messageId: "22222222-2222-8222-8222-222222222222",
    attachments: [],
  };
  const response = await receiptRoute.POST(
    request("/api/conversations/conversation_1/messages/receipt", "POST", body),
    { params: Promise.resolve({ conversationId: "conversation_1" }) }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    ...receiptResult,
    requestId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(receiptInput, {
    userId: "user_1",
    conversationId: "conversation_1",
    receipt: {
      draftConsume: {
        scopeKey: "conversation_1",
        expectedRevision: 3,
        messageId: "22222222-2222-8222-8222-222222222222",
      },
      message: {
        id: "22222222-2222-8222-8222-222222222222",
        content: "exact question",
      },
    },
  });

  session = null;
  const denied = await receiptRoute.POST(
    request("/api/conversations/conversation_1/messages/receipt", "POST", body),
    { params: Promise.resolve({ conversationId: "conversation_1" }) }
  );
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("Cache-Control"), "private, no-store");
});

test("message receipt enforces owner, Chat product and the conversation unlock grant", async () => {
  const { receiptRoute } = await loadRoutes();
  const body = {
    draftConsume: {
      scopeKey: "conversation_1", expectedRevision: 3,
      requestId: "11111111-1111-4111-8111-111111111111",
    },
    message: {
      clientRequestId: "11111111-1111-4111-8111-111111111111", content: "exact question",
    },
  };
  const send = () => receiptRoute.POST(
    request("/api/conversations/conversation_1/messages/receipt", "POST", body),
    { params: Promise.resolve({ conversationId: "conversation_1" }) }
  );

  receiptConversation = null;
  const missing = await send();
  receiptConversation = { userId: "other", password: null, kind: "chat", productKey: "chat" };
  const foreign = await send();
  assert.equal(missing.status, 403);
  assert.equal(foreign.status, 403);
  assert.deepEqual(await missing.json(), await foreign.json());

  receiptConversation = { userId: "user_1", password: "hash", kind: "chat", productKey: "chat" };
  receiptUnlockGranted = false;
  const locked = await send();
  assert.equal(locked.status, 423);
  assert.equal(locked.headers.get("Cache-Control"), "private, no-store");

  receiptUnlockGranted = true;
  receiptConversation = { userId: "user_1", password: null, kind: "review", productKey: "review" };
  const wrongProduct = await send();
  assert.equal(wrongProduct.status, 409);
  assert.equal((await wrongProduct.json()).code, "CHAT_DRAFT_CONSUME_NOT_SUPPORTED");
  assert.equal(receiptInput, null);
});

test("draft GET requires authentication and is no-store", async () => {
  const { draftRoute } = await loadRoutes();
  session = null;
  const response = await draftRoute.GET(request("/api/products/chat/drafts/new"), {
    params: Promise.resolve({ scopeKey: "new" }),
  });
  assert.ok(response);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("draft GET returns exact text and ordered opaque references", async () => {
  const { draftRoute } = await loadRoutes();
  draftRow = {
    scopeKey: "new",
    conversationId: null,
    text: "  exact draft  ",
    attachmentReferences: [{ uploadId: "up_1" }, { uploadId: "up_2" }],
    revision: 3,
    createdAt: new Date("2026-09-13T01:00:00.000Z"),
    updatedAt: new Date("2026-09-13T01:01:00.000Z"),
  };
  const response = await draftRoute.GET(request("/api/products/chat/drafts/new"), {
    params: Promise.resolve({ scopeKey: "new" }),
  });
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual((await response.json()).draft.attachmentReferences, [
    { uploadId: "up_1" },
    { uploadId: "up_2" },
  ]);
});

test("draft GET turns a dangling attachment into an explicit recoverable conflict", async () => {
  const { draftRoute } = await loadRoutes();
  draftAttachmentResolveFailure = true;
  draftRow = {
    scopeKey: "new",
    conversationId: null,
    text: "Keep the recoverable text.",
    attachmentReferences: [{ uploadId: "missing_upload" }],
    revision: 3,
    createdAt: new Date("2026-09-13T01:00:00.000Z"),
    updatedAt: new Date("2026-09-13T01:01:00.000Z"),
  };
  const response = await draftRoute.GET(request("/api/products/chat/drafts/new"), {
    params: Promise.resolve({ scopeKey: "new" }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.code, "CHAT_DRAFT_ATTACHMENT_INVALID");
  assert.equal(body.currentRevision, 3);
  assert.equal(body.currentDraft.text, "Keep the recoverable text.");
  assert.deepEqual(body.currentDraft.attachmentReferences, []);
  assert.deepEqual(body.currentDraft.attachments, []);
});

test("an access refusal remains no-store", async () => {
  const { draftRoute } = await loadRoutes();
  accessAllowed = false;
  const response = await draftRoute.GET(request("/api/products/chat/drafts/conversation_1"), {
    params: Promise.resolve({ scopeKey: "conversation_1" }),
  });
  assert.ok(response);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("a security/rate-limit refusal is wrapped as no-store", async () => {
  const { draftRoute } = await loadRoutes();
  rateLimitRefused = true;
  const response = await draftRoute.GET(request("/api/products/chat/drafts/new"), {
    params: Promise.resolve({ scopeKey: "new" }),
  });
  assert.ok(response);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("draft PUT exposes an explicit revision conflict", async () => {
  const { draftRoute } = await loadRoutes();
  const response = await draftRoute.PUT(
    request("/api/products/chat/drafts/new", "PUT", {
      expectedRevision: 99,
      text: "mine",
      attachmentReferences: [],
    }),
    { params: Promise.resolve({ scopeKey: "new" }) }
  );
  assert.ok(response);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "The Chat draft changed before this request was applied.",
    code: "CHAT_DRAFT_REVISION_CONFLICT",
    currentRevision: null,
    currentDraft: null,
  });
});

test("draft conflict revision is derived from the returned snapshot", async () => {
  const { draftRoute } = await loadRoutes();
  draftRow = {
    scopeKey: "new",
    text: "server snapshot",
    attachmentReferences: [],
    attachments: [],
    revision: 7,
    createdAt: "2026-09-13T01:00:00.000Z",
    updatedAt: "2026-09-13T01:01:00.000Z",
  };
  const response = await draftRoute.PUT(
    request("/api/products/chat/drafts/new", "PUT", {
      expectedRevision: 99,
      text: "mine",
      attachmentReferences: [],
    }),
    { params: Promise.resolve({ scopeKey: "new" }) }
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.currentRevision, 7);
  assert.equal(body.currentDraft.revision, 7);
});

test("draft PUT returns the exact row written without a success-path reread", async () => {
  const { draftRoute } = await loadRoutes();
  writtenDraftRow = {
    scopeKey: "new",
    conversationId: null,
    text: "my exact winner",
    attachmentReferences: [],
    revision: 7,
    createdAt: new Date("2026-09-13T01:00:00.000Z"),
    updatedAt: new Date("2026-09-13T01:01:00.000Z"),
  };
  const response = await draftRoute.PUT(
    request("/api/products/chat/drafts/new", "PUT", {
      expectedRevision: 6,
      text: "my exact winner",
      attachmentReferences: [],
    }),
    { params: Promise.resolve({ scopeKey: "new" }) }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(draftReadCount, 0);
  assert.equal(hydratedDraftRow, writtenDraftRow);
  assert.equal((await response.json()).draft.revision, 7);
});

test("attempt GET makes foreign and missing ids indistinguishable", async () => {
  const { attemptRoute } = await loadRoutes();
  const response = await attemptRoute.GET(request("/api/products/chat/attempts/assistant_1"), {
    params: Promise.resolve({ assistantMessageId: "assistant_1" }),
  });
  assert.ok(response);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Chat response attempt not found.",
    code: "CHAT_ATTEMPT_NOT_FOUND",
  });
});

test("attempt GET returns only the public checkpoint state", async () => {
  const { attemptRoute } = await loadRoutes();
  attemptRow = {
    assistantMessageId: "assistant_1",
    userId: "user_1",
    conversationId: "conv_1",
    sourceUserMessageId: "msg_1",
    fingerprint: "a".repeat(64),
    requestedModelId: "provider/model",
    actualModelId: "provider/model",
    provider: "provider",
    status: "streaming",
    partialContent: "committed",
    checkpointRevision: 2,
    ownerId: "worker-secret",
    leaseExpiresAt: new Date("2026-09-13T01:02:00.000Z"),
    finishReason: null,
    failureCode: null,
    terminalAt: null,
    createdAt: new Date("2026-09-13T01:00:00.000Z"),
    updatedAt: new Date("2026-09-13T01:01:00.000Z"),
  };
  const response = await attemptRoute.GET(request("/api/products/chat/attempts/assistant_1"), {
    params: Promise.resolve({ assistantMessageId: "assistant_1" }),
  });
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.attempt.partialContent, "committed");
  assert.equal("fingerprint" in body.attempt, false);
  assert.equal("ownerId" in body.attempt, false);
  assert.equal("leaseExpiresAt" in body.attempt, false);
  assert.equal(attemptReconcileReads, 1);
});

test("attempt GET performs no lease reconciliation before a locked scope is authorized", async () => {
  const { attemptRoute } = await loadRoutes();
  attemptRow = {
    assistantMessageId: "assistant_1",
    userId: "user_1",
    conversationId: "conv_1",
    sourceUserMessageId: "msg_1",
    fingerprint: "a".repeat(64),
    requestedModelId: "provider/model",
    actualModelId: null,
    provider: null,
    status: "claimed",
    partialContent: "",
    checkpointRevision: 0,
    ownerId: "worker-secret",
    leaseExpiresAt: new Date(0),
    finishReason: null,
    failureCode: null,
    terminalAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  accessAllowed = false;
  const response = await attemptRoute.GET(
    request("/api/products/chat/attempts/assistant_1"),
    { params: Promise.resolve({ assistantMessageId: "assistant_1" }) }
  );
  assert.equal(response.status, 404);
  assert.equal(attemptReconcileReads, 0);
});

test("attempt GET binds reconciliation to the authorized scope and refuses a replacement row", async () => {
  const { attemptRoute } = await loadRoutes();
  const original = {
    assistantMessageId: "assistant_1",
    userId: "user_1",
    conversationId: "conv_unlocked",
    sourceUserMessageId: "msg_1",
    fingerprint: "a".repeat(64),
    requestedModelId: "provider/model",
    actualModelId: "provider/model",
    provider: "provider",
    status: "streaming",
    partialContent: "authorized checkpoint",
    checkpointRevision: 1,
    ownerId: "worker-secret",
    leaseExpiresAt: new Date("2026-09-13T01:02:00.000Z"),
    finishReason: null,
    failureCode: null,
    terminalAt: null,
    createdAt: new Date("2026-09-13T01:00:00.000Z"),
    updatedAt: new Date("2026-09-13T01:01:00.000Z"),
  };
  attemptRow = original;
  attemptReconcileReads = 0;

  // Simulate deletion and recreation under the same account and assistant id
  // after the non-mutating peek but before the reconciling read.
  attemptReconciledRow = {
    ...original,
    conversationId: "conv_locked_replacement",
    partialContent: "replacement secret",
  };

  const response = await attemptRoute.GET(
    request("/api/products/chat/attempts/assistant_1"),
    { params: Promise.resolve({ assistantMessageId: "assistant_1" }) }
  );
  assert.equal(response.status, 404);
  assert.deepEqual(authorizedScopes, ["conv_unlocked"]);
  assert.equal(attemptReadExpectedConversationId, "conv_unlocked");
  assert.equal(attemptReconcileReads, 1);
  assert.equal(JSON.stringify(await response.json()).includes("replacement secret"), false);
});
