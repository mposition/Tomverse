import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { MODEL_LAUNCH_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import { expandEmailEvent } from "@/lib/emailAudienceExpansion";
import { prisma } from "@/lib/prisma";
import { EMAIL_MARKETING_FLAG_KEY } from "@/lib/emailFeatureFlags";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// One event, many deliveries, resumably (EM-01).
//
// Contract: docs/policy/email-notifications.md §10.2,
// .github/audits/model-lifecycle-email-2026-08-22.md EM-01, §12.3.
//
// `audienceKind`, `audienceSpec`, `expansionCursor` and the pending/expanding/
// failed statuses have been in the schema since it was written, and nothing
// ever wrote any of them -- every event was single_user, already expanded.
// That is why nobody can be told about a model retirement today.
//
// The acceptance criterion is the second one below: expanding the same event
// twice must not change how many deliveries exist. Everything else here is the
// behaviour that makes running it twice a thing somebody would actually do.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  // These suites drive `model_launch`, which is classified marketing, so the
  // fan-out needs that flag on too (EM-05). Off is the default everywhere
  // else, which is what makes turning it on here a statement.
  await setEmailFeatureFlag(EMAIL_MARKETING_FLAG_KEY, true);
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const PAYLOAD = {
  modelName: "Claude Opus 5.1",
  plans: "Pro and Max",
  highlights: ["200K context window"],
  creditLine: "Premium tier - 12 credits per message",
  ctaUrl: "https://tomverse.app/chat",
};

/** `count` accounts, ordered ids so a cursor test can be deterministic. */
const accounts = async (count: number, options?: { withEmail?: boolean }) => {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const user = await prisma.user.create({
      data: {
        id: `user-${String(index).padStart(4, "0")}-${randomUUID().slice(0, 8)}`,
        ...(options?.withEmail === false
          ? {}
          : { email: `member-${index}-${randomUUID()}@example.test` }),
        name: `Member ${index}`,
      },
      select: { id: true },
    });
    ids.push(user.id);
  }
  return ids.sort();
};

/** A segment event, in the state a campaign would hand over. */
const segmentEvent = async (input?: {
  userIds?: string[];
  audienceKind?: string;
  spec?: Record<string, unknown>;
}) => {
  const template = await ensureTemplateVersion({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    language: "en",
  });
  const event = await prisma.emailEvent.create({
    data: {
      kind: `email.${MODEL_LAUNCH_TEMPLATE}`,
      templateId: template.templateId,
      payload: PAYLOAD,
      audienceKind: input?.audienceKind ?? "user_segment",
      audienceSpec: {
        ...(input?.userIds ? { userIds: input.userIds } : {}),
        ...(input?.spec ?? {}),
      },
      status: "pending",
    },
    select: { id: true },
  });
  return event.id;
};

const deliveryCount = (eventId: string) =>
  prisma.emailDelivery.count({ where: { eventId } });

test("one event fans out to every account in the segment", async () => {
  const ids = await accounts(5);
  const eventId = await segmentEvent({ userIds: ids });

  const result = await expandEmailEvent({ eventId, batchSize: 2 });

  assert.ok(!("refused" in result), JSON.stringify(result));
  assert.equal(result.expanded, 5);
  assert.equal(result.status, "expanded");
  assert.equal(await deliveryCount(eventId), 5);

  const event = await prisma.emailEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: { status: true, expansionCursor: true },
  });
  assert.equal(event.status, "expanded");
  assert.equal(event.expansionCursor, ids[ids.length - 1]);
});

test("expanding the same event twice does not change how many deliveries exist", async () => {
  // The acceptance criterion. `@@unique([eventId, recipientKey])` is what
  // enforces it, which is why the second pass is allowed to re-cover ground
  // rather than having to know what the first one did.
  const ids = await accounts(4);
  const eventId = await segmentEvent({ userIds: ids });

  await expandEmailEvent({ eventId, batchSize: 2 });
  const afterFirst = await deliveryCount(eventId);

  // Reopened the way a resumed pass finds it, then run again.
  await prisma.emailEvent.update({
    where: { id: eventId },
    data: { status: "expanding", expansionCursor: null },
  });
  const second = await expandEmailEvent({ eventId, batchSize: 2 });

  assert.ok(!("refused" in second));
  assert.equal(await deliveryCount(eventId), afterFirst);
  assert.equal(second.expanded, 0, "nothing new was written");
  assert.equal(second.alreadyPresent, 4, "and it says the rows were there");
});

test("a pass that stopped halfway resumes from its cursor", async () => {
  const ids = await accounts(6);
  const eventId = await segmentEvent({ userIds: ids });

  // A budget of zero lets exactly one batch through before the deadline check.
  const first = await expandEmailEvent({ eventId, batchSize: 2, timeBudgetMs: 0 });
  assert.ok(!("refused" in first));
  assert.equal(first.expanded, 2);
  assert.equal(first.status, "expanding", "unfinished, and it says so");

  const midway = await prisma.emailEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: { status: true, expansionCursor: true },
  });
  assert.equal(midway.status, "expanding");
  assert.equal(midway.expansionCursor, ids[1]);

  const second = await expandEmailEvent({ eventId, batchSize: 10 });
  assert.ok(!("refused" in second));
  assert.equal(second.expanded, 4, "the four it had not reached");
  assert.equal(second.alreadyPresent, 0, "and it did not re-read the first two");
  assert.equal(await deliveryCount(eventId), 6);
});

test("a cap stops the fan-out and says that is why", async () => {
  const ids = await accounts(5);
  const eventId = await segmentEvent({
    userIds: ids,
    spec: { recipientCap: 3 },
  });

  const result = await expandEmailEvent({ eventId, batchSize: 2 });

  assert.ok(!("refused" in result));
  assert.equal(result.capReached, true);
  assert.equal(await deliveryCount(eventId), 3);
  // Not `expanded`: the audience was not exhausted, and calling it finished
  // would lose the fact that two people were never written to.
  const event = await prisma.emailEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: { status: true },
  });
  assert.equal(event.status, "expanding");
});

test("a resumed pass does not get a second cap", async () => {
  const ids = await accounts(6);
  const eventId = await segmentEvent({
    userIds: ids,
    spec: { recipientCap: 3 },
  });

  await expandEmailEvent({ eventId, batchSize: 2 });
  const second = await expandEmailEvent({ eventId, batchSize: 2 });

  assert.ok(!("refused" in second));
  assert.equal(second.expanded, 0);
  assert.equal(await deliveryCount(eventId), 3, "still three, not six");
});

test("a dry run writes the same rows and marks every one", async () => {
  // A dry run that produced no rows would not answer the question a dry run is
  // asked. `dry_run` has been in the skipReason CHECK since the beginning and
  // nothing has ever written it.
  const ids = await accounts(3);
  const eventId = await segmentEvent({ userIds: ids, spec: { dryRun: true } });

  await expandEmailEvent({ eventId });

  const rows = await prisma.emailDelivery.findMany({
    where: { eventId },
    select: { status: true, skipReason: true, nextAttemptAt: true },
  });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status, "skipped");
    assert.equal(row.skipReason, "dry_run");
    assert.equal(row.nextAttemptAt, null, "and nothing will claim it");
  }
});

test("an account with no address is counted, not invented", async () => {
  const withAddress = await accounts(2);
  const without = await accounts(1, { withEmail: false });
  const eventId = await segmentEvent({
    userIds: [...withAddress, ...without].sort(),
  });

  const result = await expandEmailEvent({ eventId });

  assert.ok(!("refused" in result));
  assert.equal(result.expanded, 2);
  assert.equal(result.skipped, 1);
  assert.equal(await deliveryCount(eventId), 2);
});

test("a single-user event is refused", async () => {
  const ids = await accounts(1);
  const eventId = await segmentEvent({
    userIds: ids,
    audienceKind: "single_user",
  });

  const result = await expandEmailEvent({ eventId });

  assert.deepEqual(result, { refused: "not_a_segment" });
  assert.equal(await deliveryCount(eventId), 0);
});

test("a finished event is refused, and a failed one waits for a person", async () => {
  const ids = await accounts(2);
  for (const [status, refused] of [
    ["expanded", "already_expanded"],
    ["failed", "previously_failed"],
  ] as const) {
    const eventId = await segmentEvent({ userIds: ids });
    await prisma.emailEvent.update({ where: { id: eventId }, data: { status } });

    assert.deepEqual(await expandEmailEvent({ eventId }), { refused });
    assert.equal(await deliveryCount(eventId), 0, status);
  }
});

test("each row is pinned to its own language and policy version", async () => {
  // The same pinning the enqueue path does, for the same reason: activating a
  // policy version mid-fan-out must not change what an already-written row
  // renders under.
  const ids = await accounts(2);
  await prisma.userSettings.create({
    data: { userId: ids[0], language: "ko" },
  });
  const eventId = await segmentEvent({ userIds: ids });

  await expandEmailEvent({ eventId });

  const rows = await prisma.emailDelivery.findMany({
    where: { eventId },
    orderBy: { userId: "asc" },
    select: { userId: true, language: true, policyVersionId: true, templateVersionId: true },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.userId === ids[0])?.language, "ko");
  assert.equal(rows.find((row) => row.userId === ids[1])?.language, "en");
  for (const row of rows) {
    assert.ok(row.policyVersionId, "a row with no policy version renders unlabelled");
    assert.ok(row.templateVersionId);
  }
  // Different languages are different template versions, or one of them is
  // rendering in the wrong one.
  assert.notEqual(rows[0].templateVersionId, rows[1].templateVersionId);
});

test("every row carries the snapshot the drain will render from", async () => {
  const ids = await accounts(2);
  const eventId = await segmentEvent({ userIds: ids });

  await expandEmailEvent({ eventId });

  const rows = await prisma.emailDelivery.findMany({
    where: { eventId },
    select: { renderDataSnapshot: true, idempotencyKey: true },
  });
  for (const row of rows) {
    assert.notEqual(row.renderDataSnapshot, null);
    assert.ok(row.idempotencyKey.startsWith(`${eventId}:user:`));
  }
  // Distinct keys, or the provider would suppress every message after the
  // first as a duplicate of it.
  assert.equal(new Set(rows.map((row) => row.idempotencyKey)).size, 2);
});

test("an all_users event reaches accounts the spec never named", async () => {
  const ids = await accounts(3);
  const eventId = await segmentEvent({ audienceKind: "all_users" });

  const result = await expandEmailEvent({ eventId });

  assert.ok(!("refused" in result));
  assert.equal(result.expanded, ids.length);
});
