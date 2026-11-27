import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ChatLocalFailure } from "../../lib/chatFailureLayer.ts";
import {
  PAST_ATTACHMENT_OMITTED_KIND,
  PAST_ATTACHMENT_UNDELIVERABLE_TEXT,
} from "../../lib/chatAttachmentLimits.ts";

/**
 * POST /api/chat when the request could not be served for a reason that is not
 * the person's question.
 *
 * Two families, both of which used to end a conversation rather than a turn:
 *
 *  A. A database that blinks before any provider is called. The route answered a
 *     500 `CHAT_APPLICATION_ERROR` with `retryable: false`; it now answers
 *     503 `DATABASE_TEMPORARILY_UNAVAILABLE` with `Retry-After`, and only when
 *     no provider call was made.
 *  B. A file on an EARLIER message that cannot be delivered. Those are re-read on
 *     every later turn, so refusing them made one stale file a permanent
 *     failure; they are named to the model as not included. The file on the
 *     message being sent is still refused, with a code instead of a bare 500.
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

const OWNER_EMAIL = "resilience-owner@tomverse.app";
const ACCOUNT_PREFIX = `attachments/${createHash("sha256")
  .update(OWNER_EMAIL.toLowerCase())
  .digest("hex")
  .slice(0, 20)}/`;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";

type StoredFile = { name: string; mediaType: string; kind: "text" | "file" };
type CapturedAttachment = { name: string; kind: string; text: string };

type World = {
  session: { user: { id: string; email: string } } | null;
  files: Map<string, StoredFile>;
  /** What the reservation seam does: stop the suite there, grant, or fail. */
  acquire: "stop" | "grant" | { throws: unknown };
  /** Thrown by the dispatch bookkeeping that runs after a reservation exists. */
  dispatchError: unknown | null;
  /** Thrown by `streamText`, i.e. after a provider call has begun. */
  providerError: unknown | null;
  officeBehavior: "ok" | "timeout" | { throws: unknown };
  budgets: unknown[];
  prompts: CapturedAttachment[][];
  settled: Array<{ outcome: unknown }>;
  releasedLeases: number;
  streamTextCalls: number;
  providerFailures: string[];
  modelFailures: string[];
};

const freshWorld = (): World => ({
  session: { user: { id: "user-resilience-owner", email: OWNER_EMAIL } },
  files: new Map(),
  acquire: "stop",
  dispatchError: null,
  providerError: null,
  officeBehavior: "ok",
  budgets: [],
  prompts: [],
  settled: [],
  releasedLeases: 0,
  streamTextCalls: 0,
  providerFailures: [],
  modelFailures: [],
});

let world = freshWorld();
let installed = false;

class FakeNotFound extends Error {
  readonly $metadata = { httpStatusCode: 404 };
  constructor() {
    super("NotFound");
    this.name = "NotFound";
  }
}

const transactionStartFailure = () =>
  new Prisma.PrismaClientKnownRequestError(
    "Transaction API error: Unable to start a transaction in the given time.",
    { code: "P2028", clientVersion: "test" }
  );
const transactionExpired = () =>
  new Prisma.PrismaClientKnownRequestError(
    "Transaction API error: A commit cannot be executed on an expired transaction.",
    { code: "P2028", clientVersion: "test" }
  );
const connectionClosed = () =>
  Object.assign(new Error("connection closed"), {
    name: "DriverAdapterError",
    cause: { kind: "ConnectionClosed" },
  });

async function loadRoute(): Promise<{ POST: (req: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    const original = (path: string) => require(resolve(ROOT, path)) as Record<string, unknown>;

    const model = () =>
      new Proxy(
        {},
        {
          get(_target, property: string) {
            return async () => {
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
                  typeof arg === "function" ? (arg as (tx: unknown) => unknown)(model()) : [];
              }
              if (name === "$queryRaw" || name === "$executeRaw") return async () => [];
              if (name === "$disconnect") return async () => undefined;
              return model();
            },
          }
        ),
      },
    });
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => world.session },
    });

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

    const realStorage = original("lib/messageAttachmentStorage.ts");
    mock.module(mod("lib/messageAttachmentStorage.ts"), {
      namedExports: {
        ...realStorage,
        resolveMessageAttachmentReferences: async (input: {
          references: Array<{ attachmentId?: string }>;
        }) =>
          input.references.map((reference) => {
            const id = reference.attachmentId!;
            const file = world.files.get(id);
            if (!file) throw new Error(`test row missing for ${id}`);
            return {
              attachmentId: id,
              uploadId: null,
              name: file.name,
              mediaType: file.mediaType,
              size: 29,
              kind: file.kind,
              objectKey: `${ACCOUNT_PREFIX}${id}`,
              unavailableAt: null,
              unavailableReason: null,
            };
          }),
        markMessageAttachmentUnavailable: async () => true,
      },
    });

    const realR2 = original("lib/r2.ts");
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        ...realR2,
        readR2Object: async (key: string) => {
          if (key.startsWith("guest-attachments/")) {
            const storageErrors = original("lib/storageObjectErrors.ts") as {
              toStorageError: (operation: string, error: unknown) => Error;
            };
            throw storageErrors.toStorageError("head", new FakeNotFound());
          }
          const id = key.slice(ACCOUNT_PREFIX.length);
          const file = world.files.get(id);
          if (file?.mediaType === "image/png") return Buffer.from(ONE_PIXEL_PNG, "base64");
          return Buffer.from(`body of ${id}\n`, "utf8");
        },
      },
    });

    // The parser is what times out in production; its failure is injected here
    // so the route's reaction is what is under test, not a worker thread.
    const realOffice = original("lib/officeSecurity.ts");
    mock.module(mod("lib/officeSecurity.ts"), {
      namedExports: {
        ...realOffice,
        parseOfficeSafely: async () => {
          if (world.officeBehavior === "timeout") throw new Error("Office parsing timed out.");
          if (typeof world.officeBehavior === "object") throw world.officeBehavior.throws;
          return "text of the document";
        },
      },
    });

    // Observation of what the model would be told about each message's files.
    const realPrompt = original("lib/attachmentContextPrompt.ts") as {
      buildAttachmentPromptText: (input: {
        userText: string;
        attachments: CapturedAttachment[];
      }) => string;
    };
    mock.module(mod("lib/attachmentContextPrompt.ts"), {
      namedExports: {
        ...realPrompt,
        buildAttachmentPromptText: (input: {
          userText: string;
          attachments: CapturedAttachment[];
        }) => {
          world.prompts.push(
            input.attachments.map(({ name, kind, text }) => ({ name, kind, text }))
          );
          return realPrompt.buildAttachmentPromptText(input);
        },
      },
    });

    mock.module("ai", {
      namedExports: {
        stepCountIs: () => undefined,
        streamText: () => {
          world.streamTextCalls += 1;
          throw world.providerError ?? new Error("this suite never completes a provider call");
        },
      },
    });

    const realChatSecurity = original("lib/chatSecurity.ts");
    mock.module(mod("lib/chatSecurity.ts"), {
      namedExports: {
        ...realChatSecurity,
        acquireChatAccess: async (_access: unknown, budget: unknown) => {
          world.budgets.push(budget);
          if (world.acquire === "stop") throw new Error("this suite stops at the credit reservation");
          if (world.acquire === "grant") {
            return {
              leaseId: "lease-resilience",
              setCookie: undefined,
              usageReservation: { reservationId: "reservation-resilience" },
            };
          }
          throw world.acquire.throws;
        },
        settleChatUsage: async (_reservation: unknown, settlement: { outcome?: unknown }) => {
          world.settled.push({ outcome: settlement?.outcome });
        },
        releaseChatAccess: async () => {
          world.releasedLeases += 1;
        },
      },
    });

    const realDispatch = original("lib/routingDispatchInstrumentation.ts") as {
      beginInstrumentedDispatch: (input: unknown) => Promise<unknown>;
    };
    mock.module(mod("lib/routingDispatchInstrumentation.ts"), {
      namedExports: {
        ...realDispatch,
        beginInstrumentedDispatch: async (input: unknown) => {
          if (world.dispatchError) throw world.dispatchError;
          return realDispatch.beginInstrumentedDispatch(input);
        },
      },
    });

    const realMonitoring = original("lib/providerMonitoring.ts");
    mock.module(mod("lib/providerMonitoring.ts"), {
      namedExports: {
        ...realMonitoring,
        recordProviderFailure: async (_provider: unknown, code: string) => {
          world.providerFailures.push(code);
        },
        recordModelFailure: async (_modelId: unknown, _provider: unknown, code: string) => {
          world.modelFailures.push(code);
        },
      },
    });

    const realTurnstile = original("lib/turnstile.ts");
    mock.module(mod("lib/turnstile.ts"), {
      namedExports: { ...realTurnstile, ensureGuestVerified: async () => undefined },
    });
  }
  return (await import(`${mod("app/api/chat/route.ts")}?resilience=cached`)) as {
    POST: (req: Request) => Promise<Response>;
  };
}

const send = async (
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ response: Response; payload: { code?: string; error?: string; details?: Record<string, unknown> } }> => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
  const payload = (await response.clone().json().catch(() => ({}))) as {
    code?: string;
    error?: string;
    details?: Record<string, unknown>;
  };
  return { response, payload };
};

const attachmentRef = (id: string, file: StoredFile) => ({
  id,
  attachmentId: id,
  name: file.name,
  mediaType: file.mediaType,
  size: 29,
  kind: file.kind,
});

/** An earlier message carrying `ids`, then this turn's plain question. */
const pastTurn = (ids: string[]) => [
  {
    role: "user",
    content: "Here are my files.",
    attachments: ids.map((id) => attachmentRef(id, world.files.get(id)!)),
  },
  { role: "assistant", content: "Thanks." },
  { role: "user", content: "What did it say?" },
];

/** The message being sent carries `ids`. */
const latestTurn = (ids: string[]) => [
  {
    role: "user",
    content: "What is in these?",
    attachments: ids.map((id) => attachmentRef(id, world.files.get(id)!)),
  },
];

const png = (name = "photo.png"): StoredFile => ({ name, mediaType: "image/png", kind: "file" });
const docx = (name = "report.docx"): StoredFile => ({ name, mediaType: DOCX, kind: "file" });
const txt = (name = "notes.txt"): StoredFile => ({ name, mediaType: "text/plain", kind: "text" });

/** A model with no image input, so an image cannot be delivered to it. */
const TEXT_ONLY_MODEL = "deepseek-v4-flash";

const assertNoProviderBlamed = (context: string) => {
  assert.deepEqual(world.providerFailures, [], `${context}: provider health was told`);
  assert.deepEqual(world.modelFailures, [], `${context}: model health was told`);
};

/* -------------------------------------------------------------------------- */
/* A. a database that blinks before any provider is called                     */
/* -------------------------------------------------------------------------- */

test("a transaction that could not start is a 503 with Retry-After, not a 500", async () => {
  world = freshWorld();
  world.acquire = { throws: transactionStartFailure() };

  const { response, payload } = await send({
    messages: [{ role: "user", content: "hello" }],
    modelId: "gpt-5-4-mini",
  });

  assert.equal(response.status, 503);
  assert.equal(payload.code, "DATABASE_TEMPORARILY_UNAVAILABLE");
  assert.equal(response.headers.get("Retry-After"), "2");
  assert.equal(payload.details?.retryAfterSeconds, 2);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.ok(response.headers.get("X-Request-ID"), "the trace is returned");
  assert.equal(world.streamTextCalls, 0);
  assertNoProviderBlamed("reservation transaction could not start");
});

test("a connection lost after the reservation exists releases it and is still a 503", async () => {
  world = freshWorld();
  world.acquire = "grant";
  world.dispatchError = connectionClosed();

  const { response, payload } = await send({
    messages: [{ role: "user", content: "hello" }],
    modelId: "gpt-5-4-mini",
  });

  assert.equal(response.status, 503);
  assert.equal(payload.code, "DATABASE_TEMPORARILY_UNAVAILABLE");
  assert.equal(response.headers.get("Retry-After"), "2");
  // The credits held for a request that never reached a provider go back, once.
  assert.deepEqual(world.settled, [{ outcome: "failed" }]);
  assert.equal(world.releasedLeases, 1, "the concurrency slot is released");
  assert.equal(world.streamTextCalls, 0);
  assertNoProviderBlamed("database error after reservation");
});

test("a retryable database error wrapped as a local failure is a 503 too", async () => {
  world = freshWorld();
  world.acquire = {
    throws: new ChatLocalFailure("application", "persistence", "CHAT_APPLICATION_FAILED", {
      cause: connectionClosed(),
    }),
  };

  const { response, payload } = await send({
    messages: [{ role: "user", content: "hello" }],
    modelId: "gpt-5-4-mini",
  });

  assert.equal(response.status, 503);
  assert.equal(payload.code, "DATABASE_TEMPORARILY_UNAVAILABLE");
});

test("a failure with no database cause keeps its 500 and its non-retryable code", async () => {
  world = freshWorld();
  world.acquire = { throws: new Error("a bug in preparation") };

  const { response, payload } = await send({
    messages: [{ role: "user", content: "hello" }],
    modelId: "gpt-5-4-mini",
  });

  assert.equal(response.status, 500);
  assert.equal(payload.code, "CHAT_APPLICATION_ERROR");
  assert.equal(response.headers.get("Retry-After"), null);
});

test("an expired transaction is a write whose outcome is unknown, so it is not advertised as retryable", async () => {
  world = freshWorld();
  world.acquire = { throws: transactionExpired() };

  const { response, payload } = await send({
    messages: [{ role: "user", content: "hello" }],
    modelId: "gpt-5-4-mini",
  });

  assert.equal(response.status, 500);
  assert.equal(payload.code, "CHAT_APPLICATION_ERROR");
  assert.equal(response.headers.get("Retry-After"), null);
});

test("a database-looking error after a provider call began is never offered as a retry", async () => {
  world = freshWorld();
  world.acquire = "grant";
  world.providerError = connectionClosed();

  const { response, payload } = await send({
    messages: [{ role: "user", content: "hello" }],
    modelId: "gpt-5-4-mini",
  });

  // Re-sending after a provider was reached could be paid for twice.
  assert.equal(world.streamTextCalls, 1, "the provider call was attempted");
  assert.notEqual(payload.code, "DATABASE_TEMPORARILY_UNAVAILABLE");
  assert.notEqual(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), null);
});

/* -------------------------------------------------------------------------- */
/* B. a file that cannot be delivered                                          */
/* -------------------------------------------------------------------------- */

test("an earlier image on a model that cannot read images no longer ends the conversation", async () => {
  world = freshWorld();
  world.files.set("pastimg1", png());

  const { response, payload } = await send({
    messages: pastTurn(["pastimg1"]),
    modelId: TEXT_ONLY_MODEL,
  });

  assert.notEqual(payload.code, "ATTACHMENT_MODEL_UNSUPPORTED", `${response.status}`);
  assert.equal(world.budgets.length, 1, "the turn got as far as pricing");
  assert.deepEqual(world.prompts[0], [
    { name: "photo.png", kind: PAST_ATTACHMENT_OMITTED_KIND, text: PAST_ATTACHMENT_UNDELIVERABLE_TEXT },
  ]);
});

test("the image on the message being sent is still refused, with its own code", async () => {
  world = freshWorld();
  world.files.set("latestimg1", png());

  const { response, payload } = await send({
    messages: latestTurn(["latestimg1"]),
    modelId: TEXT_ONLY_MODEL,
  });

  assert.equal(response.status, 400);
  assert.equal(payload.code, "ATTACHMENT_MODEL_UNSUPPORTED");
  assert.equal(world.budgets.length, 0, "nothing was priced");
});

test("an earlier document whose parser timed out is left out and the turn goes on", async () => {
  world = freshWorld();
  world.files.set("pastdoc1", docx());
  world.officeBehavior = "timeout";

  await send({ messages: pastTurn(["pastdoc1"]), modelId: "gpt-5-4-mini" });

  // Reaching the reservation seam is the proof the parser failure did not end
  // the turn: it used to leave as a bare 500 before pricing.
  assert.equal(world.budgets.length, 1, "the turn got as far as pricing");
  assert.deepEqual(world.prompts[0], [
    { name: "report.docx", kind: PAST_ATTACHMENT_OMITTED_KIND, text: PAST_ATTACHMENT_UNDELIVERABLE_TEXT },
  ]);
});

test("the document on the message being sent fails with a code instead of a bare 500", async () => {
  world = freshWorld();
  world.files.set("latestdoc1", docx());
  world.officeBehavior = "timeout";

  const { response, payload } = await send({
    messages: latestTurn(["latestdoc1"]),
    modelId: "gpt-5-4-mini",
  });

  assert.equal(response.status, 400);
  assert.equal(payload.code, "ATTACHMENT_UNREADABLE");
  assert.equal(world.budgets.length, 0, "nothing was priced");
  assertNoProviderBlamed("unreadable current document");
});

test("one earlier file that cannot be read does not take the readable one beside it", async () => {
  world = freshWorld();
  world.files.set("pastdoc2", docx());
  world.files.set("pasttxt2", txt());
  world.officeBehavior = "timeout";

  await send({ messages: pastTurn(["pastdoc2", "pasttxt2"]), modelId: "gpt-5-4-mini" });

  assert.equal(world.budgets.length, 1);
  const [attachments] = world.prompts;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].kind, PAST_ATTACHMENT_OMITTED_KIND);
  assert.equal(attachments[0].name, "report.docx");
  assert.equal(attachments[1].name, "notes.txt");
  assert.ok(attachments[1].text.includes("body of pasttxt2"), "the readable file is delivered");
});

test("a database fault while reading an earlier file is not hidden as an unreadable file", async () => {
  world = freshWorld();
  world.files.set("pastdoc3", docx());
  world.officeBehavior = { throws: connectionClosed() };

  const { response, payload } = await send({
    messages: pastTurn(["pastdoc3"]),
    modelId: "gpt-5-4-mini",
  });

  assert.equal(response.status, 503);
  assert.equal(payload.code, "DATABASE_TEMPORARILY_UNAVAILABLE");
  assert.equal(world.budgets.length, 0);
});

/* The guest path: an earlier file the TTL sweep took. */

const guestCookieAndKey = () => {
  const security = require(resolve(ROOT, "lib/chatSecurity.ts")) as {
    identifyChatCaller: (request: Request, userId?: string | null) => { subjectKey: string; setCookie?: string };
  };
  const guests = require(resolve(ROOT, "lib/guestAttachments.ts")) as {
    createGuestAttachmentKey: (subjectKey: string, secret: string, objectId: string) => string;
  };
  const caller = security.identifyChatCaller(new Request("http://127.0.0.1:3100/api/chat"), null);
  const cookie = caller.setCookie!.split(";")[0];
  return {
    cookie,
    objectKey: guests.createGuestAttachmentKey(
      caller.subjectKey,
      process.env.NEXTAUTH_SECRET as string,
      "a".repeat(40)
    ),
  };
};

test("a guest's earlier file the sweep took is named as gone and the turn goes on", async () => {
  world = freshWorld();
  world.session = null;
  const { cookie, objectKey } = guestCookieAndKey();
  const guestFile = { name: "notes.txt", mediaType: "text/plain", kind: "text", objectKey };

  const { payload } = await send(
    {
      messages: [
        { role: "user", content: "Here is a file.", attachments: [guestFile] },
        { role: "assistant", content: "Thanks." },
        { role: "user", content: "What did it say?" },
      ],
      modelId: "claude-haiku-4-5",
    },
    { cookie }
  );

  assert.notEqual(payload.code, "GUEST_ATTACHMENT_EXPIRED");
  assert.equal(world.budgets.length, 1, "the turn got as far as pricing");
  assert.equal(world.prompts[0][0].kind, "unavailable file");
  assert.ok(world.prompts[0][0].text.includes("was NOT read"));
});

test("a guest's file on the message being sent is still refused as expired", async () => {
  world = freshWorld();
  world.session = null;
  const { cookie, objectKey } = guestCookieAndKey();

  const { response, payload } = await send(
    {
      messages: [
        {
          role: "user",
          content: "Read this.",
          attachments: [{ name: "notes.txt", mediaType: "text/plain", kind: "text", objectKey }],
        },
      ],
      modelId: "claude-haiku-4-5",
    },
    { cookie }
  );

  assert.equal(response.status, 410);
  assert.equal(payload.code, "GUEST_ATTACHMENT_EXPIRED");
  assert.equal(world.budgets.length, 0);
});
