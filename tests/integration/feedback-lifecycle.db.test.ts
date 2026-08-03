import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The feedback lifecycle notifications, driven end to end against a real
// PostgreSQL.
//
// The claims under test are the ones only a real database can prove:
//
//  - a submission commits the report, its received lifecycle event, the
//    operator queue row and the submitter receipt queue row in ONE
//    transaction -- a failure in the last write rolls all of them back;
//  - the (feedbackId, stage) unique constraint holds under genuinely
//    concurrent admin requests, so the same stage can never queue two emails;
//  - account deletion scrubs the contact address and consent, and a
//    still-pending submitter notification then abandons as unsendable instead
//    of mailing a removed address.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces next-auth, admin auth
// and Turnstile for every module that imports them.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.SUPPORT_NOTIFICATION_EMAIL = "support@tomverse.test";
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= "feedback-lifecycle-audit-test-key";
// No Resend key: the inline delivery attempt resolves as "not configured" and
// leaves every row pending, which is exactly what these assertions read.
delete process.env.RESEND_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

// --- session and auth seams --------------------------------------------------

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

mock.module(mod("lib/adminAuth.ts"), {
  namedExports: {
    isAdminSession: () => true,
    hasAdminPermission: () => true,
  },
});

// Guests are irrelevant here; every submission is signed in.
mock.module(mod("lib/turnstile.ts"), {
  namedExports: {
    ensureGuestVerified: async () => undefined,
  },
});

// Nothing in this file may reach the network.
let unexpectedHostCalls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  unexpectedHostCalls.push(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String((input as Request).url)
  );
  return new Response(null, { status: 204 });
}) as typeof fetch;

/** Set to fail the enqueue of one notification kind inside the transaction. */
let failEnqueueForKind: string | null = null;

type FeedbackRouteModule = {
  POST: (request: Request) => Promise<Response>;
};
type AdminRouteModule = {
  PATCH: (
    request: Request,
    context: { params: Promise<{ feedbackId: string }> }
  ) => Promise<Response>;
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let feedbackRoute: FeedbackRouteModule;
let adminRoute: AdminRouteModule;
let deliveries: typeof import("@/lib/notificationDeliveries");
let accountDeletion: typeof import("@/lib/accountDeletion");

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));

  const real = (await import(
    mod("lib/notificationDeliveries.ts")
  )) as typeof import("@/lib/notificationDeliveries");
  deliveries = real;
  mock.module(mod("lib/notificationDeliveries.ts"), {
    namedExports: {
      ...real,
      enqueueNotificationDelivery: async (
        ...args: Parameters<typeof real.enqueueNotificationDelivery>
      ) => {
        if (failEnqueueForKind && args[1].kind === failEnqueueForKind) {
          throw new Error("simulated queue write failure");
        }
        return real.enqueueNotificationDelivery(...args);
      },
    },
  });

  feedbackRoute = (await import(
    mod("app/api/feedback/route.ts")
  )) as FeedbackRouteModule;
  adminRoute = (await import(
    mod("app/api/admin/feedback/[feedbackId]/route.ts")
  )) as AdminRouteModule;
  accountDeletion = (await import(
    mod("lib/accountDeletion.ts")
  )) as typeof import("@/lib/accountDeletion");
});

const resetData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminAuditLog",
      "NotificationDelivery",
      "FeedbackLifecycleEvent",
      "Feedback",
      "ChatUsageBucket",
      "UserSettings",
      "User"
    RESTART IDENTITY CASCADE
  `);

const seedReporter = async () => {
  const user = await prisma.user.create({
    data: {
      id: "user_reporter_1",
      email: "reporter@tomverse.test",
      settings: { create: { language: "ko" } },
    },
  });
  return user;
};

const seedAdmin = async () => {
  const admin = await prisma.user.create({
    data: { id: "user_admin_1", email: "admin@tomverse.test" },
  });
  sessionOverride = { user: { id: admin.id, email: admin.email } };
  return admin;
};

const submitAsReporter = async (body: Record<string, unknown> = {}) => {
  sessionOverride = {
    user: { id: "user_reporter_1", email: "reporter@tomverse.test" },
  };
  return feedbackRoute.POST(
    new Request("http://127.0.0.1:3100/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "bug",
        message: "integration report body",
        emailUpdates: true,
        ...body,
      }),
    })
  );
};

const patchAsAdmin = (feedbackId: string, body: Record<string, unknown>) =>
  adminRoute.PATCH(
    new Request(`http://127.0.0.1:3100/api/admin/feedback/${feedbackId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ feedbackId }) }
  );

beforeEach(async () => {
  await resetData();
  unexpectedHostCalls = [];
  sessionOverride = null;
  failEnqueueForKind = null;
});

after(async () => {
  await resetData();
  await prisma.$disconnect();
});

// --- submission atomicity ----------------------------------------------------

test("a submission commits the report, the received event and both queue rows together", async () => {
  await seedReporter();
  const response = await submitAsReporter();
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.emailUpdatesEnabled, true);

  const feedback = await prisma.feedback.findFirstOrThrow();
  assert.equal(feedback.email, "reporter@tomverse.test");
  assert.equal(feedback.emailUpdatesConsent, true);
  // The language snapshot comes from the server-side setting.
  assert.equal(feedback.language, "ko");

  const events = await prisma.feedbackLifecycleEvent.findMany({
    where: { feedbackId: feedback.id },
  });
  assert.deepEqual(events.map((event) => event.stage), ["received"]);

  const rows = await prisma.notificationDelivery.findMany({
    orderBy: { kind: "asc" },
  });
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["feedback_user_received", "support_feedback"]
  );
  // Mail is not configured in this process, so both stay owed to the queue.
  assert.ok(rows.every((row) => row.status === "pending"));
  assert.equal(unexpectedHostCalls.length, 0, "nothing may reach the network");
});

test("a failed receipt-queue write rolls back the report, the event and the operator row", async () => {
  await seedReporter();
  failEnqueueForKind = "feedback_user_received";
  const response = await submitAsReporter();

  assert.equal(response.status, 500);
  assert.equal(await prisma.feedback.count(), 0);
  assert.equal(await prisma.feedbackLifecycleEvent.count(), 0);
  assert.equal(await prisma.notificationDelivery.count(), 0);
});

test("declining consent stores the report with no receipt row", async () => {
  await seedReporter();
  const response = await submitAsReporter({ emailUpdates: false });
  assert.equal(response.status, 200);

  const rows = await prisma.notificationDelivery.findMany();
  assert.deepEqual(rows.map((row) => row.kind), ["support_feedback"]);
  const feedback = await prisma.feedback.findFirstOrThrow();
  assert.equal(feedback.emailUpdatesConsent, false);
});

// --- one email per stage, even under concurrency ------------------------------

test("concurrent reviewing transitions create exactly one event and one queue row", async () => {
  await seedReporter();
  await submitAsReporter();
  const feedback = await prisma.feedback.findFirstOrThrow();
  await seedAdmin();

  const responses = await Promise.all([
    patchAsAdmin(feedback.id, { status: "reviewing" }),
    patchAsAdmin(feedback.id, { status: "reviewing" }),
    patchAsAdmin(feedback.id, { status: "reviewing" }),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200, "every request must succeed");
  }
  const queued = await Promise.all(
    responses.map(async (response) => {
      const body = (await response.json()) as {
        userNotification: { queued: boolean };
      };
      return body.userNotification.queued;
    })
  );
  assert.equal(
    queued.filter(Boolean).length,
    1,
    "exactly one request may claim the reviewing email"
  );

  const events = await prisma.feedbackLifecycleEvent.findMany({
    where: { feedbackId: feedback.id, stage: "reviewing" },
  });
  assert.equal(events.length, 1);
  const rows = await prisma.notificationDelivery.findMany({
    where: { kind: "feedback_user_reviewing" },
  });
  assert.equal(rows.length, 1);
});

test("the completed stage is announced once, with the first closure's snapshot", async () => {
  await seedReporter();
  await submitAsReporter();
  const feedback = await prisma.feedback.findFirstOrThrow();
  await seedAdmin();

  const first = await patchAsAdmin(feedback.id, {
    status: "resolved",
    outcomeCode: "not_reproduced",
    userReply: "현재 동일한 증상을 재현하지 못해 추가 정보를 기다리고 있습니다.",
  });
  assert.equal(first.status, 200);

  const second = await patchAsAdmin(feedback.id, {
    status: "closed",
    outcomeCode: "fixed",
  });
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as {
    userNotification: { queued: boolean; reason?: string };
  };
  assert.deepEqual(secondBody.userNotification, {
    queued: false,
    reason: "already_notified",
  });

  // The snapshot is the first closure's; the second cannot rewrite what the
  // (still pending) email will say.
  const event = await prisma.feedbackLifecycleEvent.findUniqueOrThrow({
    where: { feedbackId_stage: { feedbackId: feedback.id, stage: "completed" } },
  });
  assert.equal(event.outcomeCode, "not_reproduced");
  const completedRows = await prisma.notificationDelivery.findMany({
    where: { kind: "feedback_user_completed" },
  });
  assert.equal(completedRows.length, 1);

  // The audit chain recorded both decisions atomically with their writes.
  const audits = await prisma.adminAuditLog.findMany({
    where: { targetType: "Feedback", targetId: feedback.id, action: "feedback.status.updated" },
  });
  assert.equal(audits.length, 2);
});

test("the database itself refuses a second event for the same stage", async () => {
  await seedReporter();
  await submitAsReporter();
  const feedback = await prisma.feedback.findFirstOrThrow();

  await assert.rejects(
    prisma.feedbackLifecycleEvent.create({
      data: { feedbackId: feedback.id, stage: "received", newStatus: "open" },
    }),
    (error: { code?: string }) => error.code === "P2002"
  );
});

// --- account deletion --------------------------------------------------------

test("account deletion scrubs consent and a pending receipt abandons instead of sending", async () => {
  await seedReporter();
  await submitAsReporter();
  const feedback = await prisma.feedback.findFirstOrThrow();

  const result = await accountDeletion.deleteTomverseAccount("user_reporter_1", {
    cancelSubscription: false,
  });
  assert.equal(result.deleted, true);

  const scrubbed = await prisma.feedback.findUniqueOrThrow({
    where: { id: feedback.id },
  });
  assert.equal(scrubbed.email, null);
  assert.equal(scrubbed.emailUpdatesConsent, false);

  // The pending receipt now renders as unsendable: draining abandons it
  // rather than mailing a removed address, while the operator notification is
  // still owed (mail is simply unconfigured here, a retryable state). The
  // drain runs "later": the inline attempt at submission already scheduled
  // the next try a minute out.
  await deliveries.drainNotificationDeliveries({
    now: new Date(Date.now() + 5 * 60_000),
  });
  const receipt = await prisma.notificationDelivery.findUniqueOrThrow({
    where: {
      kind_referenceId: {
        kind: "feedback_user_received",
        referenceId: feedback.id,
      },
    },
  });
  assert.equal(receipt.status, "abandoned");
  assert.equal(receipt.lastErrorKind, "source_missing");
  assert.equal(unexpectedHostCalls.length, 0, "no send may have been attempted");
});
