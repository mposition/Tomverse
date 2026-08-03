import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for PATCH /api/admin/feedback/[feedbackId].
 *
 * What must hold:
 *   - support:write is required, and a non-admin sees a 404, not a 403;
 *   - the status change, the immutable lifecycle event, the notification queue
 *     row and the success audit entry commit in ONE transaction;
 *   - only the FIRST transition into a stage queues a submitter email --
 *     a repeat, a refresh or a second closure queues nothing;
 *   - closing requires an outcome code, and the user-facing reply is validated
 *     and kept apart from internal notes;
 *   - a failed send is reported as "queued", never as a failed status change;
 *   - no consent or no address means the status still changes and nothing is
 *     queued;
 *   - neither the audit metadata nor the log carries the reply text or the
 *     reporter's address.
 *
 * Only the session, admin auth, the audit writer, the rate limiter, the mailer
 * and Prisma are replaced. The zod schema, the lifecycle policy and the
 * notification queue module are the real ones.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "admin-feedback-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.SUPPORT_NOTIFICATION_EMAIL = "support@tomverse.app";

type FeedbackRecord = Record<string, unknown> & { id: string };

type World = {
  session: { user: { id: string; email?: string } } | null;
  isAdmin: boolean;
  permissions: string[];
  feedback: FeedbackRecord | null;
  lifecycleEvents: Array<Record<string, unknown> & { inTx: boolean }>;
  deliveries: Array<Record<string, unknown> & { id: string; inTx: boolean }>;
  audits: Array<{ action: string; metadata: unknown; hasTx: boolean }>;
  emails: { to: string; subject: string; text: string; html: string; idempotencyKey?: string }[];
  emailShouldFail: boolean;
  logs: string[];
  txActive: boolean;
};

const reporterFeedback = (): FeedbackRecord => ({
  id: "clzfeedback0000admin01",
  userId: "user_reporter",
  email: "reporter@example.com",
  type: "bug",
  status: "open",
  message: "the report body, which no admin email may quote",
  language: "ko",
  emailUpdatesConsent: true,
  closureOutcome: null,
  userReply: null,
  createdAt: new Date("2099-01-01T00:00:00.000Z"),
});

const freshWorld = (): World => ({
  session: { user: { id: "admin_1", email: "admin@tomverse.app" } },
  isAdmin: true,
  permissions: ["support:write"],
  feedback: reporterFeedback(),
  lifecycleEvents: [],
  deliveries: [],
  audits: [],
  emails: [],
  emailShouldFail: false,
  logs: [],
  txActive: false,
});

let world = freshWorld();
let mocksInstalled = false;
let nextId = 0;

async function loadRoute(): Promise<{
  PATCH: (
    request: Request,
    context: { params: Promise<{ feedbackId: string }> }
  ) => Promise<Response>;
}> {
  if (!mocksInstalled) {
    mocksInstalled = true;

    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () => world.session,
      },
    });

    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.isAdmin,
        hasAdminPermission: (_session: unknown, permission: string) =>
          world.permissions.includes(permission),
      },
    });

    mock.module(mod("lib/adminAudit.ts"), {
      namedExports: {
        writeAdminAuditLog: async ({
          action,
          metadata,
          tx,
        }: {
          action: string;
          metadata?: unknown;
          tx?: unknown;
        }) => {
          world.audits.push({ action, metadata: metadata ?? null, hasTx: Boolean(tx) });
        },
      },
    });

    // Only the rate limiter is replaced: the real readLimitedJson runs the
    // route's real zod schema, so the schema itself stays under test.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realApiSecurity = require(
      resolve(ROOT, "lib/apiSecurity.ts")
    ) as Record<string, unknown>;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => {},
      },
    });

    mock.module(mod("lib/email.ts"), {
      namedExports: {
        sendTransactionalEmail: async (input: {
          to: string;
          subject: string;
          text: string;
          html: string;
          idempotencyKey?: string;
        }) => {
          if (world.emailShouldFail) throw new Error("mailbox unavailable");
          world.emails.push(input);
          return { sent: true, skipped: false, id: "qa-email" };
        },
      },
    });

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
        findUnique: async ({ where }: { where: { id: string } }) =>
          world.feedback && world.feedback.id === where.id
            ? { ...world.feedback }
            : null,
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          if (!world.feedback || world.feedback.id !== where.id) {
            throw new Error("record not found");
          }
          Object.assign(world.feedback, data);
          return { ...world.feedback };
        },
      },
      feedbackLifecycleEvent: {
        createMany: async ({
          data,
          skipDuplicates,
        }: {
          data: Array<Record<string, unknown>>;
          skipDuplicates?: boolean;
        }) => {
          assert.equal(skipDuplicates, true, "duplicate stages must be skipped, not errors");
          let count = 0;
          for (const row of data) {
            const exists = world.lifecycleEvents.some(
              (event) =>
                event.feedbackId === row.feedbackId && event.stage === row.stage
            );
            if (exists) continue;
            world.lifecycleEvents.push({ ...row, inTx: world.txActive });
            count += 1;
          }
          return { count };
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
          if (!event || !world.feedback) return null;
          return {
            outcomeCode: event.outcomeCode ?? null,
            userReply: event.userReply ?? null,
            feedback: {
              id: world.feedback.id,
              type: world.feedback.type,
              email: world.feedback.email ?? null,
              emailUpdatesConsent: Boolean(world.feedback.emailUpdatesConsent),
              language: world.feedback.language ?? "en",
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
            id: `clzdelivery00${String(nextId).padStart(4, "0")}`,
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
    };

    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: fakePrisma },
    });
  }

  return (await import(
    `${mod("app/api/admin/feedback/[feedbackId]/route.ts")}?spy=cached`
  )) as {
    PATCH: (
      request: Request,
      context: { params: Promise<{ feedbackId: string }> }
    ) => Promise<Response>;
  };
}

const patch = (feedbackId: string, body: unknown) => {
  const request = new Request(
    `http://127.0.0.1:3100/api/admin/feedback/${feedbackId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return { request, context: { params: Promise.resolve({ feedbackId }) } };
};

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

const withCapturedLogs = async <T>(run: () => Promise<T>): Promise<T> => {
  const originals = { warn: console.warn, error: console.error };
  const record = (...args: unknown[]) => {
    world.logs.push(args.map((value) => String(value)).join(" "));
  };
  console.warn = record;
  console.error = record;
  try {
    return await run();
  } finally {
    console.warn = originals.warn;
    console.error = originals.error;
  }
};

test.beforeEach(() => {
  world = freshWorld();
});

// --- authorisation -----------------------------------------------------------

test("a non-admin session sees a 404", async () => {
  const { PATCH } = await loadRoute();
  world.isAdmin = false;
  const { request, context } = patch(world.feedback!.id, { status: "reviewing" });
  const response = await PATCH(request, context);

  assert.equal(response.status, 404);
  assert.equal(world.feedback!.status, "open");
});

test("support:write is required", async () => {
  const { PATCH } = await loadRoute();
  world.permissions = ["support:read"];
  const { request, context } = patch(world.feedback!.id, { status: "reviewing" });
  const response = await PATCH(request, context);

  assert.equal(response.status, 403);
  assert.equal(world.feedback!.status, "open");
  assert.equal(world.audits.length, 0);
});

// --- the reviewing transition -------------------------------------------------

test("the first reviewing transition commits the status, the event, the queue row and the audit entry together, then emails", async () => {
  const { PATCH } = await loadRoute();
  const { request, context } = patch(world.feedback!.id, { status: "reviewing" });
  const response = await withCapturedLogs(() => PATCH(request, context));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(world.feedback!.status, "reviewing");

  assert.equal(world.lifecycleEvents.length, 1);
  assert.equal(world.lifecycleEvents[0].stage, "reviewing");
  assert.equal(world.lifecycleEvents[0].previousStatus, "open");
  assert.equal(world.lifecycleEvents[0].actorUserId, "admin_1");
  assert.ok(world.lifecycleEvents[0].inTx, "the event escaped the transaction");

  assert.equal(world.deliveries.length, 1);
  assert.equal(world.deliveries[0].kind, "feedback_user_reviewing");
  assert.ok(world.deliveries[0].inTx, "the queue row escaped the transaction");

  const updated = world.audits.find((a) => a.action === "feedback.status.updated");
  assert.ok(updated, "no success audit entry");
  assert.ok(updated!.hasTx, "the success audit entry escaped the transaction");

  assert.deepEqual(body.userNotification, { queued: true, delivered: true });
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to, "reporter@example.com");
  assert.match(world.emails[0].subject, /^\[Tomverse\] 신고 내용을 검토하고 있습니다/);
});

test("repeating the reviewing status queues nothing new", async () => {
  const { PATCH } = await loadRoute();
  const first = patch(world.feedback!.id, { status: "reviewing" });
  await withCapturedLogs(() => PATCH(first.request, first.context));

  const second = patch(world.feedback!.id, { status: "reviewing" });
  const response = await withCapturedLogs(() =>
    PATCH(second.request, second.context)
  );
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body.userNotification, {
    queued: false,
    reason: "already_notified",
  });
  assert.equal(world.lifecycleEvents.length, 1);
  assert.equal(world.deliveries.length, 1);
  assert.equal(world.emails.length, 1);
});

test("bouncing open -> reviewing -> open -> reviewing emails once", async () => {
  const { PATCH } = await loadRoute();
  for (const status of ["reviewing", "open", "reviewing"]) {
    const { request, context } = patch(world.feedback!.id, { status });
    const response = await withCapturedLogs(() => PATCH(request, context));
    assert.equal(response.status, 200);
  }
  assert.equal(
    world.deliveries.filter((row) => row.kind === "feedback_user_reviewing").length,
    1
  );
  assert.equal(world.emails.length, 1);
});

// --- closing -----------------------------------------------------------------

test("closing without an outcome code is refused before anything is written", async () => {
  const { PATCH } = await loadRoute();
  const { request, context } = patch(world.feedback!.id, { status: "resolved" });
  const response = await PATCH(request, context);

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "FEEDBACK_OUTCOME_REQUIRED");
  assert.equal(world.feedback!.status, "open");
  assert.equal(world.lifecycleEvents.length, 0);
});

test("an outcome on a non-terminal status is refused", async () => {
  const { PATCH } = await loadRoute();
  const { request, context } = patch(world.feedback!.id, {
    status: "reviewing",
    outcomeCode: "fixed",
  });
  const response = await PATCH(request, context);

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "FEEDBACK_OUTCOME_NOT_APPLICABLE");
});

test("a too-short user reply is refused", async () => {
  const { PATCH } = await loadRoute();
  const { request, context } = patch(world.feedback!.id, {
    status: "resolved",
    outcomeCode: "fixed",
    userReply: "thanks",
  });
  const response = await PATCH(request, context);

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "FEEDBACK_USER_REPLY_INVALID");
  assert.equal(world.feedback!.status, "open");
});

test("the first closure stores the outcome, snapshots the reply, and emails it escaped", async () => {
  const { PATCH } = await loadRoute();
  const reply = `We shipped a fix. <b>Thanks</b> & sorry!`;
  const { request, context } = patch(world.feedback!.id, {
    status: "resolved",
    outcomeCode: "fixed",
    userReply: reply,
  });
  const response = await withCapturedLogs(() => PATCH(request, context));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(world.feedback!.status, "resolved");
  assert.equal(world.feedback!.closureOutcome, "fixed");
  assert.equal(world.feedback!.userReply, reply);

  const event = world.lifecycleEvents[0];
  assert.equal(event.stage, "completed");
  assert.equal(event.outcomeCode, "fixed");
  assert.equal(event.userReply, reply);

  assert.deepEqual(body.userNotification, { queued: true, delivered: true });
  const [mail] = world.emails;
  assert.match(mail.subject, /^\[Tomverse\] 신고해 주신 오류를 수정했습니다/);
  assert.ok(mail.text.includes(reply));
  assert.ok(mail.html.includes("&lt;b&gt;Thanks&lt;/b&gt; &amp; sorry!"));
  assert.ok(!mail.html.includes("<b>Thanks</b>"));
  // The email is built from the lifecycle snapshot, never from the report.
  assert.ok(!mail.text.includes("the report body"));
});

test("a second closure changes the status but never re-emails", async () => {
  const { PATCH } = await loadRoute();
  const first = patch(world.feedback!.id, {
    status: "resolved",
    outcomeCode: "fixed",
  });
  await withCapturedLogs(() => PATCH(first.request, first.context));

  const second = patch(world.feedback!.id, {
    status: "closed",
    outcomeCode: "no_action",
  });
  const response = await withCapturedLogs(() =>
    PATCH(second.request, second.context)
  );
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(world.feedback!.status, "closed");
  assert.deepEqual(body.userNotification, {
    queued: false,
    reason: "already_notified",
  });
  assert.equal(world.emails.length, 1);
  // The first closure's snapshot is immutable: the second write cannot change
  // what was (or would be) emailed.
  assert.equal(world.lifecycleEvents[0].outcomeCode, "fixed");
});

// --- who can be emailed ------------------------------------------------------

test("no consent means the status changes and nothing is queued", async () => {
  const { PATCH } = await loadRoute();
  world.feedback!.emailUpdatesConsent = false;
  const { request, context } = patch(world.feedback!.id, { status: "reviewing" });
  const response = await withCapturedLogs(() => PATCH(request, context));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(world.feedback!.status, "reviewing");
  assert.deepEqual(body.userNotification, {
    queued: false,
    reason: "not_notifiable",
  });
  assert.equal(world.deliveries.length, 0);
  assert.equal(world.emails.length, 0);
});

test("a scrubbed address (account deletion) means nothing is queued", async () => {
  const { PATCH } = await loadRoute();
  world.feedback!.email = null;
  const { request, context } = patch(world.feedback!.id, { status: "reviewing" });
  const response = await withCapturedLogs(() => PATCH(request, context));

  assert.equal(response.status, 200);
  assert.deepEqual((await readJson(response)).userNotification, {
    queued: false,
    reason: "not_notifiable",
  });
  assert.equal(world.deliveries.length, 0);
});

// --- delivery failure is not a status failure --------------------------------

test("a provider failure leaves the status changed and the email queued for retry", async () => {
  const { PATCH } = await loadRoute();
  world.emailShouldFail = true;
  const { request, context } = patch(world.feedback!.id, { status: "reviewing" });
  const response = await withCapturedLogs(() => PATCH(request, context));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(world.feedback!.status, "reviewing");
  assert.deepEqual(body.userNotification, { queued: true, delivered: false });
  assert.equal(world.deliveries[0].status, "pending");
  assert.ok(
    world.logs.some((line) => line.includes("feedback_user_notification_failed"))
  );
});

// --- secrecy -----------------------------------------------------------------

test("neither the audit metadata nor the log carries the reply or the address", async () => {
  const { PATCH } = await loadRoute();
  const reply = "REPLY-TEXT-THAT-MUST-NOT-BE-LOGGED anywhere at all";
  const { request, context } = patch(world.feedback!.id, {
    status: "closed",
    outcomeCode: "answered",
    userReply: reply,
  });
  await withCapturedLogs(() => PATCH(request, context));

  const auditPayload = JSON.stringify(world.audits);
  assert.ok(!auditPayload.includes("REPLY-TEXT-THAT-MUST-NOT-BE-LOGGED"));
  assert.ok(!auditPayload.includes("reporter@example.com"));
  const logged = world.logs.join("\n");
  assert.ok(!logged.includes("REPLY-TEXT-THAT-MUST-NOT-BE-LOGGED"));
  assert.ok(!logged.includes("reporter@example.com"));
});

test("an unknown feedback id is a 404 after validation", async () => {
  const { PATCH } = await loadRoute();
  const { request, context } = patch("clzdoesnotexist000000", {
    status: "reviewing",
  });
  const response = await withCapturedLogs(() => PATCH(request, context));

  assert.equal(response.status, 404);
});
