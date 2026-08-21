import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";

// The invariants of the email notification data model that only the database
// can hold.
//
// Contract: .github/audits/email-notification-architecture-2026-08-21.md
//
// None of these are reachable from the Prisma schema: it has no CHECK and no
// partial index, so `prisma migrate diff` neither creates them nor notices if
// they disappear. Reading the migration cannot establish them either -- a
// constraint that is syntactically present but written wrong (an OR where an
// AND belonged, a predicate that is true for every row) passes review and
// enforces nothing. So each one is exercised by writing the state it forbids
// and requiring the write to fail.
//
// Two of these correspond directly to defects found during the design review,
// and are the reason the columns look the way they do:
//
//  - EmailDelivery."recipientKey" is non-null because @@unique([eventId,
//    userId]) did not constrain recipients without an account. PostgreSQL
//    treats NULLs as distinct, so re-running fan-out piled up duplicates for
//    exactly the guests it was supposed to protect.
//  - SuppressionEntry."purposeKey" carries '*' rather than NULL for the same
//    reason, which is why a global suppression can be written once and only
//    once per address.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "ConsentRecord", "EmailPreference", "SuppressionEntry",
      "ProviderWebhookEvent", "JurisdictionCountryMap", "JurisdictionProfile",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

/** Asserts the write fails, and that it fails for the stated reason. */
const rejects = async (name: string, run: () => Promise<unknown>) => {
  let message: string | null = null;
  try {
    await run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.notEqual(message, null, `expected ${name} to reject the write`);
  assert.ok(
    message!.includes(name),
    `expected ${name} to be the reason; got: ${message!.slice(0, 300)}`
  );
};

let policyVersionId = "";
let templateId = "";
let templateVersionId = "";
let eventId = "";

beforeEach(async () => {
  await reset();

  const policy = await prisma.emailPolicyVersion.create({
    data: {
      version: `test-${randomUUID()}`,
      status: "active",
      changeSummary: "fixture",
    },
  });
  policyVersionId = policy.id;

  const template = await prisma.emailTemplate.create({
    data: {
      key: `auth_login_code_${randomUUID()}`,
      classification: "transactional",
      purpose: null,
      requiresUnsubscribe: false,
    },
  });
  templateId = template.id;

  const version = await prisma.templateVersion.create({
    data: {
      templateId,
      version: 1,
      language: "en",
      subject: "s",
      bodyHtml: "<p>s</p>",
      bodyText: "s",
      contentHash: "hash",
      status: "published",
      publishedAt: new Date(),
    },
  });
  templateVersionId = version.id;

  const event = await prisma.emailEvent.create({
    data: {
      kind: "auth.login_code",
      templateId,
      payload: {},
      audienceKind: "single_user",
    },
  });
  eventId = event.id;
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const delivery = (overrides: Record<string, unknown>) => ({
  eventId,
  recipientKey: `addr:${randomUUID()}@example.com`,
  lane: "standard",
  emailAddress: "someone@example.com",
  language: "en",
  jurisdictionCountry: "KR",
  jurisdictionProfileKey: "KR",
  policyVersionId,
  templateVersionId,
  idempotencyKey: randomUUID(),
  ...overrides,
});

test("only one policy version can be active at a time", async () => {
  await rejects("EmailPolicyVersion_active_key", () =>
    prisma.emailPolicyVersion.create({
      data: {
        version: `second-${randomUUID()}`,
        status: "active",
        changeSummary: "a racing activation",
      },
    })
  );
});

test("classification decides the unsubscribe link in both directions", async () => {
  await rejects("EmailTemplate_unsubscribe_check", () =>
    prisma.emailTemplate.create({
      data: {
        key: `promo_${randomUUID()}`,
        classification: "marketing",
        purpose: "promotions",
        requiresUnsubscribe: false,
      },
    })
  );

  // The reverse matters as much: an unsubscribe link on a login code is a
  // button that locks people out of their own account.
  await rejects("EmailTemplate_unsubscribe_check", () =>
    prisma.emailTemplate.create({
      data: {
        key: `code_${randomUUID()}`,
        classification: "transactional",
        purpose: null,
        requiresUnsubscribe: true,
      },
    })
  );
});

test("gateable mail names its preference and ungateable mail does not", async () => {
  await rejects("EmailTemplate_purpose_check", () =>
    prisma.emailTemplate.create({
      data: {
        key: `promo_${randomUUID()}`,
        classification: "marketing",
        purpose: null,
        requiresUnsubscribe: true,
      },
    })
  );

  await rejects("EmailTemplate_purpose_check", () =>
    prisma.emailTemplate.create({
      data: {
        key: `receipt_${randomUUID()}`,
        classification: "transactional",
        purpose: "billing",
        requiresUnsubscribe: false,
      },
    })
  );
});

test("security and billing preferences cannot be disabled", async () => {
  const user = await prisma.user.create({ data: {} });

  for (const purpose of ["security", "billing"]) {
    await rejects("EmailPreference_locked_check", () =>
      prisma.emailPreference.create({
        data: { userId: user.id, purpose, enabled: false, source: "admin" },
      })
    );
  }

  // A preference that is merely unpopular stays switchable.
  const promotions = await prisma.emailPreference.create({
    data: {
      userId: user.id,
      purpose: "promotions",
      enabled: false,
      source: "unsubscribe_link",
    },
  });
  assert.equal(promotions.enabled, false);
});

test("a global suppression can be written once per address", async () => {
  const emailAddress = `${randomUUID()}@example.com`;

  await prisma.suppressionEntry.create({
    data: {
      emailAddress,
      scope: "global",
      purposeKey: "*",
      reason: "complaint",
      source: "provider_webhook",
    },
  });

  // With a nullable purpose column this second write succeeded, and the
  // suppression list started disagreeing with itself.
  await rejects("SuppressionEntry_emailAddress_scope_purposeKey_key", () =>
    prisma.suppressionEntry.create({
      data: {
        emailAddress,
        scope: "global",
        purposeKey: "*",
        reason: "hard_bounce",
        source: "admin",
      },
    })
  );
});

test("scope and purposeKey have to agree", async () => {
  await rejects("SuppressionEntry_purpose_key_check", () =>
    prisma.suppressionEntry.create({
      data: {
        emailAddress: `${randomUUID()}@example.com`,
        scope: "global",
        purposeKey: "promotions",
        reason: "complaint",
        source: "provider_webhook",
      },
    })
  );
});

test("only a soft bounce may expire", async () => {
  await rejects("SuppressionEntry_expiry_check", () =>
    prisma.suppressionEntry.create({
      data: {
        emailAddress: `${randomUUID()}@example.com`,
        scope: "global",
        purposeKey: "*",
        reason: "complaint",
        source: "provider_webhook",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
  );

  const soft = await prisma.suppressionEntry.create({
    data: {
      emailAddress: `${randomUUID()}@example.com`,
      scope: "global",
      purposeKey: "*",
      reason: "soft_bounce",
      source: "provider_webhook",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  assert.ok(soft.expiresAt);
});

test("fan-out cannot duplicate a recipient without an account", async () => {
  const recipientKey = `addr:${randomUUID()}@example.com`;

  await prisma.emailDelivery.create({
    data: delivery({ recipientKey, userId: null }),
  });

  // The defect this replaced: userId is NULL for both rows, and PostgreSQL
  // considers those distinct, so @@unique([eventId, userId]) admitted the
  // second one.
  await rejects("EmailDelivery_eventId_recipientKey_key", () =>
    prisma.emailDelivery.create({
      data: delivery({ recipientKey, userId: null }),
    })
  );
});

test("recipientKey has to be one of the two forms", async () => {
  await rejects("EmailDelivery_recipient_key_check", () =>
    prisma.emailDelivery.create({
      data: delivery({ recipientKey: "some-user-id" }),
    })
  );
});

test("the credential lane stores no credential", async () => {
  const row = await prisma.emailDelivery.create({
    data: delivery({ lane: "credential_sync" }),
  });

  await rejects("EmailDelivery_credential_no_snapshot_check", () =>
    prisma.emailDelivery.update({
      where: { id: row.id },
      data: { renderDataSnapshot: { code: "123456" } },
    })
  );

  // The same column is how other mail stays reproducible, so it is the lane
  // that is constrained, not the column.
  const standard = await prisma.emailDelivery.create({
    data: delivery({ lane: "standard" }),
  });
  const updated = await prisma.emailDelivery.update({
    where: { id: standard.id },
    data: { renderDataSnapshot: { planName: "Pro" } },
  });
  assert.deepEqual(updated.renderDataSnapshot, { planName: "Pro" });
});

test("the credential lane cannot report exhausted retries it never had", async () => {
  await rejects("EmailDelivery_credential_not_abandoned_check", () =>
    prisma.emailDelivery.create({
      data: delivery({ lane: "credential_sync", status: "abandoned" }),
    })
  );

  // `failed` is the terminus that lane does have.
  const failed = await prisma.emailDelivery.create({
    data: delivery({ lane: "credential_sync", status: "failed" }),
  });
  assert.equal(failed.status, "failed");
});

test("a rendered hash always names the key that produced it", async () => {
  const row = await prisma.emailDelivery.create({ data: delivery({}) });

  await rejects("EmailDelivery_rendered_hash_key_check", () =>
    prisma.emailDelivery.update({
      where: { id: row.id },
      data: { renderedHash: "abc" },
    })
  );

  await rejects("EmailDelivery_rendered_hash_key_check", () =>
    prisma.emailDelivery.update({
      where: { id: row.id },
      data: { renderedHashKeyVersion: "v1" },
    })
  );

  const both = await prisma.emailDelivery.update({
    where: { id: row.id },
    data: { renderedHash: "abc", renderedHashKeyVersion: "v1" },
  });
  assert.equal(both.renderedHashKeyVersion, "v1");
});

test("a provider redelivering a webhook cannot record it twice", async () => {
  const providerEventId = `svix-${randomUUID()}`;

  await prisma.providerWebhookEvent.create({
    data: {
      provider: "resend",
      providerEventId,
      eventType: "email.bounced",
      payload: {},
    },
  });

  await rejects("ProviderWebhookEvent_provider_providerEventId_key", () =>
    prisma.providerWebhookEvent.create({
      data: {
        provider: "resend",
        providerEventId,
        eventType: "email.bounced",
        payload: {},
      },
    })
  );
});
