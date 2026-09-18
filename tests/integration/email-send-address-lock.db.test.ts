import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { deliverNotificationNow, NOTIFICATION_KIND } from "@/lib/notificationDeliveries";
import { prisma } from "@/lib/prisma";
import { recordSuppression } from "@/lib/emailSuppression";
import { SUPPRESSION_READ_AUTHORITY_KEY } from "@/lib/emailSuppressionAuthorityCore";
import { sendWithAddressLock } from "@/lib/emailSendLock";
import { SEND_COMMIT_RESERVE_MS } from "@/lib/emailSendLockCore";
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
  delete process.env.MARKETING_RESEND_API_KEY;
  delete process.env.MARKETING_EMAIL_FROM;
  // Production reads the causes, and has since the cutover on 2026-09-17.
  // `suppressionReadAuthorityFromValue` treats an absent row as `entry`, so a
  // suite that truncates `AppSetting` and says nothing would exercise the
  // legacy branch and report it as proof about the live one.
  await prisma.appSetting.create({
    data: { key: SUPPRESSION_READ_AUTHORITY_KEY, value: "causes" },
  });
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
 * Waits for a holder to say it has the lock, or for its transaction to fail.
 *
 * Without the second half, a setup transaction that threw before it reached
 * `acquired()` would leave the test waiting on a promise nothing will ever
 * resolve -- and a broken fixture would be reported as a hang rather than as
 * the error it is.
 */
const readyOrFailed = async (ready: Promise<void>, transaction: Promise<unknown>) => {
  let acquired = false;
  const failedFirst = transaction.then(
    () => {
      if (!acquired) throw new Error("The holder ended before it took the lock.");
    },
    (error) => {
      throw error;
    }
  );
  // A rejection after the race is settled is reported by the release instead,
  // which awaits the same transaction.
  failedFirst.catch(() => {});
  await Promise.race([ready.then(() => { acquired = true; }), failedFirst]);
};

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
const waitForBlockedAddressLock = async (
  address: string,
  options: { timeoutMs?: number; until?: () => boolean } = {}
) => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
      WITH k AS (SELECT hashtext(${addressKey(address)})::bigint AS key)
      SELECT count(*)::int AS waiting
      FROM pg_locks, k
      WHERE locktype = 'advisory'
        AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid::bigint = ((k.key >> 32) & 4294967295)
        AND objid::bigint = (k.key & 4294967295)
        -- 1 is the single-bigint form. A (int, int) advisory lock in the same
        -- database can carry the same classid and objid and would otherwise
        -- satisfy this barrier.
        AND objsubid = 1
        AND mode = 'ExclusiveLock'
    `;
    if ((rows[0]?.waiting ?? 0) > 0) return;
    // The waiter gave up -- a sender waits 2s, this barrier would wait ten.
    // Stopping here fails the test where it went wrong rather than after
    // another eight seconds of polling for something that has gone.
    if (options.until?.()) {
      throw new Error("The send finished before it was seen waiting for the lock.");
    }
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
      // A cause, because that is what production decides from. The row is
      // written here rather than through `recordSuppression()` because that
      // opens its own transaction and takes this same lock; what is being
      // reproduced is a writer that holds the lock and has not committed.
      await tx.suppressionCause.create({
        data: {
          emailAddress: address.trim().toLowerCase(),
          scope: "global",
          purposeKey: "*",
          reason: "hard_bounce",
          source: "provider_webhook",
          sourceEventKey: `webhook:${randomUUID()}`,
          occurredAt: new Date(),
        },
      });
      acquired();
      await held;
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  await readyOrFailed(ready, transaction);
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
  await readyOrFailed(ready, transaction);
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

  const calls: unknown[] = [];
  mock.method(globalThis, "fetch", async (...args: unknown[]) => {
    calls.push(args);
    return accepted();
  });
  const result = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    message: { subject: "s", html: "<p>s</p>", text: "s" },
    senderRole: "security",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "suppressed");
  assert.equal(
    result.ok === false && result.reason === "suppressed" ? result.skipReason : null,
    "hard_bounce"
  );
  assert.equal(calls.length, 0, "a suppressed address reaches no provider");
});

test("a suppression writer waits for the send it raced, and is seen by the next one", async () => {
  // The other half of the race. The first test proves a writer that got there
  // first is observed; this one proves a writer that got there second cannot
  // commit while the message is on the wire, so no suppression is recorded
  // against a message that had already gone out.
  const address = `${randomUUID()}@example.com`;
  let writerSettled = false;

  // The provider call is where the lock is held, so the race is run from
  // inside it.
  mock.method(globalThis, "fetch", async () => {
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
    // Postgres itself says the writer is queued for an advisory lock. A timer
    // here would prove only that it had not finished, which is also what a
    // writer that never reached the lock looks like.
    await waitForBlockedAddressLock(address);
    assert.equal(writerSettled, false, "the writer waited for the submission");
    return accepted();
  });
  const first = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    message: { subject: "s", html: "<p>s</p>", text: "s" },
    senderRole: "security",
  });
  assert.equal(first.ok, true);

  await writer;
  assert.equal(writerSettled, true, "the writer proceeds once the send commits");

  // And the suppression it wrote stops the next message, without a second
  // check anywhere else.
  const second = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    message: { subject: "s", html: "<p>s</p>", text: "s" },
    senderRole: "security",
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false ? second.reason : null, "suppressed");
});

test("a transaction with nothing left submits nothing at all", async () => {
  // The locks and the reads can take the transaction's life. What is left then
  // is not a short send -- it is no send, because the rollback would release
  // the address while the request was still in flight.
  const address = `${randomUUID()}@example.com`;

  const calls: unknown[] = [];
  mock.method(globalThis, "fetch", async (...args: unknown[]) => {
    calls.push(args);
    return accepted();
  });
  const result = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    // Whatever the locks cost, the reserve alone accounts for all of it.
    lockTimeoutMs: SEND_COMMIT_RESERVE_MS,
    transactionTimeoutMs: SEND_COMMIT_RESERVE_MS,
    providerTimeoutMs: 10_000,
    message: { subject: "s", html: "<p>s</p>", text: "s" },
    senderRole: "security",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "lock_unavailable");
  assert.equal(
    result.ok === false && result.reason === "lock_unavailable" ? result.cause : null,
    "budget",
    "refused for the budget, not for contention"
  );
  assert.equal(calls.length, 0, "nothing reached the provider");
});

test("the address is locked while the provider is being called, and free after", async () => {
  const address = `${randomUUID()}@example.com`;
  let lockedDuringSubmit: boolean | null = null;

  mock.method(globalThis, "fetch", async () => {
    // A second connection cannot take the address: that is what "in one scope"
    // means. Without it a withdrawal could commit here unseen.
    lockedDuringSubmit = !(await addressIsFree(address));
    return accepted();
  });
  const result = await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    message: { subject: "s", html: "<p>s</p>", text: "s" },
    senderRole: "security",
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
  assert.equal(row.deferReason, "send_not_submitted");
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
  let draining: ReturnType<typeof drainStandardEmailDeliveries> | null = null;
  let drainSettled = false;
  let barrierFailure: unknown = null;
  try {
    draining = drainStandardEmailDeliveries();
    // Both branches, so a rejection here is not an unhandled one; the promise
    // itself is awaited below, which is where a failure is reported.
    void draining.then(
      () => {
        drainSettled = true;
      },
      () => {
        drainSettled = true;
      }
    );
    await waitForBlockedAddressLock(address, { until: () => drainSettled });
  } catch (error) {
    barrierFailure = error;
  } finally {
    // Always: a holder left open would hold this address for thirty seconds and
    // block the next test's TRUNCATE.
    await release();
  }
  const drain = draining ? await draining : null;
  if (barrierFailure) throw barrierFailure;
  if (!drain) throw new Error("The drain never started.");

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
  assert.equal(row.lastErrorKind, "send_not_submitted");
});

test("the message, the identity and the idempotency key reach the provider", async () => {
  // The helper submits now, so what a lane hands it has to arrive unchanged.
  // Nothing pinned that: the headers marketing depends on, the stream that
  // decides the sending domain, the sender role and the key that makes a retry
  // one message rather than two all pass through one call
  // (independent review, 2026-09-18).
  const address = `${randomUUID()}@example.com`;
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  process.env.MARKETING_EMAIL_FROM = "Tomverse News <news@news.tomverse.app>";
  const requests: RequestInit[] = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(init);
    return accepted();
  });

  const result = await sendWithAddressLock({
    emailAddress: address,
    classification: "marketing",
    message: {
      subject: "A subject",
      html: "<p>Body</p>",
      text: "Body",
      headers: { "List-Unsubscribe": "<https://tomverse.app/u/abc>" },
    },
    stream: "marketing",
    senderRole: "marketing",
    idempotencyKey: "delivery-42",
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  const request = requests[0];
  const sent = JSON.parse(String(request.body));
  assert.equal(sent.to, address);
  assert.equal(sent.from, "Tomverse News <news@news.tomverse.app>");
  assert.equal(sent.subject, "A subject");
  assert.equal(sent.html, "<p>Body</p>");
  assert.equal(sent.text, "Body");
  assert.equal(sent.headers["List-Unsubscribe"], "<https://tomverse.app/u/abc>");
  assert.equal(new Headers(request.headers).get("Idempotency-Key"), "delivery-42");
});

test("a message with no headers carries none", async () => {
  // Transactional mail must not acquire an unsubscribe header by passing
  // through a helper that also serves marketing
  // (docs/policy/email-notifications.md §5.1 C10).
  const address = `${randomUUID()}@example.com`;
  const bodies: string[] = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    return accepted();
  });

  await sendWithAddressLock({
    emailAddress: address,
    classification: "transactional",
    message: { subject: "s", html: "<p>s</p>", text: "s" },
    senderRole: "security",
  });

  const sent = JSON.parse(bodies[0]);
  assert.equal(sent.headers, undefined);
});
