import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { OPS_MODEL_LIFECYCLE_DAILY_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { prisma } from "@/lib/prisma";
import { sendProviderModelCatalogReport } from "@/lib/providerModelCatalogReport";
import type { ProviderModelCatalogResult } from "@/lib/providerModelCatalogMonitor";

// The daily model lifecycle report, on the standard email lane (EM-14).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §10.1 and
// docs/policy/email-notifications.md §9.4a.
//
// What this proves that a unit test cannot: the report leaves a durable row.
// Before this it called sendTransactionalEmail() directly, so an operator
// address in hard bounce lost the report silently -- and the report is the only
// signal that anything in the model catalogue needs a person.
//
// The Slack half stays direct and is unconfigured here, so nothing is sent.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "AdminNotificationLog", "ProviderModelCatalogRun"
    RESTART IDENTITY CASCADE
  `);

const originalEnv = {
  recipients: process.env.PROVIDER_MODEL_CATALOG_ALERT_EMAIL,
  ops: process.env.OPS_ALERT_EMAIL,
  admin: process.env.ADMIN_ALERT_EMAIL,
  slack: process.env.PROVIDER_MODEL_CATALOG_SLACK_WEBHOOK_URL,
  opsSlack: process.env.OPS_ALERT_SLACK_WEBHOOK_URL,
  webhook: process.env.SLACK_WEBHOOK_URL,
};

beforeEach(async () => {
  await reset();
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  delete process.env.PROVIDER_MODEL_CATALOG_SLACK_WEBHOOK_URL;
  delete process.env.OPS_ALERT_SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
});

after(async () => {
  await reset();
  for (const [key, value] of [
    ["PROVIDER_MODEL_CATALOG_ALERT_EMAIL", originalEnv.recipients],
    ["OPS_ALERT_EMAIL", originalEnv.ops],
    ["ADMIN_ALERT_EMAIL", originalEnv.admin],
    ["PROVIDER_MODEL_CATALOG_SLACK_WEBHOOK_URL", originalEnv.slack],
    ["OPS_ALERT_SLACK_WEBHOOK_URL", originalEnv.opsSlack],
    ["SLACK_WEBHOOK_URL", originalEnv.webhook],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await prisma.$disconnect();
});

const scan = (): ProviderModelCatalogResult[] => [
  {
    provider: "openai",
    status: "checked",
    discovered: 48,
    mapped: [],
    candidates: ["gpt-5-7-preview"],
    newCandidates: [],
    missing: [],
    lifecycleWarnings: [],
  },
  {
    provider: "groq",
    status: "failed",
    discovered: 0,
    mapped: [],
    candidates: [],
    newCandidates: [],
    missing: [],
    lifecycleWarnings: [],
    errorCode: "HTTP_401",
  },
];

const generatedAt = new Date("2026-08-22T00:00:00.000Z");

test("the report is enqueued, not sent, and leaves a delivery row per operator", async () => {
  process.env.PROVIDER_MODEL_CATALOG_ALERT_EMAIL = "ops@tomverse.app, second@tomverse.app";

  const result = await sendProviderModelCatalogReport({
    results: scan(),
    openWorkItems: 0,
    workItems: [],
    generatedAt,
  });

  assert.deepEqual(
    result.email.map((entry) => entry.status),
    ["queued", "queued"]
  );

  const deliveries = await prisma.emailDelivery.findMany({
    orderBy: { emailAddress: "asc" },
    select: {
      emailAddress: true,
      recipientKey: true,
      lane: true,
      status: true,
      userId: true,
      renderDataSnapshot: true,
    },
  });
  assert.equal(deliveries.length, 2);
  for (const delivery of deliveries) {
    assert.equal(delivery.lane, "standard");
    assert.equal(delivery.status, "pending");
    // No account behind an operations address, so the recipient identity is the
    // address itself (§10.1).
    assert.equal(delivery.userId, null);
    assert.equal(delivery.recipientKey, `addr:${delivery.emailAddress}`);
    // The payload is stored sealed. Reading it as text must not find the report.
    assert.doesNotMatch(String(delivery.renderDataSnapshot), /gpt-5-7-preview/);
  }
});

test("the template registers as operator mail: no purpose, no unsubscribe", async () => {
  process.env.PROVIDER_MODEL_CATALOG_ALERT_EMAIL = "ops@tomverse.app";
  await sendProviderModelCatalogReport({
    results: scan(),
    workItems: [],
    generatedAt,
  });

  const template = await prisma.emailTemplate.findUnique({
    where: { key: OPS_MODEL_LIFECYCLE_DAILY_TEMPLATE },
    select: { classification: true, purpose: true, requiresUnsubscribe: true },
  });
  assert.ok(template);
  assert.equal(template.classification, "transactional");
  assert.equal(template.purpose, null);
  assert.equal(template.requiresUnsubscribe, false);
});

test("a second run reuses the published version rather than minting one", async () => {
  process.env.PROVIDER_MODEL_CATALOG_ALERT_EMAIL = "ops@tomverse.app";
  await sendProviderModelCatalogReport({ results: scan(), workItems: [], generatedAt });
  await sendProviderModelCatalogReport({
    results: scan(),
    workItems: [],
    generatedAt: new Date("2026-08-23T00:00:00.000Z"),
  });

  const template = await prisma.emailTemplate.findUnique({
    where: { key: OPS_MODEL_LIFECYCLE_DAILY_TEMPLATE },
    select: { id: true },
  });
  const versions = await prisma.templateVersion.count({
    where: { templateId: template!.id },
  });
  // The version is registered from the placeholder payload, so a report whose
  // contents differ every morning does not fill the table with one row a day.
  assert.equal(versions, 1);

  const deliveries = await prisma.emailDelivery.count();
  assert.equal(deliveries, 2);
});

test("an unconfigured recipient list is recorded, not thrown", async () => {
  delete process.env.PROVIDER_MODEL_CATALOG_ALERT_EMAIL;
  delete process.env.OPS_ALERT_EMAIL;
  delete process.env.ADMIN_ALERT_EMAIL;

  const result = await sendProviderModelCatalogReport({
    results: scan(),
    workItems: [],
    generatedAt,
  });
  assert.deepEqual(
    result.email.map((entry) => entry.status),
    ["skipped"]
  );
  assert.equal(await prisma.emailDelivery.count(), 0);
  // Filtered to the email channel: the Slack half writes its own row, and it
  // is unconfigured here too.
  const logged = await prisma.adminNotificationLog.findMany({
    where: { channel: "email" },
    select: { status: true, targetType: true },
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].status, "skipped");
  assert.equal(logged[0].targetType, "ProviderModelCatalog");
});

test("a lane that refuses to enqueue costs the mail, never the scan", async () => {
  process.env.PROVIDER_MODEL_CATALOG_ALERT_EMAIL = "ops@tomverse.app";
  // The lane will not store the snapshot unencrypted, so with no keyring every
  // enqueue throws. The scan's own result is worth more than the mail about it.
  delete process.env.EMAIL_SNAPSHOT_KEYS;

  const result = await sendProviderModelCatalogReport({
    results: scan(),
    workItems: [],
    generatedAt,
  });
  assert.deepEqual(
    result.email.map((entry) => entry.status),
    ["failed"]
  );
  const logged = await prisma.adminNotificationLog.findMany({
    where: { channel: "email" },
    select: { status: true, error: true },
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].status, "failed");
  assert.match(String(logged[0].error), /EMAIL_SNAPSHOT_KEYS/);
});
