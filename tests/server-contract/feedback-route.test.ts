import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for /api/feedback.
 *
 * What must hold:
 *   - the five-character minimum is enforced by the schema, on the *trimmed*
 *     message, exactly as the client explains it;
 *   - a guest is verified before anything is written, under this endpoint's own
 *     action, and an existing grant means no second challenge;
 *   - a signed-in caller is never asked to verify;
 *   - a stored submission is a success for the user even when the notification
 *     email fails -- the two outcomes are distinguished in the log, not in the
 *     response status;
 *   - the response carries a reference the user can quote back;
 *   - nothing that is logged contains the message body, the trace ID value, the
 *     Turnstile token, cookies or the user agent.
 *
 * Only the session, the rate limiter, Turnstile, the mailer and Prisma are
 * replaced. The zod schema and the route's own branching are the real ones.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "feedback-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.SUPPORT_NOTIFICATION_EMAIL = "support@tomverse.app";

type StoredFeedback = Record<string, unknown> & { id: string };

type World = {
  session: { user: { id: string; email?: string } } | null;
  rateLimits: string[];
  turnstile: { action: string; token: string | undefined }[];
  /** undefined = an existing grant covered it; a string = a fresh grant. */
  turnstileGrant: string | undefined;
  turnstileError: { status: number; code: string } | null;
  stored: StoredFeedback[];
  deliveries: Array<Record<string, unknown> & { id: string; inTx: boolean }>;
  lifecycleEvents: Array<Record<string, unknown> & { id: string; inTx: boolean }>;
  /** UserSettings.language for the signed-in caller, when one exists. */
  settingsLanguage: string | null;
  createShouldFail: boolean;
  emails: { to: string; subject: string; text: string; idempotencyKey?: string }[];
  emailShouldFail: boolean;
  logs: string[];
  /** True while the route's $transaction callback is running. */
  txActive: boolean;
  /** TraceErrorEvidence rows the route may link a verified report to. */
  evidenceRows: Array<{ id: string; occurrenceId: string }>;
  /** Phase 2 shadow cases created inside the submission transaction. */
  autoFixCases: Array<Record<string, unknown> & { inTx: boolean }>;
};

const freshWorld = (): World => ({
  session: null,
  rateLimits: [],
  turnstile: [],
  turnstileGrant: undefined,
  turnstileError: null,
  stored: [],
  deliveries: [],
  lifecycleEvents: [],
  settingsLanguage: null,
  createShouldFail: false,
  emails: [],
  emailShouldFail: false,
  logs: [],
  txActive: false,
  evidenceRows: [],
  autoFixCases: [],
});

let world = freshWorld();
let mocksInstalled = false;
let nextId = 0;

async function loadRoute(): Promise<{
  POST: (request: Request) => Promise<Response>;
}> {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const original = (path: string) =>
      require(resolve(ROOT, path)) as Record<string, unknown>;
    const realChatSecurity = original("lib/chatSecurity.ts") as {
      ChatAccessError: new (...args: unknown[]) => Error;
    };

    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () => world.session,
      },
    });

    const realApiSecurity = original("lib/apiSecurity.ts");
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async (
          _request: unknown,
          _subject: string,
          scope: string
        ) => {
          world.rateLimits.push(scope);
        },
      },
    });

    const realTurnstile = original("lib/turnstile.ts");
    mock.module(mod("lib/turnstile.ts"), {
      namedExports: {
        ...realTurnstile,
        ensureGuestVerified: async (
          _request: unknown,
          token: string | undefined,
          action: string
        ) => {
          world.turnstile.push({ action, token });
          if (world.turnstileError) {
            throw new realChatSecurity.ChatAccessError(
              world.turnstileError.status,
              world.turnstileError.code,
              "Verification failed."
            );
          }
          return world.turnstileGrant;
        },
      },
    });

    mock.module(mod("lib/email.ts"), {
      namedExports: {
        // Returns the real shape: the delivery path reads `skipped` to tell
        // "this deployment declined to send" apart from "the provider took it".
        sendTransactionalEmail: async ({
          to,
          subject,
          text,
          idempotencyKey,
        }: {
          to: string;
          subject: string;
          text: string;
          idempotencyKey?: string;
        }) => {
          if (world.emailShouldFail) throw new Error("mailbox unavailable");
          world.emails.push({ to, subject, text, idempotencyKey });
          return { sent: true, skipped: false, id: "qa-email" };
        },
      },
    });

    // The report and its operator-notification queue row commit together, so
    // the fake models both tables and a transaction that simply runs its
    // callback against the same client.
    const fakePrisma: Record<string, unknown> = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        world.txActive = true;
        try {
          return await fn(fakePrisma);
        } finally {
          world.txActive = false;
        }
      },
      feedback: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (world.createShouldFail) {
            throw new Error("database is unavailable");
          }
          nextId += 1;
          const record = {
            ...data,
            id: `clzfeedback000${String(nextId).padStart(4, "0")}abcd`,
            status: "open",
            createdAt: new Date("2099-01-01T00:00:00.000Z"),
          } as StoredFeedback;
          world.stored.push(record);
          return record;
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          world.stored.find((row) => row.id === where.id) ?? null,
      },
      userSettings: {
        findUnique: async () =>
          world.settingsLanguage ? { language: world.settingsLanguage } : null,
      },
      feedbackLifecycleEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          nextId += 1;
          const row = {
            id: `clzevent000${String(nextId).padStart(4, "0")}`,
            ...data,
            inTx: world.txActive,
          };
          world.lifecycleEvents.push(row);
          return row;
        },
        findUnique: async ({
          where,
        }: {
          where: { feedbackId_stage: { feedbackId: string; stage: string } };
        }) => {
          const event = world.lifecycleEvents.find(
            (row) =>
              row.feedbackId === where.feedbackId_stage.feedbackId &&
              row.stage === where.feedbackId_stage.stage
          );
          if (!event) return null;
          const feedback = world.stored.find(
            (row) => row.id === event.feedbackId
          );
          if (!feedback) return null;
          return {
            outcomeCode: event.outcomeCode ?? null,
            userReply: event.userReply ?? null,
            feedback: {
              id: feedback.id,
              type: feedback.type,
              email: feedback.email ?? null,
              emailUpdatesConsent: Boolean(feedback.emailUpdatesConsent),
              language: feedback.language ?? "en",
            },
          };
        },
      },
      notificationDelivery: {
        upsert: async ({
          create,
        }: {
          create: { kind: string; referenceId: string };
        }) => {
          const existing = world.deliveries.find(
            (row) =>
              row.kind === create.kind && row.referenceId === create.referenceId
          );
          if (existing) return { id: existing.id };
          nextId += 1;
          const row = {
            id: `clzdelivery000${String(nextId).padStart(4, "0")}`,
            ...create,
            status: "pending",
            attempts: 0,
            inTx: world.txActive,
          };
          world.deliveries.push(row);
          return { id: row.id };
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = world.deliveries.find((entry) => entry.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      },
      traceErrorEvidence: {
        findUnique: async ({
          where,
        }: {
          where: { occurrenceId: string };
        }) =>
          world.evidenceRows.find(
            (row) => row.occurrenceId === where.occurrenceId
          ) ?? null,
      },
      feedbackAutoFixCase: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          nextId += 1;
          const row = {
            id: `clzcase000${String(nextId).padStart(4, "0")}`,
            ...data,
            inTx: world.txActive,
          };
          world.autoFixCases.push(row);
          return row;
        },
      },
    };

    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: fakePrisma },
    });
  }

  return (await import(`${mod("app/api/feedback/route.ts")}?spy=cached`)) as {
    POST: (request: Request) => Promise<Response>;
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3100/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

/** Captures everything the route writes to the operational log. */
const withCapturedLogs = async <T>(run: () => Promise<T>): Promise<T> => {
  const originals = {
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const record = (...args: unknown[]) => {
    world.logs.push(args.map((value) => String(value)).join(" "));
  };
  console.info = record;
  console.warn = record;
  console.error = record;
  try {
    return await run();
  } finally {
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  }
};

test.beforeEach(() => {
  world = freshWorld();
});

// --- the minimum length -----------------------------------------------------

test("a four-character message is refused by the schema", async () => {
  const { POST } = await loadRoute();
  const response = await POST(post({ type: "bug", message: "abcd" }));

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "INVALID_REQUEST");
  assert.equal(world.stored.length, 0);
});

test("a message that is only long enough before trimming is refused", async () => {
  const { POST } = await loadRoute();
  const response = await POST(post({ type: "bug", message: "  abcd  " }));

  assert.equal(response.status, 400);
  assert.equal(world.stored.length, 0);
});

test("whitespace alone is refused", async () => {
  const { POST } = await loadRoute();
  const response = await POST(post({ type: "bug", message: "          " }));

  assert.equal(response.status, 400);
  assert.equal(world.stored.length, 0);
});

test("exactly five characters is accepted and stored trimmed", async () => {
  const { POST } = await loadRoute();
  const response = await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "  abcde  " }))
  );

  assert.equal(response.status, 200);
  assert.equal(world.stored.length, 1);
  assert.equal(world.stored[0].message, "abcde");
});

test("2,000 characters is accepted and 2,001 is not", async () => {
  const { POST } = await loadRoute();
  const atLimit = await withCapturedLogs(() =>
    POST(post({ type: "other", message: "a".repeat(2_000) }))
  );
  assert.equal(atLimit.status, 200);

  const overLimit = await POST(post({ type: "other", message: "a".repeat(2_001) }));
  assert.equal(overLimit.status, 400);
  assert.equal(world.stored.length, 1);
});

// --- trace ID ---------------------------------------------------------------

test("a submission without a trace ID is stored", async () => {
  const { POST } = await loadRoute();
  const response = await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "no trace here" }))
  );

  assert.equal(response.status, 200);
  assert.equal(world.stored[0].traceId, null);
});

test("a trace ID alone cannot carry a too-short message", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    post({ type: "bug", message: "hi", traceId: "0d1f6b1e-9a2c-4d3f" })
  );

  assert.equal(response.status, 400);
  assert.equal(world.stored.length, 0);
});

test("an over-long trace ID never costs the user their feedback text", async () => {
  // 120 is the schema's ceiling; the client truncates to it for exactly this
  // reason, and the server's refusal is a 400 rather than a silent drop.
  const { POST } = await loadRoute();
  const response = await POST(
    post({
      type: "bug",
      message: "the message the user actually wrote",
      traceId: "x".repeat(121),
    })
  );

  assert.equal(response.status, 400);
  assert.equal(world.stored.length, 0);
});

// --- guest verification -----------------------------------------------------

test("a guest is verified under this endpoint's action before anything is written", async () => {
  const { POST } = await loadRoute();
  world.turnstileGrant = "tomverse_guest_verified=abc; Path=/";
  const response = await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "guest report", turnstileToken: "tok" }))
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    world.turnstile.map((entry) => entry.action),
    ["support_request"]
  );
  assert.equal(world.turnstile[0].token, "tok");
  assert.match(
    response.headers.get("set-cookie") || "",
    /tomverse_guest_verified=/
  );
});

test("an existing grant means no fresh challenge and no new cookie", async () => {
  const { POST } = await loadRoute();
  world.turnstileGrant = undefined;
  const response = await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "guest report again" }))
  );

  assert.equal(response.status, 200);
  assert.equal(world.turnstile.length, 1);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(
    world.logs.some((line) => line.includes('"turnstile":"existing_grant"')),
    "the grant path was not classified in the log"
  );
});

test("a failed guest verification blocks the write", async () => {
  const { POST } = await loadRoute();
  world.turnstileError = { status: 403, code: "TURNSTILE_FAILED" };
  const response = await POST(post({ type: "bug", message: "guest report" }));

  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).code, "TURNSTILE_FAILED");
  assert.equal(world.stored.length, 0);
  assert.equal(world.emails.length, 0);
});

test("a signed-in caller is never asked to verify", async () => {
  const { POST } = await loadRoute();
  world.session = { user: { id: "user_1", email: "member@tomverse.app" } };
  const response = await withCapturedLogs(() =>
    POST(post({ type: "feature", message: "signed in feedback" }))
  );

  assert.equal(response.status, 200);
  assert.equal(world.turnstile.length, 0);
  assert.equal(world.stored[0].userId, "user_1");
  assert.equal(world.stored[0].email, "member@tomverse.app");
  assert.ok(world.logs.some((line) => line.includes('"turnstile":"not_required"')));
});

// --- success, and what does and does not make it a failure ------------------

test("a stored submission returns a reference the user can quote", async () => {
  const { POST } = await loadRoute();
  const response = await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "please look at this" }))
  );
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.feedbackId, world.stored[0].id);
  assert.match(String(body.reference), /^[A-Z0-9]{8}$/);
});

test("a failed notification email is not a failed submission", async () => {
  const { POST } = await loadRoute();
  world.emailShouldFail = true;
  const response = await withCapturedLogs(() =>
    POST(post({ type: "billing", message: "charge looks wrong" }))
  );

  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).success, true);
  assert.equal(world.stored.length, 1, "the report must still be stored");
  // The two outcomes are distinguished where operations can act on them.
  assert.ok(
    world.logs.some((line) => line.includes("support_notification_failed"))
  );
  assert.ok(
    world.logs.some((line) => line.includes('"notificationDelivered":false'))
  );
});

test("a failed write is a 500 and stores nothing", async () => {
  const { POST } = await loadRoute();
  world.createShouldFail = true;
  const response = await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "this will not save" }))
  );

  assert.equal(response.status, 500);
  assert.equal((await readJson(response)).code, "FEEDBACK_SUBMIT_FAILED");
  assert.equal(world.stored.length, 0);
  assert.equal(world.emails.length, 0);
});

// --- the admin inbox reads what this writes ---------------------------------

test("a new submission carries every column the admin inbox renders", async () => {
  const { POST } = await loadRoute();
  world.session = { user: { id: "user_2", email: "member@tomverse.app" } };
  await withCapturedLogs(() =>
    POST(
      post({
        type: "bug",
        message: "inbox contract",
        traceId: "0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012",
        modelId: "gemini-2-5-flash",
        plan: "Pro",
        hasAttachments: true,
        attachmentCount: 2,
        path: "/chat",
        userAgent: "QA/1.0",
      })
    )
  );

  const [record] = world.stored;
  // FeedbackRow in components/admin/FeedbackInboxPanel.tsx.
  for (const column of [
    "id",
    "userId",
    "email",
    "type",
    "status",
    "message",
    "traceId",
    "modelId",
    "plan",
    "hasAttachments",
    "attachmentCount",
    "path",
    "userAgent",
    "createdAt",
  ]) {
    assert.ok(column in record, `the inbox column ${column} was not written`);
  }
  assert.equal(record.status, "open", "new feedback must land in the open queue");
  assert.equal(record.attachmentCount, 2);
});

// --- observability and secrecy ----------------------------------------------

test("the operational log carries the classification and nothing sensitive", async () => {
  const { POST } = await loadRoute();
  world.turnstileGrant = "tomverse_guest_verified=abc; Path=/";
  await withCapturedLogs(() =>
    POST(
      post(
        {
          type: "bug",
          message: "MY-CONFIDENTIAL-COMPLAINT-42",
          traceId: "TRACE-SECRET-9999",
          modelId: "gemini-2-5-flash",
          turnstileToken: "TURNSTILE-TOKEN-SECRET",
          userAgent: "Mozilla/5.0 (QA agent build 42)",
        },
        { cookie: "next-auth.session-token=SESSION-SECRET" }
      )
    )
  );

  const logged = world.logs.join("\n");
  for (const secret of [
    "MY-CONFIDENTIAL-COMPLAINT-42",
    "TRACE-SECRET-9999",
    "TURNSTILE-TOKEN-SECRET",
    "SESSION-SECRET",
    "Mozilla/5.0",
  ]) {
    assert.ok(!logged.includes(secret), `${secret} reached the operational log`);
  }

  const entry = world.logs.find((line) => line.includes('"user_feedback"'));
  assert.ok(entry, "no structured feedback log entry was written");
  const record = JSON.parse(entry as string) as Record<string, unknown>;
  assert.equal(record.subject, "guest");
  assert.equal(record.type, "bug");
  assert.equal(record.status, 200);
  assert.equal(record.turnstile, "verified");
  assert.equal(record.notificationDelivered, true);
  assert.equal(record.hasTraceId, true);
  assert.equal(record.hasModelId, true);
  assert.equal(typeof record.feedbackId, "string");
  assert.equal(typeof record.at, "string");
});

test("a failed write is logged without the payload that failed", async () => {
  const { POST } = await loadRoute();
  world.createShouldFail = true;
  await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "ANOTHER-CONFIDENTIAL-STRING" }))
  );

  const logged = world.logs.join("\n");
  assert.ok(!logged.includes("ANOTHER-CONFIDENTIAL-STRING"));
  assert.ok(logged.includes("user_feedback_failed"));
});

// --- submitter lifecycle notifications ---------------------------------------

test("a consented guest submission queues the operator and the receipt notification exactly once, in the transaction", async () => {
  const { POST } = await loadRoute();
  const response = await withCapturedLogs(() =>
    POST(
      post({
        type: "bug",
        message: "it broke on submit",
        email: "guest@example.com",
        emailUpdates: true,
        language: "ko",
      })
    )
  );

  assert.equal(response.status, 200);
  const kinds = world.deliveries.map((row) => row.kind).sort();
  assert.deepEqual(kinds, ["feedback_user_received", "support_feedback"]);
  // Both queue rows and the received event committed with the report itself.
  assert.ok(world.deliveries.every((row) => row.inTx), "a queue row was written outside the transaction");
  assert.equal(world.lifecycleEvents.length, 1);
  assert.equal(world.lifecycleEvents[0].stage, "received");
  assert.ok(world.lifecycleEvents[0].inTx, "the received event was written outside the transaction");
  // The stored consent and language snapshot drive every later email.
  assert.equal(world.stored[0].emailUpdatesConsent, true);
  assert.equal(world.stored[0].language, "ko");
  assert.equal((await readJson(response)).emailUpdatesEnabled, true);
});

test("the receipt email goes to the guest, in their language, without the report body", async () => {
  const { POST } = await loadRoute();
  await withCapturedLogs(() =>
    POST(
      post({
        type: "bug",
        message: "SECRET-REPORT-BODY should never be mailed to the user",
        traceId: "TRACE-VALUE-1234",
        email: "guest@example.com",
        emailUpdates: true,
        language: "ko",
      })
    )
  );

  const receipt = world.emails.find((mail) => mail.to === "guest@example.com");
  assert.ok(receipt, "no receipt email was attempted");
  assert.match(receipt!.subject, /^\[Tomverse\] 오류 신고가 접수되었습니다 \([A-Z0-9]{8}\)$/);
  assert.ok(!receipt!.text.includes("SECRET-REPORT-BODY"));
  assert.ok(!receipt!.text.includes("TRACE-VALUE-1234"));
  assert.ok(!receipt!.text.includes(world.stored[0].id as string), "the raw feedback id leaked into the receipt");
  // The provider idempotency key is the queue row's id, so every retry
  // presents the same key.
  const delivery = world.deliveries.find(
    (row) => row.kind === "feedback_user_received"
  );
  assert.equal(receipt!.idempotencyKey, `notification-delivery:${delivery!.id}`);
});

test("without consent there is no receipt queue row and no receipt email", async () => {
  const { POST } = await loadRoute();
  const response = await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "no consent given", email: "guest@example.com" }))
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    world.deliveries.map((row) => row.kind),
    ["support_feedback"]
  );
  assert.equal(world.emails.filter((m) => m.to === "guest@example.com").length, 0);
  assert.equal((await readJson(response)).emailUpdatesEnabled, false);
  assert.equal(world.stored[0].emailUpdatesConsent, false);
});

test("consent without any address enables nothing", async () => {
  const { POST } = await loadRoute();
  const response = await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "wants updates, gave no email", emailUpdates: true }))
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    world.deliveries.map((row) => row.kind),
    ["support_feedback"]
  );
  assert.equal((await readJson(response)).emailUpdatesEnabled, false);
});

test("the server-verified account email always beats the client-sent one", async () => {
  const { POST } = await loadRoute();
  world.session = { user: { id: "user_9", email: "account@tomverse.app" } };
  await withCapturedLogs(() =>
    POST(
      post({
        type: "bug",
        message: "attacker-controlled address",
        email: "attacker@evil.example",
        emailUpdates: true,
      })
    )
  );

  assert.equal(world.stored[0].email, "account@tomverse.app");
  const receipt = world.emails.find((mail) =>
    mail.to !== "support@tomverse.app"
  );
  assert.ok(receipt, "no receipt was attempted");
  assert.equal(receipt!.to, "account@tomverse.app");
  assert.ok(world.emails.every((mail) => mail.to !== "attacker@evil.example"));
});

test("a signed-in caller's language comes from the server-side setting, never the payload", async () => {
  const { POST } = await loadRoute();
  world.session = { user: { id: "user_10", email: "member@tomverse.app" } };
  world.settingsLanguage = "de";
  await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "language contract", language: "ko" }))
  );

  assert.equal(world.stored[0].language, "de");
});

test("an unsupported guest language falls back to English", async () => {
  const { POST } = await loadRoute();
  await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "language fallback", language: "xx" }))
  );

  assert.equal(world.stored[0].language, "en");
});

test("a guest recipient address gets its own rate-limit budget, only when it will be mailed", async () => {
  const { POST } = await loadRoute();
  await withCapturedLogs(() =>
    POST(
      post({
        type: "bug",
        message: "recipient budget",
        email: "victim@example.com",
        emailUpdates: true,
      })
    )
  );
  assert.ok(world.rateLimits.includes("feedback-recipient"));

  world = freshWorld();
  await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "no consent, no budget", email: "victim@example.com" }))
  );
  assert.ok(!world.rateLimits.includes("feedback-recipient"));

  // A signed-in caller mails their own verified account address, which needs
  // no per-recipient budget.
  world = freshWorld();
  world.session = { user: { id: "user_11", email: "member@tomverse.app" } };
  await withCapturedLogs(() =>
    POST(post({ type: "bug", message: "account recipient", emailUpdates: true }))
  );
  assert.ok(!world.rateLimits.includes("feedback-recipient"));
});

test("a failed receipt email is not a failed submission, and stays queued for retry", async () => {
  const { POST } = await loadRoute();
  world.emailShouldFail = true;
  const response = await withCapturedLogs(() =>
    POST(
      post({
        type: "bug",
        message: "provider outage while submitting",
        email: "guest@example.com",
        emailUpdates: true,
      })
    )
  );

  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).success, true);
  const receiptRow = world.deliveries.find(
    (row) => row.kind === "feedback_user_received"
  );
  assert.ok(receiptRow);
  assert.equal(receiptRow!.status, "pending", "the receipt must stay owed to the retry queue");
  assert.ok(world.logs.some((line) => line.includes("feedback_user_receipt_failed")));
});

test("the receipt renders identically from the stored snapshot on retry", async () => {
  const { POST } = await loadRoute();
  await withCapturedLogs(() =>
    POST(
      post({
        type: "feature",
        message: "please add exports",
        email: "guest@example.com",
        emailUpdates: true,
        language: "fr",
      })
    )
  );
  const first = world.emails.find((mail) => mail.to === "guest@example.com");
  assert.ok(first);

  // A retry goes through the same renderer against the same stored rows.
  const deliveries = (await import(
    `${mod("lib/notificationDeliveries.ts")}?spy=cached`
  )) as typeof import("../../lib/notificationDeliveries");
  const row = world.deliveries.find((r) => r.kind === "feedback_user_received")!;
  const retry = await deliveries.attemptNotificationDelivery({
    kind: "feedback_user_received",
    referenceId: row.referenceId as string,
    deliveryId: row.id,
  });
  assert.equal(retry.kind, "delivered");
  const second = world.emails.at(-1)!;
  assert.equal(second.subject, first!.subject);
  assert.equal(second.text, first!.text);
  assert.equal(second.idempotencyKey, first!.idempotencyKey);
});

test("the log never carries the recipient address or consent email", async () => {
  const { POST } = await loadRoute();
  await withCapturedLogs(() =>
    POST(
      post({
        type: "bug",
        message: "privacy of the address",
        email: "very-private@example.com",
        emailUpdates: true,
      })
    )
  );

  const logged = world.logs.join("\n");
  assert.ok(!logged.includes("very-private@example.com"), "the recipient address reached the log");
  const entry = world.logs.find((line) => line.includes('"user_feedback"'));
  const record = JSON.parse(entry as string) as Record<string, unknown>;
  assert.equal(record.emailUpdatesConsent, true);
  assert.equal(record.userReceiptDelivered, true);
});

test("the route still enforces the minimum in its own source", async () => {
  const source = require("node:fs").readFileSync(
    resolve(ROOT, "app/api/feedback/route.ts"),
    "utf8"
  ) as string;
  assert.match(source, /message:\s*z\.string\(\)\.trim\(\)\.min\(5\)\.max\(2_000\)/);
  assert.match(source, /ensureGuestVerified\(/);
});

// --- error report token verification ----------------------------------------
//
// The token contract at the route level: verification is an annotation on the
// stored report, never a gate in front of it, and the raw token itself is
// verified and discarded -- it must not reach the stored row or the log.

const TOKEN_SECRET = "a-feedback-contract-secret-32chars!!";

const withSigningSecret = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = process.env.ERROR_REPORT_SIGNING_SECRET;
  process.env.ERROR_REPORT_SIGNING_SECRET = TOKEN_SECRET;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ERROR_REPORT_SIGNING_SECRET;
    else process.env.ERROR_REPORT_SIGNING_SECRET = previous;
  }
};

const issueToken = async (input: {
  traceId: string;
  errorCode?: string;
  occurrenceId?: string;
}) => {
  const tokenModule = (await import(
    `${mod("lib/errorReportToken.ts")}?spy=cached`
  )) as typeof import("../../lib/errorReportToken");
  return tokenModule.issueErrorReportToken({
    routeClass: "chat",
    ...input,
  });
};

test("a report without a token stores as missing_token, not a failure", async () => {
  await withSigningSecret(async () => {
    const { POST } = await loadRoute();
    const response = await withCapturedLogs(() =>
      POST(
        post({
          type: "bug",
          message: "server error happened",
          traceId: "11111111-2222-4333-8444-555555555555",
          traceProvenance: "server_generated",
        })
      )
    );
    assert.equal(response.status, 200);
    assert.equal(world.stored[0].errorReportVerification, "missing_token");
    // Without a token the provenance stays the client's claim.
    assert.equal(world.stored[0].traceProvenance, "server_generated");
    assert.equal(world.stored[0].traceEvidenceId, null);
  });
});

test("a valid token verifies and links the exact evidence occurrence", async () => {
  await withSigningSecret(async () => {
    const { POST } = await loadRoute();
    world.evidenceRows.push({ id: "ev-1", occurrenceId: "occ-1" });
    const traceId = "22222222-2222-4333-8444-555555555555";
    const token = await issueToken({
      traceId,
      errorCode: "AI_PROVIDER_ERROR",
      occurrenceId: "occ-1",
    });
    assert.ok(token);
    const response = await withCapturedLogs(() =>
      POST(
        post({
          type: "bug",
          message: "server error happened",
          traceId,
          errorReportToken: token!,
        })
      )
    );
    assert.equal(response.status, 200);
    const stored = world.stored[0];
    assert.equal(stored.errorReportVerification, "verified");
    assert.equal(stored.traceProvenance, "server_generated");
    assert.equal(stored.errorClassificationSource, "server");
    assert.equal(stored.evidenceAvailability, "recorded");
    assert.equal(stored.traceEvidenceId, "ev-1");
    // The raw token is verified and discarded: not stored, not logged.
    assert.ok(!JSON.stringify(world.stored).includes(token!));
    assert.ok(!world.logs.join("\n").includes(token!));
  });
});

test("a token for a different trace stores as payload_mismatch", async () => {
  await withSigningSecret(async () => {
    const { POST } = await loadRoute();
    const token = await issueToken({
      traceId: "33333333-2222-4333-8444-555555555555",
    });
    const response = await withCapturedLogs(() =>
      POST(
        post({
          type: "bug",
          message: "server error happened",
          traceId: "44444444-2222-4333-8444-555555555555",
          errorReportToken: token!,
        })
      )
    );
    assert.equal(response.status, 200);
    assert.equal(world.stored[0].errorReportVerification, "payload_mismatch");
    assert.equal(world.stored[0].traceEvidenceId, null);
  });
});

test("a forged token stores as invalid_signature and still stores the report", async () => {
  await withSigningSecret(async () => {
    const { POST } = await loadRoute();
    const token = await issueToken({
      traceId: "55555555-2222-4333-8444-555555555555",
    });
    const forged = `${token!.slice(0, -4)}AAAA`;
    const response = await withCapturedLogs(() =>
      POST(
        post({
          type: "bug",
          message: "server error happened",
          traceId: "55555555-2222-4333-8444-555555555555",
          errorReportToken: forged,
        })
      )
    );
    assert.equal(response.status, 200);
    assert.equal(world.stored.length, 1);
    assert.equal(world.stored[0].errorReportVerification, "invalid_signature");
  });
});

test("a verified limit-class token points at the existing limit events", async () => {
  await withSigningSecret(async () => {
    const { POST } = await loadRoute();
    const traceId = "66666666-2222-4333-8444-555555555555";
    // Limit-class errors get a token but no occurrenceId -- the existing
    // limit-decision events are their record.
    const token = await issueToken({ traceId, errorCode: "CHAT_QUOTA_EXCEEDED" });
    const response = await withCapturedLogs(() =>
      POST(
        post({
          type: "bug",
          message: "quota error report",
          traceId,
          errorReportToken: token!,
        })
      )
    );
    assert.equal(response.status, 200);
    assert.equal(world.stored[0].errorReportVerification, "verified");
    assert.equal(world.stored[0].evidenceAvailability, "existing_limit_event");
  });
});

test("a client-classified EMPTY_RESPONSE stays unverified and keeps its client code", async () => {
  await withSigningSecret(async () => {
    const { POST } = await loadRoute();
    const response = await withCapturedLogs(() =>
      POST(
        post({
          type: "bug",
          message: "the answer was empty",
          traceId: "77777777-2222-4333-8444-555555555555",
          traceProvenance: "server_generated",
          clientErrorCode: "EMPTY_RESPONSE",
        })
      )
    );
    assert.equal(response.status, 200);
    const stored = world.stored[0];
    assert.equal(stored.errorReportVerification, "missing_token");
    assert.equal(stored.clientErrorCode, "EMPTY_RESPONSE");
    assert.equal(stored.errorClassificationSource, "client");
    // The log carries classifications only, never the trace value itself.
    const entry = world.logs.find((line) => line.includes('"user_feedback"'));
    const record = JSON.parse(entry as string) as Record<string, unknown>;
    assert.equal(record.errorReportVerification, "missing_token");
    assert.equal(record.errorClassificationSource, "client");
    assert.ok(
      !(entry as string).includes("77777777-2222-4333-8444-555555555555"),
      "the trace value reached the log"
    );
  });
});

test("without a signing secret the report still stores as missing_token", async () => {
  const previous = process.env.ERROR_REPORT_SIGNING_SECRET;
  delete process.env.ERROR_REPORT_SIGNING_SECRET;
  try {
    const { POST } = await loadRoute();
    const response = await withCapturedLogs(() =>
      POST(
        post({
          type: "bug",
          message: "secretless deployment",
          traceId: "88888888-2222-4333-8444-555555555555",
          errorReportToken: "terr1.some.token",
        })
      )
    );
    assert.equal(response.status, 200);
    assert.equal(world.stored[0].errorReportVerification, "missing_token");
  } finally {
    if (previous === undefined) delete process.env.ERROR_REPORT_SIGNING_SECRET;
    else process.env.ERROR_REPORT_SIGNING_SECRET = previous;
  }
});

// --- Phase 2 shadow-case queueing --------------------------------------------
//
// A verified bug report queues a diagnosis-only case in the same transaction
// as the report itself -- and only then: the flag is fail-closed, non-bug
// types never queue, and an unverified trace never queues.

const withShadowMode = async <T>(
  enabled: boolean,
  run: () => Promise<T>
): Promise<T> => {
  const previous = process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
  if (enabled) process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = "true";
  else delete process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
    } else {
      process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = previous;
    }
  }
};

test("a verified bug report queues a shadow case inside the transaction", async () => {
  await withSigningSecret(async () => {
    await withShadowMode(true, async () => {
      const { POST } = await loadRoute();
      world.evidenceRows.push({ id: "ev-case", occurrenceId: "occ-case" });
      const traceId = "99999999-2222-4333-8444-555555555555";
      const token = await issueToken({
        traceId,
        errorCode: "AI_PROVIDER_ERROR",
        occurrenceId: "occ-case",
      });
      const response = await withCapturedLogs(() =>
        POST(
          post({
            type: "bug",
            message: "verified server failure",
            traceId,
            errorReportToken: token!,
          })
        )
      );
      assert.equal(response.status, 200);
      assert.equal(world.autoFixCases.length, 1);
      const created = world.autoFixCases[0];
      assert.equal(created.inTx, true, "case must commit with the report");
      assert.equal(created.traceId, traceId);
      assert.equal(created.occurrenceId, "occ-case");
      assert.ok(
        String(created.fingerprint).startsWith("AI_PROVIDER_ERROR|"),
        "fingerprint carries the server-classified code"
      );
    });
  });
});

test("no shadow case without the flag, for non-bug types, or unverified traces", async () => {
  await withSigningSecret(async () => {
    const traceId = "aaaa9999-2222-4333-8444-555555555555";
    const token = await issueToken({ traceId, errorCode: "AI_PROVIDER_ERROR" });

    // Flag off: verified bug, still no case.
    await withShadowMode(false, async () => {
      const { POST } = await loadRoute();
      await withCapturedLogs(() =>
        POST(
          post({
            type: "bug",
            message: "flag is off",
            traceId,
            errorReportToken: token!,
          })
        )
      );
      assert.equal(world.autoFixCases.length, 0);
    });

    // Flag on, but a feature request: no case.
    await withShadowMode(true, async () => {
      const { POST } = await loadRoute();
      await withCapturedLogs(() =>
        POST(
          post({
            type: "feature",
            message: "please add a thing",
            traceId,
            errorReportToken: token!,
          })
        )
      );
      assert.equal(world.autoFixCases.length, 0);

      // Flag on, bug, but no token: stored as missing_token, no case.
      await withCapturedLogs(() =>
        POST(
          post({
            type: "bug",
            message: "manual trace only",
            traceId,
          })
        )
      );
      assert.equal(world.autoFixCases.length, 0);
    });
  });
});
