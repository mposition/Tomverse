import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { releaseExpiredSuppressionCauses } from "@/lib/emailProviderEvents";
import { recordSuppression, suppressionCheck } from "@/lib/emailSuppression";
import { SOFT_BOUNCE_SUPPRESSION_THRESHOLD } from "@/lib/emailSuppressionCore";
import { ACCOUNT_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { processResendWebhook } from "@/lib/emailWebhookProcessing";
import { prisma } from "@/lib/prisma";
import {
  drainStandardEmailDeliveries,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";

// Provider events applied in the provider's order, whatever order they arrive
// in; and causes past their expiry released by the sweep.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ProviderWebhookEvent", "SuppressionCause", "SuppressionEntry", "AppSetting",
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

/** Enqueues and sends one message, returning the provider's message id. */
const deliverOne = async (emailAddress: string) => {
  const providerMessageId = `resend-${randomUUID()}`;
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress,
    payload: { name: "Someone" },
  });
  mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ id: providerMessageId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  await drainStandardEmailDeliveries();
  mock.restoreAll();
  return providerMessageId;
};

const second = (n: number) => new Date(Date.UTC(2026, 8, 17, 0, 0, n)).toISOString();

type Event = {
  id: string;
  type: string;
  messageId: string;
  address: string;
  createdAt: string;
  bounce?: string;
};

const send = (event: Event) =>
  processResendWebhook({
    providerEventId: event.id,
    payload: {
      type: event.type,
      created_at: event.createdAt,
      data: {
        email_id: event.messageId,
        to: [event.address],
        ...(event.bounce ? { bounce: { type: event.bounce } } : {}),
      },
    },
    // Received well after every event happened, so none is disbelieved.
    receivedAt: new Date(Date.UTC(2026, 8, 17, 1, 0, 0)),
  });

const permutations = <T>(list: T[]): T[][] =>
  list.length <= 1
    ? [list]
    : list.flatMap((item, index) =>
        permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])
      );

test("a delivery's status ends the same whatever order its events arrive in", async () => {
  const finals = new Set<string>();
  for (const order of permutations(["sent", "delivered", "delayed"])) {
    await reset();
    const address = `${randomUUID()}@example.com`;
    const messageId = await deliverOne(address);
    const events: Record<string, Event> = {
      sent: { id: "evt-a", type: "email.sent", messageId, address, createdAt: second(1) },
      delivered: { id: "evt-b", type: "email.delivered", messageId, address, createdAt: second(2) },
      // The same instant as the delivery: the more blocking event is the later.
      delayed: { id: "evt-c", type: "email.delivery_delayed", messageId, address, createdAt: second(2) },
    };
    for (const name of order) await send(events[name]);
    const row = await prisma.emailDelivery.findFirstOrThrow();
    finals.add(
      [row.status, row.providerEventId, row.deliveredAt?.toISOString(), row.softBounceAt?.toISOString()].join("|")
    );
  }
  assert.deepEqual([...finals], [["bounced", "evt-c", second(2), second(2)].join("|")]);
});

test("soft bounces older than a delivery neither suppress nor survive it, in either order", async () => {
  const outcomes = new Set<string>();
  for (const deliveredFirst of [false, true]) {
    await reset();
    const address = `${randomUUID()}@example.com`;
    const bounces: Event[] = [];
    for (let i = 0; i < SOFT_BOUNCE_SUPPRESSION_THRESHOLD; i += 1) {
      const messageId = await deliverOne(address);
      bounces.push({
        id: `evt-bounce-${i}`,
        type: "email.bounced",
        bounce: "Transient",
        messageId,
        address,
        createdAt: second(1 + i),
      });
    }
    const deliveredMessage = await deliverOne(address);
    const delivered: Event = {
      id: "evt-delivered",
      type: "email.delivered",
      messageId: deliveredMessage,
      address,
      createdAt: second(30),
    };

    if (deliveredFirst) {
      await send(delivered);
      for (const bounce of bounces) await send(bounce);
    } else {
      for (const bounce of bounces) await send(bounce);
      assert.equal(
        (await suppressionCheck({ emailAddress: address, classification: "marketing" })).allowed,
        false,
        "the run suppressed before the delivery arrived"
      );
      await send(delivered);
    }

    const active = await prisma.suppressionCause.count({
      where: { emailAddress: address, releasedAt: null },
    });
    const entries = await prisma.suppressionEntry.count({ where: { emailAddress: address } });
    const allowed = (await suppressionCheck({ emailAddress: address, classification: "marketing" })).allowed;
    outcomes.add(`${active}|${entries}|${allowed}`);
  }
  assert.deepEqual([...outcomes], ["0|0|true"]);
});

test("a soft bounce at the same instant as a delivery stands", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageIds: string[] = [];
  for (let i = 0; i < SOFT_BOUNCE_SUPPRESSION_THRESHOLD; i += 1) {
    messageIds.push(await deliverOne(address));
  }
  const deliveredMessage = await deliverOne(address);
  await send({
    id: "evt-delivered",
    type: "email.delivered",
    messageId: deliveredMessage,
    address,
    createdAt: second(10),
  });
  for (const [i, messageId] of messageIds.entries()) {
    await send({
      id: `evt-bounce-${i}`,
      type: "email.bounced",
      bounce: "Transient",
      messageId,
      address,
      createdAt: second(10),
    });
  }
  const cause = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress: address, reason: "soft_bounce" },
  });
  assert.equal(cause.releasedAt, null);
  assert.equal(cause.occurredAt.toISOString(), second(10));
});

test("a hard bounce older than a delivery still suppresses, without rolling the status back", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  await send({ id: "evt-delivered", type: "email.delivered", messageId, address, createdAt: second(20) });
  await send({
    id: "evt-hard",
    type: "email.bounced",
    bounce: "Hard",
    messageId,
    address,
    createdAt: second(5),
  });
  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "delivered");
  const cause = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress: address, reason: "hard_bounce" },
  });
  assert.equal(cause.occurredAt.toISOString(), second(5));
  assert.equal(
    (await suppressionCheck({ emailAddress: address, classification: "transactional" })).allowed,
    false
  );
});

test("the sweep releases expired causes and the entries left with nothing behind them", async () => {
  const address = `${randomUUID()}@example.com`;
  const past = new Date(Date.now() - 60_000);
  await recordSuppression({
    emailAddress: address,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: past,
    occurredAt: new Date(Date.now() - 120_000),
    sourceEventKey: `test:${randomUUID()}`,
  });
  const hard = `${randomUUID()}@example.com`;
  await recordSuppression({
    emailAddress: hard,
    reason: "hard_bounce",
    source: "provider_webhook",
    sourceEventKey: `test:${randomUUID()}`,
  });

  const result = await releaseExpiredSuppressionCauses();
  assert.equal(result.released, 1);
  assert.equal(result.entriesRemoved, 1);
  const released = await prisma.suppressionCause.findFirstOrThrow({ where: { emailAddress: address } });
  assert.equal(released.releaseKind, "expired");
  assert.deepEqual(released.releaseEvidence, { kind: "expiry" });
  assert.equal(await prisma.suppressionEntry.count({ where: { emailAddress: address } }), 0);
  assert.equal(await prisma.suppressionCause.count({ where: { emailAddress: hard, releasedAt: null } }), 1);

  const again = await releaseExpiredSuppressionCauses();
  assert.equal(again.released, 0);
});
