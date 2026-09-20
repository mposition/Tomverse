import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";

// The invariants of the email notification data model that only the database
// can hold.
//
// Contract: docs/policy/email-notifications.md
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
      classification: "transactional",
      purpose: null,
      requiresUnsubscribe: false,
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
      providerAccount: "transactional",
      providerEventId,
      eventType: "email.bounced",
      payload: {},
    },
  });

  // One unique now: the older (provider, providerEventId) one was scaffolding
  // for the build that wrote no account, and the contraction dropped it. While
  // both existed the database could name either, and this test accepted either;
  // with one there is one name and it is asserted.
  const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'ProviderWebhookEvent_account_event_key'
  `;
  assert.ok(index, "the per-account unique exists");
  // PostgreSQL quotes an identifier only when it needs to: `provider` is lower
  // case and comes back bare, the camel-case columns come back quoted.
  assert.match(
    index.indexdef,
    /UNIQUE INDEX .*\(\s*"?provider"?,\s*"providerAccount",\s*"providerEventId"\s*\)/
  );

  await rejects("ProviderWebhookEvent_account_event_key", () =>
    prisma.providerWebhookEvent.create({
      data: {
        provider: "resend",
        providerAccount: "transactional",
        providerEventId,
        eventType: "email.bounced",
        payload: {},
      },
    })
  );

  // And the same id through the *other* account is a different event, which is
  // what the account-aware unique exists to say. The dropped one refused this.
  await prisma.providerWebhookEvent.create({
    data: {
      provider: "resend",
      providerAccount: "marketing",
      providerEventId,
      eventType: "email.bounced",
      payload: {},
    },
  });
  assert.equal(
    await prisma.providerWebhookEvent.count({ where: { providerEventId } }),
    2
  );
});

test("a stored webhook event has to name the account it came through", async () => {
  // The column carried a default while the previous build was still inserting
  // without it. There is one writer now and it always names the account; a
  // default is how that stops being true without anyone noticing.
  const [column] = await prisma.$queryRaw<Array<{ column_default: string | null }>>`
    SELECT column_default
      FROM information_schema.columns
     WHERE table_name = 'ProviderWebhookEvent' AND column_name = 'providerAccount'
  `;
  assert.equal(column?.column_default ?? null, null);

  // Asked of the database rather than of the client: the field is required in
  // TypeScript, so only raw SQL can put the question.
  await assert.rejects(
    () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "ProviderWebhookEvent" ("id", "provider", "providerEventId", "eventType", "payload")
         VALUES ($1, 'resend', $2, 'email.bounced', '{}'::jsonb)`,
        randomUUID(),
        `svix-${randomUUID()}`
      ),
    /providerAccount/
  );
});

test("one provider message id belongs to one delivery, within its account", async () => {
  // The webhook matches a delivery by (account, message id), so two deliveries
  // claiming the same pair would make that match ambiguous -- and the handler
  // would have to guess which message a bounce was about.
  const providerMessageId = `resend-${randomUUID()}`;
  const sent = (overrides: Record<string, unknown>) =>
    delivery({ status: "sent", providerMessageId, ...overrides });

  await prisma.emailDelivery.create({
    data: sent({ providerAccount: "transactional" }),
  });

  await rejects("EmailDelivery_providerAccount_providerMessageId_key", () =>
    prisma.emailDelivery.create({
      data: sent({ providerAccount: "transactional" }),
    })
  );

  // The same id through the other account is a different message: the accounts
  // are separate Resend accounts and the id space is theirs, not ours.
  await prisma.emailDelivery.create({
    data: sent({ providerAccount: "marketing" }),
  });

  // A row with a null in either column conflicts with nothing, which is what
  // lets this index be plain rather than partial. All three shapes, twice each:
  // both null is the delivery that never reached the provider, and the
  // one-sided pairs are the states it passes through.
  for (const shape of [
    { providerAccount: null, providerMessageId: null },
    { providerAccount: "transactional", providerMessageId: null },
    { providerAccount: null, providerMessageId },
  ]) {
    for (let i = 0; i < 2; i += 1) {
      await prisma.emailDelivery.create({ data: delivery(shape) });
    }
  }

  // Four carry the id: the two accounts, and the two account-less rows the
  // one-sided shape created.
  assert.equal(
    await prisma.emailDelivery.count({ where: { providerMessageId } }),
    4
  );
});

test("the delivery message id index is unique, and is exactly what was asked for", async () => {
  // Rows with nulls pass a plain unique index and a partial one alike, so the
  // test above cannot tell the two apart -- and the difference is the whole
  // reason this index is written the way it is: schema.prisma can express a
  // partial index only behind a preview feature this schema does not enable, so
  // a partial one here would be invisible to `db push` and reported as drift on
  // every run. Asked of the catalogue directly.
  //
  // And asked about more than the predicate. An index of this name could be
  // several things that are not this one -- left INVALID by a failed
  // CONCURRENTLY build, built NULLS NOT DISTINCT (which would refuse the second
  // delivery that has not reached the provider yet), or carrying a third
  // expression key that makes the pair no longer unique on its own. Each is a
  // way for a future migration to satisfy the name and lose the guarantee.
  const [index] = await prisma.$queryRaw<
    Array<{
      is_unique: boolean;
      is_valid: boolean;
      is_ready: boolean;
      is_live: boolean;
      nulls_not_distinct: boolean;
      is_immediate: boolean;
      access_method: string;
      operator_classes: string[];
      key_atts: number;
      total_atts: number;
      has_expressions: boolean;
      predicate: string | null;
      columns: string[];
    }>
  >`
    SELECT i.indisunique         AS is_unique,
           i.indisvalid          AS is_valid,
           i.indisready          AS is_ready,
           i.indislive           AS is_live,
           i.indimmediate        AS is_immediate,
           am.amname             AS access_method,
           (
             SELECT array_agg(oc.opcname ORDER BY c.ord)
               FROM unnest(i.indclass::oid[]) WITH ORDINALITY AS c(oid, ord)
               JOIN pg_opclass oc ON oc.oid = c.oid
           ) AS operator_classes,
           i.indnullsnotdistinct AS nulls_not_distinct,
           i.indnkeyatts         AS key_atts,
           i.indnatts            AS total_atts,
           (i.indexprs IS NOT NULL) AS has_expressions,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           (
             SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a
                 ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           ) AS columns
      FROM pg_index i
      JOIN pg_class ix ON ix.oid = i.indexrelid
      JOIN pg_class tb ON tb.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = ix.relnamespace
      JOIN pg_am am ON am.oid = ix.relam
     WHERE ix.relname = 'EmailDelivery_providerAccount_providerMessageId_key'
       AND tb.relname = 'EmailDelivery'
       AND ns.nspname = current_schema()
  `;

  assert.ok(index, "the index is missing entirely");
  assert.equal(index.is_unique, true);
  assert.equal(index.is_valid, true);
  assert.equal(index.is_ready, true);
  assert.equal(index.is_live, true);
  assert.equal(index.nulls_not_distinct, false);
  assert.equal(index.predicate, null);
  assert.equal(index.has_expressions, false);
  assert.equal(Number(index.key_atts), 2);
  assert.equal(Number(index.total_atts), 2);
  assert.deepEqual(index.columns, ["providerAccount", "providerMessageId"]);
  // Immediate, because a deferred unique lets a transaction hold two rows with
  // the same pair until it commits, and the webhook matcher reads inside one.
  assert.equal(index.is_immediate, true);
  // And plain btree equality on both columns. An index that sorted by something
  // other than equality would not be the constraint this asked for, whatever
  // else about it matched.
  assert.equal(index.access_method, "btree");
  assert.deepEqual(index.operator_classes, ["text_ops", "text_ops"]);

  // And the plain index it replaced is gone: two structures for one question is
  // how they drift apart.
  const [old] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count
      FROM pg_class ix
      JOIN pg_namespace ns ON ns.oid = ix.relnamespace
     WHERE ix.relname = 'EmailDelivery_providerAccount_providerMessageId_idx'
       AND ns.nspname = current_schema()
  `;
  assert.equal(Number(old?.count ?? 0), 0);
});
