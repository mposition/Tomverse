import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
  ACCOUNT_WELCOME_TEMPLATE,
  BILLING_WELCOME_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import {
  drainStandardEmailDeliveries,
  enqueueRefused,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";
import { STANDARD_RETRY_CURVES } from "@/lib/standardEmailRetryCore";
import {
  STANDARD_EMAIL_OLDEST_PENDING_ALERT_MS,
  STANDARD_EMAIL_QUEUE_DEPTH_ALERT,
} from "@/lib/standardEmailLane";
import { observeOperationalIncidents } from "@/lib/operationalMonitoring";
import { decryptSnapshot, readSnapshotKeyring } from "@/lib/emailSnapshotCrypto";
import { enqueuedRow } from "../support/enqueuedEmail";

// The standard lane against a real database.
//
// Contract: docs/policy/email-notifications.md §9.1-9.5.
//
// The guarantee here is the opposite of the credential lane's: the message
// survives the process. So most of these establish that a send which failed, or
// never happened at all, still happens later -- and that the message which
// eventually goes out is the one that was owed, not a re-render against rows
// that have since changed.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "ScheduledJobRun", "User"
    RESTART IDENTITY CASCADE
  `);

const stubFetch = (responses: Array<Response | Error>) => {
  const calls: RequestInit[] = [];
  let index = 0;
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push(init);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls: () => calls, count: () => index };
};

const accepted = () =>
  new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const refused = (status: number) => new Response("{}", { status });

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.RESEND_API_KEY = "test-key";
});

after(async () => {
  mock.restoreAll();
  await reset();
  await prisma.$disconnect();
});

const someone = () =>
  prisma.user.create({
    data: { email: `${randomUUID()}@example.com`, name: "Someone" },
  });

test("enqueuing writes an outbox row and sends nothing yet", async () => {
  const user = await someone();
  const fetches = stubFetch([accepted()]);

  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    language: "ko",
    payload: { name: user.name },
  }));

  assert.ok(rows);
  assert.equal(fetches.count(), 0, "enqueue must not send");

  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows.deliveryId },
  });
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.lane, "standard");
  assert.equal(delivery.language, "ko");
  assert.equal(delivery.recipientKey, `user:${user.id}`);
});

test("the personalisation snapshot is stored encrypted", async () => {
  const user = await someone();
  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey: BILLING_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { plan: "Pro", billingInterval: "monthly", periodEnd: null },
  }));

  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
  });

  // The plan name must not be readable from the row itself: this table is what
  // a database dump, a backup or a replica exposes.
  assert.equal(JSON.stringify(delivery.renderDataSnapshot).includes("Pro"), false);

  const keyring = readSnapshotKeyring(process.env)!;
  assert.deepEqual(decryptSnapshot(delivery.renderDataSnapshot, keyring), {
    plan: "Pro",
    billingInterval: "monthly",
    periodEnd: null,
  });
});

test("a drain sends the message and records what it sent", async () => {
  const user = await someone();
  enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));

  const fetches = stubFetch([accepted()]);
  const result = await drainStandardEmailDeliveries();

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(fetches.count(), 1);

  const delivery = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(delivery.status, "sent");
  assert.ok(delivery.sentAt);
  assert.ok(delivery.providerMessageId);
  assert.ok(delivery.renderedSubject);
  assert.equal(delivery.renderedHashKeyVersion, "v1");
  assert.equal(delivery.claimedAt, null);
});

test("the drain renders from the snapshot, not from live rows", async () => {
  const user = await someone();
  enqueuedRow(await enqueueStandardEmail({
    templateKey: BILLING_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { plan: "Pro", billingInterval: "monthly", periodEnd: null },
  }));

  // The account upgrades between the enqueue and the drain. The receipt that
  // goes out is still the one that was owed -- re-reading the account would
  // send a Max receipt for a Pro purchase.
  await prisma.user.update({ where: { id: user.id }, data: { plan: "Max" } });

  const fetches = stubFetch([accepted()]);
  await drainStandardEmailDeliveries();

  const body = JSON.parse(String(fetches.calls()[0].body));
  assert.ok(body.subject.includes("Pro"), `subject was: ${body.subject}`);
  assert.equal(body.subject.includes("Max"), false);
});

test("a message that failed to send is tried again later, not lost", async () => {
  const user = await someone();
  enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));

  stubFetch([refused(503)]);
  const first = await drainStandardEmailDeliveries();
  assert.equal(first.sent, 0);

  const waiting = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.attempts, 1);
  assert.equal(waiting.lastErrorKind, "http_503");
  assert.ok(waiting.nextAttemptAt);
  // Backed off rather than retried immediately, and unclaimed so another
  // worker may take it.
  assert.ok(waiting.nextAttemptAt.getTime() > Date.now());
  assert.equal(waiting.claimedAt, null);

  // A due row is picked up and delivered by a later pass. That is the whole
  // guarantee this lane exists for.
  await prisma.emailDelivery.update({
    where: { id: waiting.id },
    data: { nextAttemptAt: new Date(Date.now() - 1_000) },
  });
  mock.restoreAll();
  stubFetch([accepted()]);
  const second = await drainStandardEmailDeliveries();
  assert.equal(second.sent, 1);

  const delivered = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(delivered.status, "sent");
  assert.equal(delivered.attempts, 2);
});

test("a row not yet due is left alone", async () => {
  const user = await someone();
  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));
  await prisma.emailDelivery.update({
    where: { id: rows!.deliveryId },
    data: { nextAttemptAt: new Date(Date.now() + 60_000) },
  });

  const fetches = stubFetch([accepted()]);
  const result = await drainStandardEmailDeliveries();

  assert.equal(result.claimed, 0);
  assert.equal(fetches.count(), 0);
});

test("a permanent refusal stops immediately instead of burning the curve", async () => {
  const user = await someone();
  enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));

  const fetches = stubFetch([refused(400), accepted()]);
  const result = await drainStandardEmailDeliveries();

  assert.equal(result.failed, 1);
  assert.equal(fetches.count(), 1);

  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "failed");
  assert.equal(row.nextAttemptAt, null);
});

test("a message is abandoned once its curve runs out, and says so", async () => {
  const user = await someone();
  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));

  // Already at the end of the transactional curve.
  await prisma.emailDelivery.update({
    where: { id: rows!.deliveryId },
    data: { attempts: STANDARD_RETRY_CURVES.transactional.length },
  });

  stubFetch([refused(503)]);
  const result = await drainStandardEmailDeliveries();

  assert.equal(result.abandoned, 1);
  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "abandoned");
  assert.equal(row.nextAttemptAt, null);
});

test("the legal curve outlasts the transactional one on the same failure", async () => {
  const user = await someone();
  const legal = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { scheduledFor: new Date().toISOString() },
  }));

  // At the point a transactional message would already be abandoned, a
  // deletion notice is still trying: it is the notice that an account and
  // everything in it is about to be destroyed.
  await prisma.emailDelivery.update({
    where: { id: legal!.deliveryId },
    data: { attempts: STANDARD_RETRY_CURVES.transactional.length },
  });

  stubFetch([refused(503)]);
  const result = await drainStandardEmailDeliveries();

  assert.equal(result.abandoned, 0);
  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "pending");
});

test("an unconfigured provider waits rather than failing the message", async () => {
  const user = await someone();
  enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));

  delete process.env.RESEND_API_KEY;
  const fetches = stubFetch([accepted()]);
  const result = await drainStandardEmailDeliveries();

  assert.equal(fetches.count(), 0);
  assert.equal(result.sent, 0);

  // Unlike the credential lane, this one has hours. A key installed later
  // still delivers the receipt; a message failed outright never would.
  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "pending");
  assert.equal(row.lastErrorKind, "not_configured");
});

test("a claimed row is not taken twice", async () => {
  const user = await someone();
  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));

  // Another worker holds it, recently.
  await prisma.emailDelivery.update({
    where: { id: rows!.deliveryId },
    data: { claimedAt: new Date() },
  });

  const fetches = stubFetch([accepted()]);
  const result = await drainStandardEmailDeliveries();

  assert.equal(result.claimed, 0);
  assert.equal(fetches.count(), 0);
});

test("a claim left behind by a killed worker is reclaimed", async () => {
  const user = await someone();
  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));

  await prisma.emailDelivery.update({
    where: { id: rows!.deliveryId },
    data: { claimedAt: new Date(Date.now() - 60 * 60_000) },
  });

  stubFetch([accepted()]);
  const result = await drainStandardEmailDeliveries();

  // A claim held forever is a message that silently stops moving, which
  // nothing else in the system would notice.
  assert.equal(result.sent, 1);
});

test("an account with no address enqueues nothing and does not throw", async () => {
  const user = await prisma.user.create({ data: { name: "No address" } });

  const result = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: user.name },
  });

  // Named, not a bare `null` (EM-05). The old return said nothing was written
  // and nothing about why, so a caller could not tell an account with no
  // address from a feature that had been switched off.
  assert.ok(enqueueRefused(result));
  assert.equal(result.refused, "no_address");
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("the enqueue joins the caller's transaction", async () => {
  const user = await someone();

  let failed = false;
  try {
    await prisma.$transaction(async (tx) => {
      enqueuedRow(await enqueueStandardEmail({
        tx,
        templateKey: ACCOUNT_WELCOME_TEMPLATE,
        emailAddress: user.email,
        userId: user.id,
        payload: { name: "Someone" },
      }));
      throw new Error("the thing being announced failed to commit");
    });
  } catch {
    failed = true;
  }

  // The message is owed only if the thing it announces happened. Committing
  // the notification separately would announce something that never occurred.
  assert.equal(failed, true);
  assert.equal(await prisma.emailDelivery.count(), 0);
  assert.equal(await prisma.emailEvent.count(), 0);
});

// ---------------------------------------------------------------------------
// What abandonment tells an operator (§9.4 "소진 시", §9.5)
// ---------------------------------------------------------------------------

/** Collects the incidents raised during one drain. */
const watchIncidents = () => {
  const seen: Array<{ code: string; severity: string; context: unknown }> = [];
  const stop = observeOperationalIncidents((incident) => {
    seen.push({
      code: incident.code,
      severity: incident.severity,
      context: incident.context,
    });
  });
  return { seen, stop };
};

test("a legal abandonment is its own critical incident, not a line in a total", async () => {
  // The failure this pins: one drain that abandons a deletion notice and a
  // receipt used to raise a single `error` saying "2 message(s)". An operator
  // reading that cannot tell whether anyone has to be woken -- and §9.4 gives
  // legal an answer the others do not have.
  const user = await someone();
  const legal = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { scheduledFor: new Date().toISOString() },
  }));
  const transactional = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  }));

  await prisma.emailDelivery.updateMany({
    where: { id: legal!.deliveryId },
    data: { attempts: STANDARD_RETRY_CURVES.legal.length },
  });
  await prisma.emailDelivery.updateMany({
    where: { id: transactional!.deliveryId },
    data: { attempts: STANDARD_RETRY_CURVES.transactional.length },
  });

  stubFetch([refused(503)]);
  const watcher = watchIncidents();
  let result;
  try {
    result = await drainStandardEmailDeliveries();
  } finally {
    watcher.stop();
  }

  assert.equal(result.abandoned, 2);
  assert.equal(result.abandonedByClassification.legal, 1);
  assert.equal(result.abandonedByClassification.transactional, 1);
  assert.equal(result.abandonedByClassification.marketing, 0);

  const abandonment = watcher.seen.filter((incident) =>
    incident.code.endsWith("_DELIVERY_ABANDONED")
  );
  const byCode = new Map(abandonment.map((incident) => [incident.code, incident]));
  assert.equal(
    byCode.size,
    2,
    `expected one incident per classification, got ${abandonment.map((i) => i.code).join(", ")}`
  );

  const legalIncident = byCode.get("EMAIL_LEGAL_DELIVERY_ABANDONED");
  assert.ok(legalIncident, "the legal abandonment raised no incident of its own");
  assert.equal(legalIncident.severity, "fatal");

  const transactionalIncident = byCode.get(
    "EMAIL_TRANSACTIONAL_DELIVERY_ABANDONED"
  );
  assert.ok(transactionalIncident);
  assert.equal(transactionalIncident.severity, "error");
});

// EM-11: a backlog is visible while the mail is merely late.
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md EM-11.
//
// Abandonment already raised an incident, and the audit's point is that it
// arrives once a message is lost. These two fire while it can still be sent.

/** `count` queued messages, optionally aged by backdating them. */
const queueDepth = async (count: number, agedMs = 0) => {
  const user = await someone();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const rows = enqueuedRow(await enqueueStandardEmail({
      templateKey: ACCOUNT_WELCOME_TEMPLATE,
      emailAddress: `queued-${index}-${randomUUID()}@example.com`,
      userId: user.id,
      language: "en",
      payload: { name: "Someone" },
    }));
    ids.push(rows!.deliveryId);
  }
  if (agedMs > 0) {
    const createdAt = new Date(Date.now() - agedMs);
    await prisma.emailDelivery.updateMany({
      where: { id: { in: ids } },
      // nextAttemptAt too, or the aged rows would be claimed by the pass that
      // is supposed to observe them still waiting.
      data: { createdAt, nextAttemptAt: new Date(Date.now() + 60_000) },
    });
  }
  return ids;
};

test("a deep queue is reported before anything abandons", async () => {
  await queueDepth(STANDARD_EMAIL_QUEUE_DEPTH_ALERT + 1, 60_000);
  const { seen, stop } = watchIncidents();
  stubFetch([]);

  try {
    await drainStandardEmailDeliveries({ limit: 1 });
  } finally {
    stop();
  }

  const backlog = seen.find((i) => i.code === "EMAIL_STANDARD_DRAIN_BACKLOG");
  assert.ok(backlog, `no backlog incident: ${JSON.stringify(seen)}`);
  assert.equal(backlog.severity, "warning");
  assert.equal(
    (backlog.context as { trigger?: string }).trigger,
    "queue_depth"
  );
  // Nothing abandoned: the whole point is that this is the earlier signal.
  assert.equal(
    seen.filter((i) => i.code.includes("ABANDON")).length,
    0
  );
});

test("a shallow queue that stopped moving is reported too", async () => {
  // Five messages waiting six hours is five people who never got their
  // receipt, and the depth is never remarkable.
  await queueDepth(5, STANDARD_EMAIL_OLDEST_PENDING_ALERT_MS + 60_000);
  const { seen, stop } = watchIncidents();
  stubFetch([]);

  try {
    await drainStandardEmailDeliveries({ limit: 10 });
  } finally {
    stop();
  }

  const backlog = seen.find((i) => i.code === "EMAIL_STANDARD_DRAIN_BACKLOG");
  assert.ok(backlog, `no backlog incident: ${JSON.stringify(seen)}`);
  assert.equal(
    (backlog.context as { trigger?: string }).trigger,
    "oldest_pending"
  );
});

test("an ordinary queue reports nothing", async () => {
  await queueDepth(3);
  const { seen, stop } = watchIncidents();
  stubFetch([accepted(), accepted(), accepted()]);

  try {
    await drainStandardEmailDeliveries({ limit: 10 });
  } finally {
    stop();
  }

  assert.equal(
    seen.filter((i) => i.code === "EMAIL_STANDARD_DRAIN_BACKLOG").length,
    0,
    `a healthy drain must be quiet: ${JSON.stringify(seen)}`
  );
});

test("the drain reports the age of the oldest waiting message", async () => {
  await queueDepth(2, 90 * 60 * 1_000);
  stubFetch([]);

  const result = await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(result.pending, 2);
  assert.ok(
    (result.oldestPendingMs ?? 0) >= 90 * 60 * 1_000,
    `oldestPendingMs was ${result.oldestPendingMs}`
  );
});

test("an empty queue has no oldest message rather than an age of zero", async () => {
  // null and 0 are different answers, and a dashboard that showed "0 minutes"
  // for an empty queue would look like a queue moving perfectly.
  stubFetch([]);
  const result = await drainStandardEmailDeliveries({ limit: 1 });
  assert.equal(result.pending, 0);
  assert.equal(result.oldestPendingMs, null);
});

test("the drain records its own job run, separate from the operator queue's", async () => {
  // EM-11's other half. The operator drain succeeding said nothing about
  // whether anybody's receipt went out, and /admin/jobs showed one green row
  // for both. Driven through the wrapper both queues share, so this asserts
  // what the console will actually read.
  const { runNotificationDeliveryDrain } = await import(
    "@/lib/notificationDeliveryJob"
  );
  await queueDepth(1);
  stubFetch([accepted()]);

  await runNotificationDeliveryDrain();

  const runs = await prisma.scheduledJobRun.findMany({
    select: { jobKey: true, status: true, processedCount: true },
    orderBy: { jobKey: "asc" },
  });
  const keys = runs.map((row) => row.jobKey);
  assert.ok(
    keys.includes("standard_email_drain"),
    `user mail has no run of its own: ${JSON.stringify(keys)}`
  );
  assert.ok(keys.includes("notification_delivery_retry"), "and the operator queue keeps its own");

  const userMail = runs.find((row) => row.jobKey === "standard_email_drain")!;
  assert.equal(userMail.status, "succeeded");
  assert.equal(userMail.processedCount, 1, "what it moved, not that it ran");
});
