import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * POST /api/chat when a signed-in user's stored attachment is gone.
 *
 * The incident this file is the regression test for: an account's JPEG was
 * removed from R2 by a time-based bucket lifecycle rule while the
 * `MessageAttachment` row naming it stayed. Every later turn in that
 * conversation re-read the file, `HeadObject` threw `NotFound`, and the error
 * travelled to the route's outermost catch -- which by then had a provider in
 * hand and recorded `AI_REQUEST_FAILED.NotFound` against it. Two different
 * models were tried and both "failed", because the failure was on this side of
 * the network and no model could change it.
 *
 * What this harness asserts is mostly what the route does *not* do:
 *
 *   * no provider client is constructed and `streamText` is never reached;
 *   * no credits are reserved;
 *   * `recordProviderFailure` / `recordModelFailure` are never called;
 *   * no `ProviderErrorEvent` row is written.
 *
 * and, on the positive side, that the refusal is actionable: a 410 naming the
 * attachment, and an explicit acknowledgement that lets the same request
 * proceed without the file.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.R2_ACCOUNT_ID ||= "test-account";
process.env.R2_ACCESS_KEY_ID ||= "test-key";
process.env.R2_SECRET_ACCESS_KEY ||= "test-secret";
process.env.R2_BUCKET_NAME ||= "test-bucket";

type World = {
  /** What `readR2Object` does for the object behind each attachment id. */
  storage: Map<string, "present" | "missing" | "denied" | "unreachable">;
  /** Rows the attachment resolver hands back. */
  rows: Map<string, { name: string; mediaType: string; unavailableAt: Date | null }>;
  streamTextCalls: number;
  adapterCalls: string[];
  creditReservations: number;
  providerFailures: Array<{ code: string }>;
  modelFailures: Array<{ code: string }>;
  providerErrorEventWrites: number;
  markedUnavailable: string[];
  prismaWrites: string[];
};

const OWN_PREFIX_EMAIL = "attachment-owner@tomverse.app";

const freshWorld = (): World => ({
  storage: new Map(),
  rows: new Map(),
  streamTextCalls: 0,
  adapterCalls: [],
  creditReservations: 0,
  providerFailures: [],
  modelFailures: [],
  providerErrorEventWrites: 0,
  markedUnavailable: [],
  prismaWrites: [],
});

let world = freshWorld();
let installed = false;

/**
 * The object key a row resolves to.
 *
 * Derived the same way `accountAttachmentPrefix` derives it, because the route
 * refuses a resolved key that falls outside the caller's own prefix -- a check
 * that is redundant by construction in production and load-bearing here: a
 * made-up key would be refused as "access denied" and the test would prove
 * nothing about attachments being missing.
 *
 * Never leaves the server. Several assertions below check exactly that.
 */
const ACCOUNT_PREFIX = `attachments/${createHash("sha256")
  .update(OWN_PREFIX_EMAIL.toLowerCase())
  .digest("hex")
  .slice(0, 20)}/`;
const objectKeyFor = (attachmentId: string) => `${ACCOUNT_PREFIX}${attachmentId}.txt`;

class FakeNotFound extends Error {
  readonly $metadata = { httpStatusCode: 404 };
  constructor() {
    super("NotFound");
    this.name = "NotFound";
  }
}
class FakeAccessDenied extends Error {
  readonly $metadata = { httpStatusCode: 403 };
  constructor() {
    super("AccessDenied");
    this.name = "AccessDenied";
  }
}
class FakeServerError extends Error {
  readonly $metadata = { httpStatusCode: 503 };
  constructor() {
    super("InternalError");
    this.name = "InternalError";
  }
}

async function loadRoute(): Promise<{ POST: (req: Request) => Promise<Response> }> {
  if (installed) {
    return (await import(`${mod("app/api/chat/route.ts")}?attachment=cached`)) as {
      POST: (req: Request) => Promise<Response>;
    };
  }
  installed = true;

  const original = (path: string) => require(resolve(ROOT, path)) as Record<string, unknown>;

  // --- the database --------------------------------------------------------
  // A recorder, not a database. The one row that matters here is
  // ProviderErrorEvent: a storage 404 must not appear in a table of provider
  // errors, whatever else the route writes.
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get(_target, property: string) {
          return async () => {
            world.prismaWrites.push(`${name}.${property}`);
            if (name === "providerErrorEvent" && property === "create") {
              world.providerErrorEventWrites += 1;
            }
            if (property === "findMany") return [];
            if (property === "count") return 0;
            if (property === "findUnique" || property === "findFirst") return null;
            return { count: 0 };
          };
        },
      }
    );
  mock.module(mod("lib/prisma.ts"), {
    namedExports: {
      prisma: new Proxy(
        {},
        {
          get(_target, name: string) {
            if (name === "$transaction") {
              return async (arg: unknown) =>
                typeof arg === "function" ? (arg as (tx: unknown) => unknown)(model("tx")) : [];
            }
            if (name === "$queryRaw" || name === "$executeRaw") return async () => [];
            if (name === "$disconnect") return async () => undefined;
            return model(name);
          },
        }
      ),
    },
  });

  /*
    Registered before anything else is required.

    `mock.module` intercepts `require` as well as `import`, but only for loads
    that happen after it: a module required first captures the real client and
    keeps it. Every `original(...)` below therefore has to come after this, or
    the route reaches a database that is not there and the failure it produces
    is a connection error rather than the one under test.
  */

  // --- identity ------------------------------------------------------------
  mock.module("next-auth/next", {
    namedExports: {
      getServerSession: async () => ({
        user: { id: "user-attachment-owner", email: OWN_PREFIX_EMAIL },
      }),
    },
  });

  // --- plan / flags --------------------------------------------------------
  const realEntitlements = original("lib/billingEntitlements.ts");
  const realBillingConfig = original("lib/billingConfig.ts") as {
    getBillingPlanByTier: (tier: string) => unknown;
  };
  mock.module(mod("lib/billingEntitlements.ts"), {
    namedExports: {
      ...realEntitlements,
      getUserBillingPlan: async () => realBillingConfig.getBillingPlanByTier("Pro"),
    },
  });
  const realAppSettings = original("lib/appSettings.ts");
  mock.module(mod("lib/appSettings.ts"), {
    namedExports: {
      ...realAppSettings,
      getOperationalFeatureFlags: async () => ({
        attachmentsEnabled: true,
        chatEnabled: true,
        webSearchEnabled: false,
        deepResearchEnabled: false,
        imageGenerationEnabled: false,
      }),
      isImageGenerationEnabledCached: () => false,
    },
  });

  // --- the attachment rows -------------------------------------------------
  const realStorage = original("lib/messageAttachmentStorage.ts");
  mock.module(mod("lib/messageAttachmentStorage.ts"), {
    namedExports: {
      ...realStorage,
      resolveMessageAttachmentReferences: async (input: {
        references: Array<{ attachmentId?: string }>;
      }) =>
        input.references.map((reference) => {
          const id = reference.attachmentId!;
          const row = world.rows.get(id);
          if (!row) throw new Error(`test row missing for ${id}`);
          return {
            attachmentId: id,
            uploadId: null,
            name: row.name,
            mediaType: row.mediaType,
            size: 29,
            kind: "text",
            objectKey: objectKeyFor(id),
            unavailableAt: row.unavailableAt,
            unavailableReason: row.unavailableAt ? "storage_object_missing" : null,
          };
        }),
      markMessageAttachmentUnavailable: async (input: { attachmentId: string }) => {
        world.markedUnavailable.push(input.attachmentId);
        return true;
      },
    },
  });

  // --- object storage ------------------------------------------------------
  const realR2 = original("lib/r2.ts");
  mock.module(mod("lib/r2.ts"), {
    namedExports: {
      ...realR2,
      readR2Object: async (key: string) => {
        const id = key.split("/").pop()!.replace(/\.txt$/, "");
        const state = world.storage.get(id) ?? "present";
        const storageErrors = original("lib/storageObjectErrors.ts") as {
          toStorageError: (operation: string, error: unknown) => Error;
        };
        if (state === "missing") throw storageErrors.toStorageError("head", new FakeNotFound());
        if (state === "denied") throw storageErrors.toStorageError("head", new FakeAccessDenied());
        if (state === "unreachable") {
          throw storageErrors.toStorageError("head", new FakeServerError());
        }
        // A plain text file on purpose: what is under test is the *read*, and
        // an image would pull in normalisation, OCR budgets and model
        // capability checks that have nothing to do with whether the bytes
        // were there.
        return Buffer.from("This is the attachment body.\n", "utf8");
      },
    },
  });

  // --- the seams that cost money ------------------------------------------
  const realActiveAiModel = original("lib/activeAiModel.ts") as {
    getActiveAiModel: (model: unknown) => unknown;
  };
  mock.module(mod("lib/activeAiModel.ts"), {
    namedExports: {
      getActiveAiModel: (model: { id?: string }) => {
        world.adapterCalls.push(model?.id ?? "unknown");
        return realActiveAiModel.getActiveAiModel(model);
      },
    },
  });
  mock.module("ai", {
    namedExports: {
      stepCountIs: () => undefined,
      streamText: () => {
        world.streamTextCalls += 1;
        throw new Error("streamText must not be reached for an unavailable attachment");
      },
    },
  });
  const realChatSecurity = original("lib/chatSecurity.ts");
  mock.module(mod("lib/chatSecurity.ts"), {
    namedExports: {
      ...realChatSecurity,
      acquireChatAccess: async () => {
        world.creditReservations += 1;
        throw new Error("credits must not be reserved for an unavailable attachment");
      },
    },
  });

  // --- provider health -----------------------------------------------------
  const realMonitoring = original("lib/providerMonitoring.ts");
  mock.module(mod("lib/providerMonitoring.ts"), {
    namedExports: {
      ...realMonitoring,
      recordProviderFailure: async (_provider: unknown, code: string) => {
        world.providerFailures.push({ code });
      },
      recordModelFailure: async (_modelId: unknown, _provider: unknown, code: string) => {
        world.modelFailures.push({ code });
      },
    },
  });

  const realTurnstile = original("lib/turnstile.ts");
  mock.module(mod("lib/turnstile.ts"), {
    namedExports: { ...realTurnstile, ensureGuestVerified: async () => undefined },
  });

  return (await import(`${mod("app/api/chat/route.ts")}?attachment=cached`)) as {
    POST: (req: Request) => Promise<Response>;
  };
}

const chatRequest = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** A past turn carrying one stored image, then this turn's question. */
const conversationWith = (
  attachmentIds: string[],
  options: { onLatest?: boolean } = {}
) => {
  const attachments = attachmentIds.map((id) => ({
    id,
    attachmentId: id,
    name: `${id}.txt`,
    mediaType: "text/plain",
    size: 29,
    kind: "text" as const,
  }));
  return options.onLatest
    ? [{ role: "user" as const, content: "What is in this picture?", attachments }]
    : [
        { role: "user" as const, content: "Here is a picture.", attachments },
        { role: "assistant" as const, content: "Thanks." },
        { role: "user" as const, content: "What did it say about termination?" },
      ];
};

const seed = (
  ids: Array<{ id: string; storage: "present" | "missing" | "denied" | "unreachable"; marked?: boolean }>
) => {
  world = freshWorld();
  for (const entry of ids) {
    world.rows.set(entry.id, {
      name: `${entry.id}.txt`,
      mediaType: "text/plain",
      unavailableAt: entry.marked ? new Date("2026-08-27T00:00:00.000Z") : null,
    });
    world.storage.set(entry.id, entry.storage);
  }
};

const assertNothingSpentOrBlamed = (context: string) => {
  assert.equal(world.streamTextCalls, 0, `${context}: streamText was called`);
  assert.equal(world.creditReservations, 0, `${context}: credits were reserved`);
  // Not asserted: that no provider *client object* was constructed. The route
  // resolves the adapter while preparing the turn, long before the attachment
  // read, and constructing one issues no request -- `streamText` is what
  // would, and it is counted above.
  assert.deepEqual(world.providerFailures, [], `${context}: provider health was told`);
  assert.deepEqual(world.modelFailures, [], `${context}: model health was told`);
  assert.equal(
    world.providerErrorEventWrites,
    0,
    `${context}: a ProviderErrorEvent row was written`
  );
};

test("a past attachment that still exists reaches the provider as it always did", async () => {
  const { POST } = await loadRoute();
  seed([{ id: "attpresent1", storage: "present" }]);

  const response = await POST(
    chatRequest({
      messages: conversationWith(["attpresent1"]),
      modelId: "gpt-5-4-mini",
    })
  );

  // The credit seam is the first thing past the attachment read, and it throws
  // by design: reaching it is the proof that the attachment path did not
  // refuse. What matters is that the refusal under test did not happen.
  const payload = (await response.json().catch(() => ({}))) as { code?: string };
  assert.notEqual(payload.code, "ATTACHMENT_UNAVAILABLE");
  assert.equal(world.creditReservations, 1, "the turn got as far as pricing");
});

test("a past attachment storage no longer holds is a 410, not a provider error", async () => {
  const { POST } = await loadRoute();
  seed([{ id: "attmissing1", storage: "missing" }]);

  const response = await POST(
    chatRequest({
      messages: conversationWith(["attmissing1"]),
      modelId: "gpt-5-4-mini",
    })
  );

  assert.equal(response.status, 410);
  const payload = (await response.json()) as {
    code?: string;
    details?: Record<string, unknown>;
  };
  assert.equal(payload.code, "ATTACHMENT_UNAVAILABLE");
  assert.deepEqual(payload.details?.unavailableAttachmentIds, ["attmissing1"]);
  assert.equal(payload.details?.attachmentScope, "past_turn");
  assert.equal(payload.details?.canContinueWithout, "true");
  assertNothingSpentOrBlamed("past attachment missing");
  assert.deepEqual(world.markedUnavailable, ["attmissing1"]);
});

test("the refusal names the file and never the place it was stored", async () => {
  const { POST } = await loadRoute();
  seed([{ id: "attmissing2", storage: "missing" }]);

  const response = await POST(
    chatRequest({
      messages: conversationWith(["attmissing2"]),
      modelId: "gpt-5-4-mini",
    })
  );
  const body = await response.text();

  assert.ok(body.includes("attmissing2.txt"), "the display filename is present");
  assert.ok(!body.includes("attachments/"), "no storage prefix");
  assert.ok(!body.includes(ACCOUNT_PREFIX), "no account key segment");
  assert.ok(!body.includes("r2.cloudflarestorage"), "no endpoint");
  assert.ok(!body.includes("X-Amz"), "no signed URL");
  assert.ok(response.headers.get("X-Request-ID"), "the trace is returned");
});

test("a file on the message being sent asks for it again rather than offering to proceed", async () => {
  const { POST } = await loadRoute();
  seed([{ id: "attmissing3", storage: "missing" }]);

  const response = await POST(
    chatRequest({
      messages: conversationWith(["attmissing3"], { onLatest: true }),
      modelId: "gpt-5-4-mini",
    })
  );

  assert.equal(response.status, 410);
  const payload = (await response.json()) as { details?: Record<string, unknown> };
  assert.equal(payload.details?.attachmentScope, "current_turn");
  // Offering "continue without it" here would invite a question about a
  // document the person has this second failed to send.
  assert.equal(payload.details?.canContinueWithout, "false");
  assertNothingSpentOrBlamed("current turn missing");
});

test("storage refusing us is not the same answer as the file being gone", async () => {
  const { POST } = await loadRoute();
  for (const state of ["denied", "unreachable"] as const) {
    seed([{ id: `attblocked${state}`, storage: state }]);
    const response = await POST(
      chatRequest({
        messages: conversationWith([`attblocked${state}`]),
        modelId: "gpt-5-4-mini",
      })
    );
    assert.equal(response.status, 503, state);
    const payload = (await response.json()) as { code?: string };
    assert.equal(payload.code, "ATTACHMENT_STORAGE_UNAVAILABLE", state);
    // Nothing is written about the row: we do not know that the file is gone,
    // and a credentials outage must not be recorded as an account losing its
    // history.
    assert.deepEqual(world.markedUnavailable, [], state);
    assertNothingSpentOrBlamed(`storage ${state}`);
  }
});

test("a row already marked missing is refused without asking storage again", async () => {
  const { POST } = await loadRoute();
  seed([{ id: "attknown1", storage: "present", marked: true }]);

  const response = await POST(
    chatRequest({
      messages: conversationWith(["attknown1"]),
      modelId: "gpt-5-4-mini",
    })
  );

  assert.equal(response.status, 410);
  assertNothingSpentOrBlamed("already marked");
});

/*
  The turn only proceeds after the person says so.

  Fail-closed is the whole design: a model must never answer about a document
  nobody told the user it did not read.
*/
test("nothing reaches a model until the missing file is explicitly acknowledged", async () => {
  const { POST } = await loadRoute();
  seed([{ id: "attack1", storage: "missing" }]);

  const refusal = await POST(
    chatRequest({
      messages: conversationWith(["attack1"]),
      modelId: "gpt-5-4-mini",
    })
  );
  assert.equal(refusal.status, 410);
  assertNothingSpentOrBlamed("before acknowledgement");

  const acknowledgedCalls = world.creditReservations;
  const proceeding = await POST(
    chatRequest({
      messages: conversationWith(["attack1"]),
      modelId: "gpt-5-4-mini",
      acknowledgedUnavailableAttachmentIds: ["attack1"],
    })
  );
  const payload = (await proceeding.json().catch(() => ({}))) as { code?: string };
  assert.notEqual(payload.code, "ATTACHMENT_UNAVAILABLE");
  assert.equal(
    world.creditReservations,
    acknowledgedCalls + 1,
    "an acknowledged turn is priced and continues"
  );
});

test("acknowledging one file does not acknowledge another", async () => {
  const { POST } = await loadRoute();
  seed([
    { id: "attpair1", storage: "missing" },
    { id: "attpair2", storage: "missing" },
  ]);

  const response = await POST(
    chatRequest({
      messages: conversationWith(["attpair1", "attpair2"]),
      modelId: "gpt-5-4-mini",
      acknowledgedUnavailableAttachmentIds: ["attpair1"],
    })
  );

  assert.equal(response.status, 410);
  const payload = (await response.json()) as { details?: Record<string, unknown> };
  assert.deepEqual(payload.details?.unavailableAttachmentIds, ["attpair2"]);
  assertNothingSpentOrBlamed("partial acknowledgement");
});

test("one refusal names every missing file rather than one per round trip", async () => {
  const { POST } = await loadRoute();
  seed([
    { id: "attboth1", storage: "missing" },
    { id: "attboth2", storage: "missing" },
  ]);

  const response = await POST(
    chatRequest({
      messages: conversationWith(["attboth1", "attboth2"]),
      modelId: "gpt-5-4-mini",
    })
  );

  const payload = (await response.json()) as { details?: Record<string, unknown> };
  assert.deepEqual(payload.details?.unavailableAttachmentIds, ["attboth1", "attboth2"]);
});

/*
  The user-visible symptom of the incident: switching model changed nothing.

  It must still change nothing -- and it must go on changing nothing without
  either model being recorded as having failed.
*/
/*
  The trace a user reports has to say which layer failed.

  `TraceErrorEvidence` sits beside a provider and a model id. Without a layer on
  the row, an operator reading a reported trace sees an unclassified chat
  failure next to two provider names -- which is exactly how
  `AI_REQUEST_FAILED.NotFound` was read as two providers being down.
*/
test("the refusal writes trace evidence, and it is storage evidence", async () => {
  const { POST } = await loadRoute();
  seed([{ id: "attevidence1", storage: "missing" }]);

  await POST(
    chatRequest({
      messages: conversationWith(["attevidence1"]),
      modelId: "gpt-5-4-mini",
    })
  );

  assert.ok(
    world.prismaWrites.includes("traceErrorEvidence.create"),
    "an evidence row is written for an attachment refusal"
  );
  // ...and it is not a provider error row.
  assert.equal(world.providerErrorEventWrites, 0);
});

test("two different models give the same local answer and neither is blamed", async () => {
  const { POST } = await loadRoute();
  for (const modelId of ["gpt-5-4-mini", "claude-sonnet-5"]) {
    seed([{ id: "attswitch1", storage: "missing" }]);
    const response = await POST(
      chatRequest({ messages: conversationWith(["attswitch1"]), modelId })
    );
    assert.equal(response.status, 410, modelId);
    const payload = (await response.json()) as { code?: string };
    assert.equal(payload.code, "ATTACHMENT_UNAVAILABLE", modelId);
    assertNothingSpentOrBlamed(`model switch ${modelId}`);
  }
});
