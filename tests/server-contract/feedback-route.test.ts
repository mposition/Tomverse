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
  deliveries: Array<Record<string, unknown> & { id: string }>;
  createShouldFail: boolean;
  emails: { to: string }[];
  emailShouldFail: boolean;
  logs: string[];
};

const freshWorld = (): World => ({
  session: null,
  rateLimits: [],
  turnstile: [],
  turnstileGrant: undefined,
  turnstileError: null,
  stored: [],
  deliveries: [],
  createShouldFail: false,
  emails: [],
  emailShouldFail: false,
  logs: [],
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
        sendTransactionalEmail: async ({ to }: { to: string }) => {
          if (world.emailShouldFail) throw new Error("mailbox unavailable");
          world.emails.push({ to });
          return { sent: true, skipped: false, id: "qa-email" };
        },
      },
    });

    // The report and its operator-notification queue row commit together, so
    // the fake models both tables and a transaction that simply runs its
    // callback against the same client.
    const fakePrisma: Record<string, unknown> = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(fakePrisma),
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
      notificationDelivery: {
        upsert: async ({
          create,
        }: {
          create: { kind: string; referenceId: string };
        }) => {
          nextId += 1;
          const row = {
            id: `clzdelivery000${String(nextId).padStart(4, "0")}`,
            ...create,
            status: "pending",
            attempts: 0,
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

test("the route still enforces the minimum in its own source", async () => {
  const source = require("node:fs").readFileSync(
    resolve(ROOT, "app/api/feedback/route.ts"),
    "utf8"
  ) as string;
  assert.match(source, /message:\s*z\.string\(\)\.trim\(\)\.min\(5\)\.max\(2_000\)/);
  assert.match(source, /ensureGuestVerified\(/);
});
