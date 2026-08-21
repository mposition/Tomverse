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
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";
import { STANDARD_RETRY_CURVES } from "@/lib/standardEmailRetryCore";
import { decryptSnapshot, readSnapshotKeyring } from "@/lib/emailSnapshotCrypto";

// The standard lane against a real database.
//
// Contract: .github/audits/email-notification-architecture-2026-08-21.md §9.1-9.5.
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
      "EmailPolicyVersion", "User"
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

  const rows = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    language: "ko",
    payload: { name: user.name },
  });

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
  const rows = await enqueueStandardEmail({
    templateKey: BILLING_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { plan: "Pro", billingInterval: "monthly", periodEnd: null },
  });

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
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });

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
  await enqueueStandardEmail({
    templateKey: BILLING_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { plan: "Pro", billingInterval: "monthly", periodEnd: null },
  });

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
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });

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
  const rows = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });
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
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });

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
  const rows = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });

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
  const legal = await enqueueStandardEmail({
    templateKey: ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { scheduledFor: new Date().toISOString() },
  });

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
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });

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
  const rows = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });

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
  const rows = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });

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

  const rows = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: user.name },
  });

  assert.equal(rows, null);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("the enqueue joins the caller's transaction", async () => {
  const user = await someone();

  let failed = false;
  try {
    await prisma.$transaction(async (tx) => {
      await enqueueStandardEmail({
        tx,
        templateKey: ACCOUNT_WELCOME_TEMPLATE,
        emailAddress: user.email,
        userId: user.id,
        payload: { name: "Someone" },
      });
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
