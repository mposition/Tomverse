import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  CREDENTIAL_LANE,
  createCredentialDeliveryRows,
  sendCredentialEmailNow,
  sweepExpiredCredentialDeliveries,
} from "@/lib/credentialEmailLane";
import { AUTH_LOGIN_CODE_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  ensureBootstrapPolicyVersion,
  ensureTemplateVersion,
} from "@/lib/emailTemplateRegistry";

// The credential synchronous lane against a real database.
//
// Contract: .github/audits/email-notification-architecture-2026-08-21.md §9.4a.
//
// What is being established here is mostly what the lane *refuses* to do. It
// does not store the credential, it does not retry in the background, and it
// does not send a code that died while an earlier attempt was backing off. Each
// of those is a decision that looks like a missing feature from the outside, so
// each one is pinned by a test that fails if someone adds it back.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "EmailLoginAttempt"
    RESTART IDENTITY CASCADE
  `);

const template = {
  templateKey: AUTH_LOGIN_CODE_TEMPLATE,
  language: "en",
};

/** A live credential, as lib/emailLogin.ts would have just written. */
const liveAttempt = (overrides: Record<string, unknown> = {}) =>
  prisma.emailLoginAttempt.create({
    data: {
      email: `${randomUUID()}@example.com`,
      codeHash: randomUUID(),
      linkTokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      ...overrides,
    },
  });

/** Stands in for the provider, so no attempt leaves the process. */
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

const refused = (status: number, headers?: Record<string, string>) =>
  new Response("{}", { status, ...(headers ? { headers } : {}) });

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.RESEND_API_KEY = "test-key";
});

after(async () => {
  mock.restoreAll();
  await reset();
  await prisma.$disconnect();
});

const enqueue = async (attemptId: string, emailAddress: string) => {
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const registered = await ensureTemplateVersion(template);
  return prisma.$transaction((tx) =>
    createCredentialDeliveryRows(tx, {
      attemptId,
      emailAddress,
      language: "en",
      policyVersionId,
      templateVersionId: registered.templateVersionId,
      templateId: registered.templateId,
    })
  );
};

test("the template registry stores the template, not the message", async () => {
  const first = await ensureTemplateVersion(template);
  const again = await ensureTemplateVersion(template);

  // Unchanged copy reuses the row. Registering the rendered message instead
  // would mint one version per sign-in, because the code differs every time.
  assert.equal(again.templateVersionId, first.templateVersionId);

  // The registered body carries the variables rather than a real code, which
  // is what makes the hash stable across sends.
  const stored = await prisma.templateVersion.findUniqueOrThrow({
    where: { id: first.templateVersionId },
  });
  assert.ok(stored.bodyText.includes("{{code}}"));
  assert.equal(stored.status, "published");
  assert.equal(stored.version, 1);

  // Changed copy would be a new version, never an edit. Simulated by retiring
  // the published row: the lookup requires `published`, so the next call has to
  // mint version 2 rather than reuse what is there.
  await prisma.templateVersion.update({
    where: { id: first.templateVersionId },
    data: { status: "retired" },
  });
  const changed = await ensureTemplateVersion(template);
  assert.notEqual(changed.templateVersionId, first.templateVersionId);

  const versions = await prisma.templateVersion.findMany({
    where: { templateId: first.templateId },
    orderBy: { version: "asc" },
  });
  assert.deepEqual(
    versions.map((row) => row.version),
    [1, 2]
  );
});

test("the attempt and its delivery record commit together or not at all", async () => {
  const attempt = await liveAttempt();

  let failed = false;
  try {
    await prisma.$transaction(async (tx) => {
      const policyVersionId = await ensureBootstrapPolicyVersion();
      const registered = await ensureTemplateVersion(template);
      await createCredentialDeliveryRows(tx, {
        attemptId: attempt.id,
        emailAddress: attempt.email,
        language: "en",
        policyVersionId,
        templateVersionId: registered.templateVersionId,
        templateId: registered.templateId,
      });
      throw new Error("something after the writes went wrong");
    });
  } catch {
    failed = true;
  }

  assert.equal(failed, true);
  assert.equal(await prisma.emailEvent.count(), 0);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("the outbox rows carry no credential anywhere", async () => {
  const attempt = await liveAttempt();
  const { deliveryId } = await enqueue(attempt.id, attempt.email);

  const event = await prisma.emailEvent.findFirstOrThrow();
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });

  // The payload references the attempt and says nothing else. The code and the
  // link token are the entire content of this message, so anything richer here
  // would be the stored credential approach B exists to avoid.
  assert.deepEqual(event.payload, {
    attemptId: attempt.id,
    language: "en",
  });
  assert.equal(delivery.lane, CREDENTIAL_LANE);
  assert.equal(delivery.renderDataSnapshot, null);
  assert.equal(delivery.userId, null);
  assert.equal(delivery.recipientKey, `addr:${attempt.email}`);
});

test("a delivered send records a keyed hash and names its key version", async () => {
  const attempt = await liveAttempt();
  const { deliveryId, idempotencyKey } = await enqueue(attempt.id, attempt.email);
  const fetches = stubFetch([accepted()]);

  const result = await sendCredentialEmailNow({
    deliveryId,
    attemptId: attempt.id,
    to: attempt.email,
    subject: "Your Tomverse login code",
    html: "<p>418293</p>",
    text: "418293",
    idempotencyKey,
  });

  assert.equal(result.sent, true);
  assert.equal(fetches.count(), 1);

  const row = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 1);
  assert.ok(row.sentAt);
  assert.equal(row.renderedHashKeyVersion, "v1");
  assert.ok(row.renderedHash);

  // Keyed, so the hash cannot be walked back to the six-digit code it covers.
  // A plain SHA-256 of the same body would be reversible in a million tries.
  const { createHash } = await import("node:crypto");
  const unkeyed = createHash("sha256")
    .update("Your Tomverse login code\n<p>418293</p>\n418293")
    .digest("hex");
  assert.notEqual(row.renderedHash, unkeyed);

  // Still no snapshot, and the database would refuse one on this lane anyway.
  assert.equal(row.renderDataSnapshot, null);
});

test("a transient failure is retried inside the request and can still succeed", async () => {
  const attempt = await liveAttempt();
  const { deliveryId, idempotencyKey } = await enqueue(attempt.id, attempt.email);
  const fetches = stubFetch([refused(502), accepted()]);

  const result = await sendCredentialEmailNow({
    deliveryId,
    attemptId: attempt.id,
    to: attempt.email,
    subject: "s",
    html: "h",
    text: "t",
    idempotencyKey,
    sleep: async () => {},
  });

  assert.equal(result.sent, true);
  assert.equal(fetches.count(), 2);

  // Every attempt presents the same key, which is the only reason a provider
  // that already accepted the first one will not send a second copy.
  const keys = fetches
    .calls()
    .map((init) => (init.headers as Record<string, string>)["Idempotency-Key"]);
  assert.deepEqual(keys, [idempotencyKey, idempotencyKey]);

  const row = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 2);
});

test("a permanent failure stops on the first answer", async () => {
  const attempt = await liveAttempt();
  const { deliveryId, idempotencyKey } = await enqueue(attempt.id, attempt.email);
  // 400 is not on the retry allowlist, so the budget is not spent on it.
  const fetches = stubFetch([refused(400), accepted()]);

  const result = await sendCredentialEmailNow({
    deliveryId,
    attemptId: attempt.id,
    to: attempt.email,
    subject: "s",
    html: "h",
    text: "t",
    idempotencyKey,
    sleep: async () => {},
  });

  assert.equal(result.sent, false);
  assert.equal(result.sent === false && result.reason, "send_failed");
  assert.equal(fetches.count(), 1);

  const row = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });
  assert.equal(row.status, "failed");
  assert.equal(row.lastErrorKind, "http_400");
  // `abandoned` would claim a retry schedule this lane does not have, and the
  // database refuses it outright.
  assert.notEqual(row.status, "abandoned");
});

test("a provider-side suppression is recorded as a decision, not a fault", async () => {
  const attempt = await liveAttempt();
  const { deliveryId, idempotencyKey } = await enqueue(attempt.id, attempt.email);
  stubFetch([refused(422)]);

  const result = await sendCredentialEmailNow({
    deliveryId,
    attemptId: attempt.id,
    to: attempt.email,
    subject: "s",
    html: "h",
    text: "t",
    idempotencyKey,
    sleep: async () => {},
  });

  assert.equal(result.sent, false);

  // Resend's suppression list is account-wide across every domain in a region
  // (contract §5.3.1), so a marketing complaint can refuse a login code. That
  // is worth telling apart from a broken send.
  const row = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });
  assert.equal(row.status, "suppressed");
  assert.equal(row.skipReason, "suppressed_complaint");
});

test("a credential that died while retrying is not sent", async () => {
  const attempt = await liveAttempt();
  const { deliveryId, idempotencyKey } = await enqueue(attempt.id, attempt.email);
  const fetches = stubFetch([refused(503), accepted()]);

  // Between the first attempt and the retry, the user requests a new code --
  // which lib/emailLogin.ts invalidates the outstanding one to do.
  const result = await sendCredentialEmailNow({
    deliveryId,
    attemptId: attempt.id,
    to: attempt.email,
    subject: "s",
    html: "h",
    text: "t",
    idempotencyKey,
    sleep: async () => {
      await prisma.emailLoginAttempt.update({
        where: { id: attempt.id },
        data: { invalidatedAt: new Date() },
      });
    },
  });

  assert.equal(result.sent, false);
  assert.equal(result.sent === false && result.reason, "credential_expired");

  // The second attempt never reached the provider: a code that arrives dead is
  // worse than one that never arrives, because the recipient types it, is
  // refused, and concludes the account is broken.
  assert.equal(fetches.count(), 1);

  const row = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });
  assert.equal(row.status, "skipped");
  assert.equal(row.skipReason, "credential_expired");
});

test("an expired credential is refused before the first attempt", async () => {
  const attempt = await liveAttempt({
    expiresAt: new Date(Date.now() - 60_000),
  });
  const { deliveryId, idempotencyKey } = await enqueue(attempt.id, attempt.email);
  const fetches = stubFetch([accepted()]);

  const result = await sendCredentialEmailNow({
    deliveryId,
    attemptId: attempt.id,
    to: attempt.email,
    subject: "s",
    html: "h",
    text: "t",
    idempotencyKey,
  });

  assert.equal(result.sent, false);
  assert.equal(fetches.count(), 0);
});

test("the sweep closes abandoned rows and never resends", async () => {
  const dead = await liveAttempt({ expiresAt: new Date(Date.now() - 60_000) });
  const live = await liveAttempt();
  const deadRows = await enqueue(dead.id, dead.email);
  const liveRows = await enqueue(live.id, live.email);

  // Both look like a process that died between the transaction and the send.
  await prisma.emailDelivery.updateMany({
    where: { id: { in: [deadRows.deliveryId, liveRows.deliveryId] } },
    data: { createdAt: new Date(Date.now() - 5 * 60_000) },
  });

  const fetches = stubFetch([accepted()]);
  const swept = await sweepExpiredCredentialDeliveries();

  assert.equal(swept.swept, 1);
  assert.equal(fetches.count(), 0, "the sweep must never send");

  const closed = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deadRows.deliveryId },
  });
  assert.equal(closed.status, "skipped");
  assert.equal(closed.skipReason, "credential_expired");

  // A row whose credential is still live is left alone: the request that owns
  // it may still be in flight.
  const untouched = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: liveRows.deliveryId },
  });
  assert.equal(untouched.status, "pending");
});
