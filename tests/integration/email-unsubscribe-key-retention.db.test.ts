import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { ACCOUNT_WELCOME_TEMPLATE, MODEL_LAUNCH_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  ensureBootstrapPolicyVersion,
  ensureTemplateVersion,
} from "@/lib/emailTemplateRegistry";
import {
  adoptUnsubscribeKeyringForUnattributedMail,
  ensureUnsubscribeKeyCanary,
  getUnsubscribeKeyRetentionReadiness,
} from "@/lib/emailUnsubscribeKeyRetention";
import { prisma } from "@/lib/prisma";
import { readUnsubscribeKeyring } from "@/lib/unsubscribeToken";

// The retention check against the rows it reads.
//
// Contract: docs/policy/email-notifications.md §11.4.
//
// The verdict itself is unit-tested. What needs a database is the part that
// feeds it: the canary is stored once per version however many sends race to
// store it, and "last sent" is the newest `sentAt` per version -- not the
// newest row, and not a row that never went out.

const DAY = 24 * 60 * 60 * 1_000;

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailUnsubscribeKeyCanary", "EmailUnsubscribeKeyAdoption", "EmailDelivery", "EmailEvent",
      "TemplateVersion", "EmailTemplate", "EmailPolicyVersion"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const env = (keys: string, version: string) =>
  ({
    EMAIL_UNSUBSCRIBE_KEYS: keys,
    EMAIL_UNSUBSCRIBE_KEY_VERSION: version,
  }) as unknown as NodeJS.ProcessEnv;

const sentDelivery = async (input: {
  keyVersion: string | null;
  sentAt: Date | null;
}) => {
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const { templateId, templateVersionId } = await ensureTemplateVersion({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    language: "en",
  });
  const event = await prisma.emailEvent.create({
    data: { kind: "account.welcome", templateId, payload: {}, audienceKind: "single_user" },
  });
  return prisma.emailDelivery.create({
    data: {
      eventId: event.id,
      recipientKey: `addr:${randomUUID()}@example.com`,
      emailAddress: `${randomUUID()}@example.com`,
      language: "en",
      lane: "standard",
      policyVersionId,
      templateVersionId,
      idempotencyKey: randomUUID(),
      jurisdictionCountry: "US",
      jurisdictionProfileKey: "us",
      status: input.sentAt ? "sent" : "pending",
      sentAt: input.sentAt,
      unsubscribeKeyVersion: input.keyVersion,
    },
  });
};

test("racing sends store one canary per version", async () => {
  const keyring = readUnsubscribeKeyring(env("v1:secret-one", "v1"))!;
  await Promise.all(Array.from({ length: 5 }, () => ensureUnsubscribeKeyCanary(keyring)));
  assert.equal(await prisma.emailUnsubscribeKeyCanary.count(), 1);
});

test("dropping a version with a recent send is not ready", async () => {
  const now = new Date();
  await ensureUnsubscribeKeyCanary(readUnsubscribeKeyring(env("v1:secret-one", "v1"))!);
  await sentDelivery({ keyVersion: "v1", sentAt: new Date(now.getTime() - 2 * DAY) });

  const verdict = await getUnsubscribeKeyRetentionReadiness(now, env("v2:secret-two", "v2"));
  assert.equal(verdict.ready, false);
  assert.equal(verdict.errors[0].keyVersion, "v1");
});

test("an old send does not hold a version, however many unsent rows name it", async () => {
  const now = new Date();
  await ensureUnsubscribeKeyCanary(readUnsubscribeKeyring(env("v1:secret-one", "v1"))!);
  await sentDelivery({ keyVersion: "v1", sentAt: new Date(now.getTime() - 400 * DAY) });
  await sentDelivery({ keyVersion: "v1", sentAt: null });

  const verdict = await getUnsubscribeKeyRetentionReadiness(now, env("v2:secret-two", "v2"));
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.retirable, ["v1"]);
});

test("the newest send per version is the one that counts", async () => {
  const now = new Date();
  await ensureUnsubscribeKeyCanary(readUnsubscribeKeyring(env("v1:secret-one", "v1"))!);
  await sentDelivery({ keyVersion: "v1", sentAt: new Date(now.getTime() - 400 * DAY) });
  await sentDelivery({ keyVersion: "v1", sentAt: new Date(now.getTime() - 1 * DAY) });

  const verdict = await getUnsubscribeKeyRetentionReadiness(now, env("v2:secret-two", "v2"));
  assert.equal(verdict.ready, false);
});

test("a recorded recent send whose canary is missing is not ready", async () => {
  const now = new Date();
  await sentDelivery({ keyVersion: "v1", sentAt: new Date(now.getTime() - 2 * DAY) });
  const verdict = await getUnsubscribeKeyRetentionReadiness(now, env("v1:secret-one", "v1"));
  assert.equal(verdict.ready, false);
  assert.equal(verdict.errors[0].code, "EMAIL_UNSUBSCRIBE_KEY_CANARY_MISSING");
});

test("mail from before versions were recorded adopts every listed version", async () => {
  // Sent with an unsubscribe link and no recorded version: a marketing template
  // version, since only those require the link.
  const now = new Date();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const { templateId, templateVersionId } = await ensureTemplateVersion({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    language: "en",
  });
  const event = await prisma.emailEvent.create({
    data: { kind: "model.launch", templateId, payload: {}, audienceKind: "single_user" },
  });
  await prisma.emailDelivery.create({
    data: {
      eventId: event.id,
      recipientKey: `addr:${randomUUID()}@example.com`,
      emailAddress: `${randomUUID()}@example.com`,
      language: "en",
      lane: "standard",
      policyVersionId,
      templateVersionId,
      idempotencyKey: randomUUID(),
      jurisdictionCountry: "US",
      jurisdictionProfileKey: "us",
      status: "sent",
      sentAt: new Date(now.getTime() - 3 * DAY),
    },
  });

  const listed = env("v1:secret-one,v2:secret-two", "v2");

  // Before adoption the check reads only: it warns, and writes nothing.
  const before = await getUnsubscribeKeyRetentionReadiness(now, listed);
  assert.equal(before.warnings[0].code, "EMAIL_UNSUBSCRIBE_UNATTRIBUTED_MAIL_UNADOPTED");
  assert.equal(await prisma.emailUnsubscribeKeyCanary.count(), 0);

  // The drain adopts, once; a second adoption is a no-op.
  assert.equal(await adoptUnsubscribeKeyringForUnattributedMail(now, listed), "adopted");
  assert.equal(
    await adoptUnsubscribeKeyringForUnattributedMail(now, env("v3:secret-three", "v3")),
    "already_adopted"
  );
  assert.equal(await prisma.emailUnsubscribeKeyAdoption.count(), 1);
  const first = await getUnsubscribeKeyRetentionReadiness(now, listed);
  assert.equal(first.ready, true);
  assert.deepEqual(
    (await prisma.emailUnsubscribeKeyCanary.findMany({ orderBy: { keyVersion: "asc" } })).map(
      (row) => row.keyVersion
    ),
    ["v1", "v2"]
  );

  // Now dropping either version is refused until that mail ages out.
  const dropped = await getUnsubscribeKeyRetentionReadiness(now, env("v2:secret-two", "v2"));
  assert.equal(dropped.ready, false);
  assert.equal(dropped.errors[0].keyVersion, "v1");
});
