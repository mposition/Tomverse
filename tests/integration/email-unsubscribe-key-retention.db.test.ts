import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { ACCOUNT_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  ensureBootstrapPolicyVersion,
  ensureTemplateVersion,
} from "@/lib/emailTemplateRegistry";
import {
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
      "EmailUnsubscribeKeyCanary", "EmailDelivery", "EmailEvent",
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
      recipientKey: `address:${randomUUID()}`,
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
  await sentDelivery({ keyVersion: "v1", sentAt: new Date(now.getTime() - 45 * DAY) });
  await sentDelivery({ keyVersion: "v1", sentAt: null });

  const verdict = await getUnsubscribeKeyRetentionReadiness(now, env("v2:secret-two", "v2"));
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.retirable, ["v1"]);
});

test("the newest send per version is the one that counts", async () => {
  const now = new Date();
  await ensureUnsubscribeKeyCanary(readUnsubscribeKeyring(env("v1:secret-one", "v1"))!);
  await sentDelivery({ keyVersion: "v1", sentAt: new Date(now.getTime() - 45 * DAY) });
  await sentDelivery({ keyVersion: "v1", sentAt: new Date(now.getTime() - 1 * DAY) });

  const verdict = await getUnsubscribeKeyRetentionReadiness(now, env("v2:secret-two", "v2"));
  assert.equal(verdict.ready, false);
});
