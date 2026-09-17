import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { deliverNotificationNow, NOTIFICATION_KIND } from "@/lib/notificationDeliveries";
import { prisma } from "@/lib/prisma";
import { recordSuppression } from "@/lib/emailSuppression";
import { sendWithAddressLock } from "@/lib/emailSendLock";
import { ACCOUNT_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  drainStandardEmailDeliveries,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";

// The lock every customer-facing send takes, and what it is for.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.4 (C29),
// docs/policy/email-notifications.md section 9.8.
//
// The race: a lane checks suppression, then reads templates, renders, composes
// a footer and finally calls the provider. Anything committed in between was
// invisible to it. These establish that the decision is taken again inside the
// lock, that the provider call happens while the lock is still held, and that a
// send which cannot take the lock submits nothing and costs no attempt.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SuppressionCause", "SuppressionEntry", "AppSetting",
      "NotificationDelivery", "RefundRequest",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

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

const accepted = () =>
  new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const addressKey = (address: string) =>
  `email-suppression-address:${address.trim().toLowerCase()}`;

/** True when nothing else holds the advisory lock for this address. */
const addressIsFree = async (address: string) => {
  const rows = await prisma.$transaction(async (tx) =>
    tx.$queryRaw<Array<{ taken: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${addressKey(address)})) AS "taken"
    `
  );
  return rows[0]?.taken === true;
};

/** A writer started inside a send, awaited after it, so a failure is not unhandled. */
let writer: Promise<unknown> = Promise.resolve();

/**
 * Waits until a backend is blocked on **this address's** advisory lock.
 *
 * A barrier, not a sleep: "I waited 250ms and it had not finished" is also what
 * a writer that never got as far as the lock looks like. This one returns only
 * once Postgres itself says a session is queued for the lock, which is the fact
 * the test is about.
 *
 * Scoped to the key rather than to "any advisory lock", so a waiter belonging
 * to something else in the same database cannot satisfy it. `pg_advisory_*`
 * splits its 64-bit key across `classid` (the high word) and `objid` (the low
 * one), and `hashtext` returns a signed 32-bit value, which is why the high
 * word is all ones for a negative key.
 */
const waitForBlockedAddressLock = async (address: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
      WITH k AS (SELECT hashtext(${addressKey(address)})::bigint AS key)
      SELECT count(*)::int AS waiting
      FROM pg_locks, k
      WHERE locktype = 'advisory'
        AND NOT granted
        AND classid::bigint = ((k.key >> 32) & 4294967295)
        AND objid::bigint = (k.key & 4294967295)
    `;
    if ((rows[0]?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error("No session ever queued for this address's lock.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Holds the address lock **and** writes a suppression for it, committing only
 * when the returned release runs. Until then the suppression is invisible to
 * anything reading committed rows, which is how a send can pass its pre-check
 * and still have to answer for it at the provider call.
 */
const suppressWhileHoldingAddress = async (address: string) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const transaction = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${addressKey(address)}))`;
      await tx.suppressionEntry.create({
        data: {
          emailAddress: address.trim().toLowerCase(),
          scope: "global",
          purposeKey: "*",
          reason: "hard_bounce",
          source: "provider_webhook",
        },
      });
      acquired();
      await held;
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  await ready;
  return async () => {
    release();
    await transaction;
  };
};

/** Holds the address lock in its own transaction until the returned release runs. */
const holdAddress = async (address: string) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const transaction = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${addressKey(address)}))`;
      acquired();
      await held;
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  await ready;
  return async () => {
    release();
    await transaction;
  };
};

test("the last suppression word is taken inside the lock, and submits nothing", async () => {
  const address = `${randomUUID()}@example.com`;
  await recordSuppression({
    emailAddress: address,
    reason: "hard_bounce",
    source: "provider_webhook",
    sourceEventKey: `webhook:${randomUUID()}`,
  });

  let submitted = 0;
  const result = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    submit: async () => {
      submitted += 1;
      return "sent";
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "suppressed");
  assert.equal(
    result.ok === false && result.reason === "suppressed" ? result.skipReason : null,
    "hard_bounce"
  );
  assert.equal(submitted, 0, "a suppressed address reaches no provider");
});

test("a suppression writer waits for the send it raced, and is seen by the next one", async () => {
  // The other half of the race. The first test proves a writer that got there
  // first is observed; this one proves a writer that got there second cannot
  // commit while the message is on the wire, so no suppression is recorded
  // against a message that had already gone out.
  const address = `${randomUUID()}@example.com`;
  let writerSettled = false;

  const first = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    submit: async () => {
      // Started, not awaited: it has to be blocked on the address lock this
      // transaction holds.
      writer = recordSuppression({
        emailAddress: address,
        reason: "hard_bounce",
        source: "provider_webhook",
        sourceEventKey: `webhook:${randomUUID()}`,
      }).then(() => {
        writerSettled = true;
      });
      // Postgres itself says the writer is queued for an advisory lock. A
      // timer here would prove only that it had not finished, which is also
      // what a writer that never reached the lock looks like.
      await waitForBlockedAddressLock(address);
      assert.equal(writerSettled, false, "the writer waited for the submission");
      return "sent";
    },
  });
  assert.equal(first.ok, true);

  await writer;
  assert.equal(writerSettled, true, "the writer proceeds once the send commits");

  // And the suppression it wrote stops the next message, without a second
  // check anywhere else.
  const second = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    submit: async () => "sent",
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false ? second.reason : null, "suppressed");
});

test("the address is locked while the provider is being called, and free after", async () => {
  const address = `${randomUUID()}@example.com`;
  let lockedDuringSubmit: boolean | null = null;

  const result = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    submit: async () => {
      // A second connection cannot take the address: that is what "in one
      // scope" means. Without it a withdrawal could commit here unseen.
      lockedDuringSubmit = !(await addressIsFree(address));
      return "sent";
    },
  });

  assert.equal(result.ok, true);
  assert.equal(lockedDuringSubmit, true);
  assert.equal(await addressIsFree(address), true, "the lock ends with the transaction");
});

test("a queued message that cannot take the lock waits instead of failing", async () => {
  const address = `${randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: { email: address, name: "Someone" },
  });
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: address,
    userId: user.id,
    payload: { name: "Someone" },
  });
  const calls: unknown[] = [];
  mock.method(globalThis, "fetch", async (...args: unknown[]) => {
    calls.push(args);
    return accepted();
  });

  const release = await holdAddress(address);
  try {
    const drain = await drainStandardEmailDeliveries();
    assert.equal(drain.claimed, 1);
    assert.equal(drain.sent, 0);
    assert.equal(drain.failed, 0);
    assert.equal(drain.abandoned, 0);
    // The drain's own backlog count, not a query rewritten here: a night-time
    // window is on schedule and excluded, and this row is late. If the
    // exclusion ever widened to every deferred row, this is what would say so.
    assert.equal(drain.pending, 1);
  } finally {
    await release();
  }

  assert.equal(calls.length, 0, "nothing was submitted");
  const row = await prisma.emailDelivery.findFirstOrThrow({
    where: { emailAddress: address },
  });
  assert.equal(row.status, "pending");
  // Waiting for somebody else is not a failed attempt, and counting it would
  // spend this message's abandonment budget on their withdrawal.
  assert.equal(row.attempts, 0);
  assert.equal(row.deferReason, "send_lock");
  assert.equal(row.claimedAt, null);
  assert.notEqual(row.nextAttemptAt, null);
  assert.equal(row.lastErrorKind, null);

  // Once the address is free the same row sends, on the next pass.
  await prisma.emailDelivery.update({
    where: { id: row.id },
    data: { nextAttemptAt: new Date(Date.now() - 1_000) },
  });
  const second = await drainStandardEmailDeliveries();
  assert.equal(second.sent, 1);
  const sent = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(sent.status, "sent");
  assert.equal(sent.deferReason, null);
});

test("a suppression committed while a message is being prepared stops it at the provider call", async () => {
  // The one the earlier check cannot catch. The suppression is written by a
  // transaction that holds the address and has not committed, so the drain's
  // pre-check reads a clean address, renders the message, and only meets the
  // suppression when it takes the lock -- which is where the decision the send
  // is made on is taken.
  const address = `${randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: { email: address, name: "Someone" },
  });
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: address,
    userId: user.id,
    payload: { name: "Someone" },
  });
  const calls: unknown[] = [];
  mock.method(globalThis, "fetch", async (...args: unknown[]) => {
    calls.push(args);
    return accepted();
  });

  const release = await suppressWhileHoldingAddress(address);
  // The drain is started, not awaited: it has to get past its pre-check and
  // reach the lock while the writer still holds it.
  const draining = drainStandardEmailDeliveries();
  await waitForBlockedAddressLock(address);
  await release();
  const drain = await draining;

  assert.equal(drain.suppressed, 1, "the message was refused, not sent or deferred");
  assert.equal(drain.sent, 0);
  assert.equal(calls.length, 0, "nothing reached the provider");
  const row = await prisma.emailDelivery.findFirstOrThrow({
    where: { emailAddress: address },
  });
  assert.equal(row.status, "suppressed");
  assert.equal(row.skipReason, "hard_bounce");
});

test("a suppression recorded before the drain stops the message before it is rendered", async () => {
  const address = `${randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: { email: address, name: "Someone" },
  });
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: address,
    userId: user.id,
    payload: { name: "Someone" },
  });
  await recordSuppression({
    emailAddress: address,
    reason: "hard_bounce",
    source: "provider_webhook",
    sourceEventKey: `webhook:${randomUUID()}`,
  });
  const calls: unknown[] = [];
  mock.method(globalThis, "fetch", async (...args: unknown[]) => {
    calls.push(args);
    return accepted();
  });

  const drain = await drainStandardEmailDeliveries();
  assert.equal(drain.suppressed, 1);
  assert.equal(calls.length, 0);
  const row = await prisma.emailDelivery.findFirstOrThrow({
    where: { emailAddress: address },
  });
  assert.equal(row.status, "suppressed");
  assert.equal(row.skipReason, "hard_bounce");
});

test("a refund notice asks suppression too, and costs no attempt when the address is busy", async () => {
  const address = `${randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: { email: address, name: "Someone" },
  });
  const request = await prisma.refundRequest.create({
    data: {
      userId: user.id,
      email: address,
      plan: "pro",
      reason: "test",
      status: "pending",
    },
    select: { id: true },
  });
  const delivery = await prisma.notificationDelivery.create({
    data: {
      kind: NOTIFICATION_KIND.refundRequestReceived,
      referenceId: request.id,
      nextAttemptAt: new Date(Date.now() - 1_000),
    },
    select: { id: true },
  });
  const calls: unknown[] = [];
  mock.method(globalThis, "fetch", async (...args: unknown[]) => {
    calls.push(args);
    return accepted();
  });

  const release = await holdAddress(address);
  try {
    await deliverNotificationNow({
      deliveryId: delivery.id,
      kind: NOTIFICATION_KIND.refundRequestReceived,
      referenceId: request.id,
    });
  } finally {
    await release();
  }

  assert.equal(calls.length, 0, "nothing was submitted");
  const row = await prisma.notificationDelivery.findUniqueOrThrow({
    where: { id: delivery.id },
  });
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.lastErrorKind, "send_lock_unavailable");
});
