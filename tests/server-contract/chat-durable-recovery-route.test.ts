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
let accessAllowed = true;
let rateLimitRefused = false;

class DraftConflict extends Error {
  readonly code = "CHAT_DRAFT_REVISION_CONFLICT";
  constructor(readonly currentRevision: number | null) {
    super("The Chat draft changed before this request was applied.");
  }
}

mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
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
    authorizeChatRecoveryScope: async () =>
      accessAllowed
        ? { ok: true, conversationId: null }
        : {
            ok: false,
            response: Response.json(
              { error: "Conversation not found.", code: "CONVERSATION_NOT_FOUND" },
              { status: 404, headers: { "Cache-Control": "no-store" } }
            ),
          },
  },
});
mock.module(mod("lib/chatComposerDraftPersistence.ts"), {
  namedExports: {
    ChatDraftRevisionConflictError: DraftConflict,
    readChatComposerDraft: async () => draftRow,
    writeChatComposerDraft: async ({ draft }: { draft: Record<string, unknown> }) => {
      if (draft.expectedRevision === 99) throw new DraftConflict(4);
      return draftRow;
    },
    deleteChatComposerDraft: async () => undefined,
  },
});
mock.module(mod("lib/chatResponseAttemptPersistence.ts"), {
  namedExports: { readChatResponseAttempt: async () => attemptRow },
});
mock.module(mod("lib/messageAttachmentStorage.ts"), {
  namedExports: { MessageAttachmentResolveError: class extends Error {} },
});

let routesPromise: Promise<{
  draftRoute: typeof import("../../app/api/products/chat/drafts/[scopeKey]/route");
  attemptRoute: typeof import("../../app/api/products/chat/attempts/[assistantMessageId]/route");
}> | null = null;

const loadRoutes = () => {
  routesPromise ??= Promise.all([
    import(`${mod("app/api/products/chat/drafts/[scopeKey]/route.ts")}?test=1`),
    import(`${mod("app/api/products/chat/attempts/[assistantMessageId]/route.ts")}?test=1`),
  ]).then(([draftRoute, attemptRoute]) => ({ draftRoute, attemptRoute }));
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
  accessAllowed = true;
  rateLimitRefused = false;
});

test("draft GET requires authentication and is no-store", async () => {
  const { draftRoute } = await loadRoutes();
  session = null;
  const response = await draftRoute.GET(request("/api/products/chat/drafts/new"), {
    params: Promise.resolve({ scopeKey: "new" }),
  });
  assert.ok(response);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
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
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await response.json()).draft.attachmentReferences, [
    { uploadId: "up_1" },
    { uploadId: "up_2" },
  ]);
});

test("an access refusal remains no-store", async () => {
  const { draftRoute } = await loadRoutes();
  accessAllowed = false;
  const response = await draftRoute.GET(request("/api/products/chat/drafts/conversation_1"), {
    params: Promise.resolve({ scopeKey: "conversation_1" }),
  });
  assert.ok(response);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("a security/rate-limit refusal is wrapped as no-store", async () => {
  const { draftRoute } = await loadRoutes();
  rateLimitRefused = true;
  const response = await draftRoute.GET(request("/api/products/chat/drafts/new"), {
    params: Promise.resolve({ scopeKey: "new" }),
  });
  assert.ok(response);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
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
    currentRevision: 4,
  });
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
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.equal(body.attempt.partialContent, "committed");
  assert.equal("fingerprint" in body.attempt, false);
  assert.equal("ownerId" in body.attempt, false);
  assert.equal("leaseExpiresAt" in body.attempt, false);
});
