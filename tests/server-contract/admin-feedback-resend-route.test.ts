import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sendLockPrismaStubs } from "../support/sendLockPrisma";

/**
 * Contract for POST /api/admin/feedback/{id}/resend-reply.
 *
 * It exists for the reports closed before 2026-09-16, when the answer to a
 * report still required the reporter's progress-notice tick: the reply is on
 * the lifecycle event, and nothing ever carried it. What must hold:
 *   - support:write only, and a report that actually has an address and a
 *     completion record;
 *   - the stored reply is what goes out -- the event is never rewritten;
 *   - once only: a queued, sent, or already re-sent reply is refused rather
 *     than duplicated.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "resend-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type World = {
  isAdmin: boolean;
  permissions: string[];
  feedback: { id: string; email: string | null; emailUpdatesConsent: boolean } | null;
  completedEvent: boolean;
  deliveries: Array<{ id: string; kind: string; referenceId: string; status: string }>;
  emails: Array<{ to: string; subject: string; text: string }>;
  audits: string[];
};

const FEEDBACK_ID = "clzfeedback0000resend1";

const freshWorld = (): World => ({
  isAdmin: true,
  permissions: ["support:write"],
  feedback: { id: FEEDBACK_ID, email: "reporter@example.com", emailUpdatesConsent: false },
  completedEvent: true,
  deliveries: [],
  emails: [],
  audits: [],
});

let world = freshWorld();
let mocksInstalled = false;

async function loadRoute() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () => ({ user: { id: "admin_1", email: "admin@tomverse.app" } }),
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
        writeAdminAuditLog: async ({ action }: { action: string }) => {
          world.audits.push(action);
        },
      },
    });
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/email.ts"), {
      namedExports: {
        sendTransactionalEmail: async (input: { to: string; subject: string; text: string }) => {
          world.emails.push(input);
          return { sent: true, skipped: false, id: "qa-email" };
        },
        // The customer-facing half goes through `sendWithAddressLock()`, which
        // submits with `deliverEmailOnce` and reads the provider's result
        // rather than parsing a thrown string
        // (docs/policy/email-notifications.md section 9.8).
        deliverEmailOnce: async (input: { to: string; subject: string; text: string }) => {
          world.emails.push(input);
          return { ok: true, providerMessageId: "qa-email", from: "support@tomverse.app", senderRole: "support" };
        },
      },
    });
    const fakePrisma: Record<string, unknown> = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
      feedback: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          world.feedback && world.feedback.id === where.id ? { ...world.feedback } : null,
      },
      feedbackLifecycleEvent: {
        findUnique: async () =>
          world.completedEvent
            ? {
                id: "event-1",
                outcomeCode: "fixed",
                userReply: "We found the cause, fixed it, and the fix is now live.",
                feedback: {
                  id: FEEDBACK_ID,
                  type: "bug",
                  email: world.feedback?.email ?? null,
                  emailUpdatesConsent: world.feedback?.emailUpdatesConsent ?? false,
                  language: "ko",
                },
              }
            : null,
      },
      notificationDelivery: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          world.deliveries.find((entry) => entry.id === where.id) ?? null,
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; status?: string; nextAttemptAt?: Date };
          data: Record<string, unknown>;
        }) => {
          const row = world.deliveries.find(
            (entry: Record<string, unknown>) =>
              entry.id === where.id &&
              (where.status === undefined || entry.status === where.status) &&
              (where.nextAttemptAt === undefined ||
                (entry.nextAttemptAt as Date | undefined)?.getTime() ===
                  where.nextAttemptAt.getTime())
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
        findMany: async ({ where }: { where: { referenceId: string; kind: { in: string[] } } }) =>
          world.deliveries.filter(
            (row) => row.referenceId === where.referenceId && where.kind.in.includes(row.kind)
          ),
        upsert: async ({ create }: { create: { kind: string; referenceId: string } }) => {
          const existing = world.deliveries.find(
            (row) => row.kind === create.kind && row.referenceId === create.referenceId
          );
          if (existing) return { id: existing.id };
          const row = { id: `delivery-${world.deliveries.length + 1}`, ...create, status: "pending", attempts: 0, nextAttemptAt: new Date() };
          world.deliveries.push(row);
          return { id: row.id };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = world.deliveries.find((entry) => entry.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      },
      suppressionCause: { findMany: async () => [] },
      // The address lock the send takes before it submits.
      ...sendLockPrismaStubs(),
    };
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: fakePrisma } });
  }
  return (await import(
    `${mod("app/api/admin/feedback/[feedbackId]/resend-reply/route.ts")}?spy=cached`
  )) as {
    POST: (
      request: Request,
      context: { params: Promise<{ feedbackId: string }> }
    ) => Promise<Response>;
  };
}

const post = (feedbackId = FEEDBACK_ID) => ({
  request: new Request(
    `http://127.0.0.1:3100/api/admin/feedback/${feedbackId}/resend-reply`,
    { method: "POST" }
  ),
  context: { params: Promise.resolve({ feedbackId }) },
});

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

test.beforeEach(() => {
  world = freshWorld();
});

test("it sends the stored reply and records the action", async () => {
  const { POST } = await loadRoute();
  const { request, context } = post();
  const response = await POST(request, context);

  assert.equal(response.status, 200);
  assert.deepEqual((await readJson(response)).userNotification, {
    queued: true,
    delivered: true,
  });
  assert.equal(world.deliveries.length, 1);
  assert.equal(world.deliveries[0].kind, "feedback_user_completed_resend");
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to, "reporter@example.com");
  assert.match(world.emails[0].text, /We found the cause/);
  assert.ok(world.audits.includes("feedback.reply.resent"));
});

test("it refuses a report with nothing to answer", async () => {
  const { POST } = await loadRoute();
  world.feedback!.email = null;
  let response = await (async () => {
    const { request, context } = post();
    return POST(request, context);
  })();
  assert.equal(response.status, 409);
  assert.equal((await readJson(response)).code, "NO_ADDRESS");

  world = freshWorld();
  world.completedEvent = false;
  const second = post();
  response = await POST(second.request, second.context);
  assert.equal(response.status, 409);
  assert.equal((await readJson(response)).code, "NOT_COMPLETED");

  world = freshWorld();
  world.feedback = null;
  const third = post();
  response = await POST(third.request, third.context);
  assert.equal(response.status, 404);
  assert.equal(world.emails.length, 0);
});

test("a reply already queued, sent or re-sent is refused rather than duplicated", async () => {
  const { POST } = await loadRoute();
  const cases: Array<[string, string, string]> = [
    ["feedback_user_completed", "pending", "ALREADY_QUEUED"],
    ["feedback_user_completed", "delivered", "ALREADY_SENT"],
    ["feedback_user_completed_resend", "abandoned", "ALREADY_RESENT"],
  ];
  for (const [kind, status, code] of cases) {
    world = freshWorld();
    world.deliveries.push({ id: "existing", kind, referenceId: FEEDBACK_ID, status });
    const { request, context } = post();
    const response = await POST(request, context);
    assert.equal(response.status, 409, code);
    assert.equal((await readJson(response)).code, code);
    assert.equal(world.emails.length, 0, code);
  }
});

test("an abandoned first attempt may be sent again, once", async () => {
  const { POST } = await loadRoute();
  world.deliveries.push({
    id: "existing",
    kind: "feedback_user_completed",
    referenceId: FEEDBACK_ID,
    status: "abandoned",
  });
  const first = post();
  assert.equal((await POST(first.request, first.context)).status, 200);
  assert.equal(world.emails.length, 1);

  // The re-sent row is now a sent one, so the second press is refused as
  // already sent rather than re-sending.
  const second = post();
  const response = await POST(second.request, second.context);
  assert.equal(response.status, 409);
  assert.equal((await readJson(response)).code, "ALREADY_SENT");
  assert.equal(world.emails.length, 1);
});

test("support:write is required", async () => {
  const { POST } = await loadRoute();
  world.permissions = ["support:read"];
  const { request, context } = post();
  const response = await POST(request, context);
  assert.equal(response.status, 403);
  assert.equal(world.deliveries.length, 0);

  world = freshWorld();
  world.isAdmin = false;
  const second = post();
  assert.equal((await POST(second.request, second.context)).status, 404);
});
