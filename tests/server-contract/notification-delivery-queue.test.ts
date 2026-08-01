import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for the operator-notification retry queue.
 *
 * The regression this guards: a support report that reached the database used
 * to lose its operator notification to a single failed send. The failure was
 * written to a log line and then forgotten, so the team never heard about the
 * report and nothing in the system remembered that a notification was owed.
 *
 * What must hold now:
 *   - the queue row is written with the report, not after it;
 *   - a failed send leaves a pending row that a later drain delivers;
 *   - a request the provider permanently rejected is not retried forever;
 *   - a drain never sends the same notification twice concurrently;
 *   - the user still gets a 200 whatever the mail provider does;
 *   - the reporter's words are never stored in the queue or logged.
 *
 * Only the session, the rate limiter, Turnstile, the mail provider and Prisma
 * are replaced. The route, the retry policy and the drain are the real ones.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "notification-queue-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.SUPPORT_NOTIFICATION_EMAIL = "support@tomverse.app";

type FeedbackRow = Record<string, unknown> & { id: string };
type DeliveryRow = {
  id: string;
  kind: string;
  referenceId: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  lastErrorKind: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SendAttempt = {
  to: string;
  subject: string;
  text: string;
  idempotencyKey?: string;
};

type World = {
  feedback: FeedbackRow[];
  deliveries: DeliveryRow[];
  sends: SendAttempt[];
  /** Queue of outcomes for successive sends; the last one repeats. */
  sendScript: Array<"ok" | "skip" | { throws: string }>;
  logs: string[];
};

const freshWorld = (): World => ({
  feedback: [],
  deliveries: [],
  sends: [],
  sendScript: ["ok"],
  logs: [],
});

let world = freshWorld();
let mocksInstalled = false;
let ids = 0;

const nextSendOutcome = () =>
  world.sendScript.length > 1
    ? world.sendScript.shift()!
    : world.sendScript[0];

/** A tiny in-memory stand-in for the two tables this contract touches. */
const fakePrisma = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
  feedback: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      ids += 1;
      const row = {
        ...data,
        id: `clzfeedback${String(ids).padStart(6, "0")}`,
        status: "open",
        createdAt: new Date("2099-01-01T00:00:00.000Z"),
      } as FeedbackRow;
      world.feedback.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      world.feedback.find((row) => row.id === where.id) ?? null,
  },
  notificationDelivery: {
    upsert: async ({
      where,
      create,
    }: {
      where: { kind_referenceId: { kind: string; referenceId: string } };
      create: { kind: string; referenceId: string };
    }) => {
      const key = where.kind_referenceId;
      const existing = world.deliveries.find(
        (row) => row.kind === key.kind && row.referenceId === key.referenceId
      );
      if (existing) return { id: existing.id };
      ids += 1;
      const row: DeliveryRow = {
        id: `clzdelivery${String(ids).padStart(6, "0")}`,
        kind: create.kind,
        referenceId: create.referenceId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(0),
        lastAttemptAt: null,
        lastErrorKind: null,
        deliveredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
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
      if (!row) throw new Error("delivery not found");
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in value) {
          (row as unknown as Record<string, number>)[key] +=
            (value as { increment: number }).increment;
          continue;
        }
        (row as unknown as Record<string, unknown>)[key] = value;
      }
      row.updatedAt = new Date();
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status: string; nextAttemptAt: Date };
      data: Record<string, unknown>;
    }) => {
      const row = world.deliveries.find(
        (entry) =>
          entry.id === where.id &&
          entry.status === where.status &&
          entry.nextAttemptAt.getTime() === where.nextAttemptAt.getTime()
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    findMany: async ({
      where,
      take,
    }: {
      where: { status: string; nextAttemptAt: { lte: Date } };
      take: number;
    }) =>
      world.deliveries
        .filter(
          (row) =>
            row.status === where.status &&
            row.nextAttemptAt.getTime() <= where.nextAttemptAt.lte.getTime()
        )
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, take)
        .map((row) => ({ ...row })),
    count: async ({ where }: { where: { status: string } }) =>
      world.deliveries.filter((row) => row.status === where.status).length,
    deleteMany: async () => ({ count: 0 }),
    groupBy: async () => [],
  },
};

async function loadModules() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const original = (path: string) =>
      require(resolve(ROOT, path)) as Record<string, unknown>;

    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: { getServerSession: async () => null },
    });

    const realApiSecurity = original("lib/apiSecurity.ts");
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => {},
      },
    });

    const realTurnstile = original("lib/turnstile.ts");
    mock.module(mod("lib/turnstile.ts"), {
      namedExports: {
        ...realTurnstile,
        ensureGuestVerified: async () => undefined,
      },
    });

    mock.module(mod("lib/email.ts"), {
      namedExports: {
        sendTransactionalEmail: async (input: SendAttempt) => {
          const outcome = nextSendOutcome();
          world.sends.push({
            to: input.to,
            subject: input.subject,
            text: input.text,
            idempotencyKey: input.idempotencyKey,
          });
          if (outcome === "ok") return { sent: true, skipped: false, id: "1" };
          if (outcome === "skip") return { sent: false, skipped: true };
          throw new Error(outcome.throws);
        },
      },
    });

    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: fakePrisma },
    });

    // The scheduled-job bookkeeping writes to tables this contract does not
    // model; the drain's behaviour is what is under test here.
    const realScheduledJobs = original("lib/scheduledJobs.ts");
    mock.module(mod("lib/scheduledJobs.ts"), {
      namedExports: {
        ...realScheduledJobs,
        startScheduledJob: async () => ({ id: "run_1" }),
        completeScheduledJob: async () => {},
        failScheduledJob: async () => {},
      },
    });

    mock.module(mod("lib/operationalMonitoring.ts"), {
      namedExports: {
        ...(original("lib/operationalMonitoring.ts") as Record<string, unknown>),
        reportOperationalIncident: async (incident: { code: string }) => {
          world.logs.push(`incident:${incident.code}`);
        },
      },
    });
  }

  const route = (await import(
    `${mod("app/api/feedback/route.ts")}?spy=cached`
  )) as { POST: (request: Request) => Promise<Response> };
  const queue = (await import(
    `${mod("lib/notificationDeliveries.ts")}?spy=cached`
  )) as typeof import("../../lib/notificationDeliveries");
  const job = (await import(
    `${mod("lib/notificationDeliveryJob.ts")}?spy=cached`
  )) as typeof import("../../lib/notificationDeliveryJob");
  return { route, queue, job };
}

const submit = (message = "the report that must not be lost") =>
  new Request("http://127.0.0.1:3100/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "bug", message }),
  });

const withCapturedLogs = async <T>(run: () => Promise<T>): Promise<T> => {
  const originals = { info: console.info, warn: console.warn, error: console.error };
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

// --- the happy path ---------------------------------------------------------

test("a delivered notification leaves a settled queue row", async () => {
  const { route } = await loadModules();
  const response = await withCapturedLogs(() => route.POST(submit()));

  assert.equal(response.status, 200);
  assert.equal(world.sends.length, 1);
  assert.equal(world.deliveries.length, 1);
  assert.equal(world.deliveries[0].status, "delivered");
  assert.equal(world.deliveries[0].attempts, 1);
  assert.ok(world.deliveries[0].deliveredAt);
});

// --- the regression ---------------------------------------------------------

test("a failed send leaves the report stored and the notification owed", async () => {
  const { route } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 502 upstream" }];
  const response = await withCapturedLogs(() => route.POST(submit()));

  // The submitter is told the report was received, because it was.
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(world.feedback.length, 1);

  // And the notification is remembered rather than dropped.
  const [delivery] = world.deliveries;
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.lastErrorKind, "http_502");
  assert.ok(delivery.nextAttemptAt.getTime() > Date.now());
});

test("a later drain delivers what the first attempt could not", async () => {
  const { route, job } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 503 unavailable" }, "ok"];
  await withCapturedLogs(() => route.POST(submit()));
  assert.equal(world.deliveries[0].status, "pending");

  // The retry is due later; drain with a clock past the backoff.
  const later = new Date(Date.now() + 60 * 60_000);
  const result = await withCapturedLogs(() =>
    job.runNotificationDeliveryDrain({ now: later })
  );

  assert.equal(result.delivered, 1);
  assert.equal(result.pending, 0);
  assert.equal(world.deliveries[0].status, "delivered");
  assert.equal(world.deliveries[0].attempts, 2);
  // The retried mail carries the report, and is byte-identical to the first
  // attempt: the provider's idempotency key only suppresses a duplicate when
  // the payload matches, so a retry must not vary by attempt.
  assert.equal(world.sends.length, 2);
  assert.match(world.sends[1].text, /the report that must not be lost/);
  assert.equal(world.sends[1].text, world.sends[0].text);
  assert.equal(world.sends[1].subject, world.sends[0].subject);
  // And both attempts present the same key, which is what makes them one
  // delivery as far as the provider is concerned.
  assert.equal(world.sends[1].idempotencyKey, world.sends[0].idempotencyKey);
  assert.match(String(world.sends[0].idempotencyKey), /^notification-delivery:/);
});

test("a delivery not yet due is left alone", async () => {
  const { route, job } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 503 unavailable" }, "ok"];
  await withCapturedLogs(() => route.POST(submit()));

  const result = await withCapturedLogs(() =>
    job.runNotificationDeliveryDrain({ now: new Date() })
  );
  assert.equal(result.claimed, 0);
  assert.equal(result.pending, 1);
  assert.equal(world.sends.length, 1);
});

// --- giving up --------------------------------------------------------------

test("a permanently rejected request is abandoned on the first failure", async () => {
  const { route } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 422 invalid recipient" }];
  await withCapturedLogs(() => route.POST(submit()));

  assert.equal(world.deliveries[0].status, "abandoned");
  assert.equal(world.deliveries[0].attempts, 1);
  assert.equal(world.deliveries[0].lastErrorKind, "http_422");
});

test("repeated transient failures abandon, and say so out loud", async () => {
  const { route, job } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 500 boom" }];
  await withCapturedLogs(() => route.POST(submit()));

  let clock = Date.now();
  for (let pass = 0; pass < 8; pass += 1) {
    clock += 24 * 60 * 60_000;
    await withCapturedLogs(() =>
      job.runNotificationDeliveryDrain({ now: new Date(clock) })
    );
    if (world.deliveries[0].status !== "pending") break;
  }

  assert.equal(world.deliveries[0].status, "abandoned");
  assert.equal(world.deliveries[0].attempts, 6);
  // Abandonment is the one outcome nobody else would notice.
  assert.ok(world.logs.some((line) => line.includes("notification_delivery_abandoned")));
  assert.ok(world.logs.includes("incident:NOTIFICATION_DELIVERY_ABANDONED"));
});

// --- idempotency and concurrency --------------------------------------------

test("two overlapping drains never send the same notification twice", async () => {
  const { route, job } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 503 unavailable" }, "ok"];
  await withCapturedLogs(() => route.POST(submit()));

  const later = new Date(Date.now() + 60 * 60_000);
  const [first, second] = await withCapturedLogs(() =>
    Promise.all([
      job.runNotificationDeliveryDrain({ now: later }),
      job.runNotificationDeliveryDrain({ now: later }),
    ])
  );

  assert.equal(first.claimed + second.claimed, 1, "the row was claimed twice");
  assert.equal(world.sends.length, 2, "one original send plus one retry");
  assert.equal(world.deliveries[0].status, "delivered");
});

test("re-enqueuing an existing delivery does not reset its retry state", async () => {
  const { route, queue } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 503 unavailable" }];
  await withCapturedLogs(() => route.POST(submit()));
  const before = { ...world.deliveries[0] };

  await queue.enqueueNotificationDelivery(fakePrisma as never, {
    kind: "support_feedback",
    referenceId: before.referenceId,
  });

  assert.equal(world.deliveries.length, 1);
  assert.equal(world.deliveries[0].attempts, before.attempts);
  assert.equal(world.deliveries[0].status, before.status);
});

// --- nothing to send --------------------------------------------------------

test("a report deleted before its retry stops the queue rather than looping", async () => {
  const { route, job } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 503 unavailable" }, "ok"];
  await withCapturedLogs(() => route.POST(submit()));
  world.feedback = [];

  const later = new Date(Date.now() + 60 * 60_000);
  await withCapturedLogs(() => job.runNotificationDeliveryDrain({ now: later }));

  assert.equal(world.deliveries[0].status, "abandoned");
  assert.equal(world.deliveries[0].lastErrorKind, "source_missing");
  assert.equal(world.sends.length, 1, "a missing report must not be re-sent");
});

test("unconfigured mail is retried rather than treated as delivered", async () => {
  const { route } = await loadModules();
  world.sendScript = ["skip"];
  await withCapturedLogs(() => route.POST(submit()));

  assert.equal(world.deliveries[0].status, "pending");
  assert.equal(world.deliveries[0].lastErrorKind, "not_configured");
});

// --- secrecy ----------------------------------------------------------------

test("the queue stores a pointer to the report, never the report", async () => {
  const { route } = await loadModules();
  world.sendScript = [{ throws: "Email send failed: 503 unavailable" }];
  await withCapturedLogs(() => route.POST(submit("MY-CONFIDENTIAL-COMPLAINT-42")));

  const serialized = JSON.stringify(world.deliveries);
  assert.ok(!serialized.includes("MY-CONFIDENTIAL-COMPLAINT-42"));
  assert.ok(serialized.includes(world.feedback[0].id as string));
});

test("nothing about a failed delivery reaches the log but its classification", async () => {
  const { route, job } = await loadModules();
  world.sendScript = [
    { throws: 'Email send failed: 500 {"echo":"MY-CONFIDENTIAL-COMPLAINT-42"}' },
  ];
  await withCapturedLogs(() => route.POST(submit("MY-CONFIDENTIAL-COMPLAINT-42")));
  await withCapturedLogs(() =>
    job.runNotificationDeliveryDrain({ now: new Date(Date.now() + 60 * 60_000) })
  );

  const logged = world.logs.join("\n");
  assert.ok(!logged.includes("MY-CONFIDENTIAL-COMPLAINT-42"));
  assert.ok(!logged.includes("support@tomverse.app"));
  assert.ok(logged.includes("http_500"));
});
