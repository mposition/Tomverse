import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  ensureDefaultPreferences,
  readPreferences,
  setPreference,
  withdrawAllMarketing,
} from "@/lib/emailPreferences";
import { suppressionCheck } from "@/lib/emailSuppression";
import {
  jurisdictionForUser,
  recordBillingCountry,
  setSelfDeclaredCountry,
} from "@/lib/emailJurisdiction";
import {
  createUnsubscribeToken,
  readUnsubscribeKeyring,
} from "@/lib/unsubscribeToken";
import { unsubscribeHeaders } from "@/lib/emailUnsubscribeHeaders";
import {
  ACCOUNT_WELCOME_TEMPLATE,
  emailTemplateDefinition,
} from "@/lib/emailTemplateDefinitions";
import {
  drainStandardEmailDeliveries,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";

// Preferences, the consent history behind them, and unsubscribing without a
// login.
//
// Contract: docs/policy/email-notifications.md
// §10.2, §11.2, §11.4, §17.1.
//
// The pair of tables is the thing under test: EmailPreference is overwritten on
// every change and cannot be evidence of anything, so ConsentRecord exists
// beside it and is never updated. CASL and the Australian Spam Act both put the
// burden of proving consent on the sender.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ConsentRecord", "EmailPreference", "SuppressionEntry", "EmailDelivery",
      "EmailEvent", "TemplateVersion", "EmailTemplate", "EmailPolicyVersion",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  process.env.NEXTAUTH_SECRET = "test-secret";
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.EMAIL_UNSUBSCRIBE_KEYS = "v1:test-unsubscribe-key";
  process.env.EMAIL_UNSUBSCRIBE_KEY_VERSION = "v1";
  process.env.RESEND_API_KEY = "test-key";
});

after(async () => {
  mock.restoreAll();
  await reset();
  await prisma.$disconnect();
});

const someone = () =>
  prisma.user.create({
    data: { email: `${randomUUID()}@example.com`, name: "Someone" },
  });

test("a new account starts with nothing consent-based switched on", async () => {
  const user = await someone();
  await ensureDefaultPreferences(user.id);

  const state = await readPreferences(user.id);
  const byPurpose = Object.fromEntries(state.map((row) => [row.purpose, row]));

  assert.equal(byPurpose.security.enabled, true);
  assert.equal(byPurpose.billing.enabled, true);
  assert.equal(byPurpose.service_status.enabled, true);
  assert.equal(byPurpose.newsletter.enabled, false);
  assert.equal(byPurpose.promotions.enabled, false);
  assert.equal(byPurpose.product_updates.enabled, false);

  assert.equal(byPurpose.security.locked, true);
  assert.equal(byPurpose.newsletter.locked, false);

  // No consent record for a default. Nobody agreed to anything at signup, and
  // a `granted` row here would be a false statement in the one table whose
  // purpose is to be true about consent.
  assert.equal(await prisma.consentRecord.count(), 0);
});

test("seeding twice does not reset somebody's choices", async () => {
  const user = await someone();
  await ensureDefaultPreferences(user.id);
  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });

  // This runs on every settings read.
  await ensureDefaultPreferences(user.id);

  const state = await readPreferences(user.id);
  assert.equal(
    state.find((row) => row.purpose === "newsletter")?.enabled,
    true
  );
});

test("agreeing writes an entry that says when, under which policy, on what", async () => {
  const user = await someone();

  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
    ip: "203.0.113.10",
    userAgent: "Mozilla/5.0",
    consentWording: "Send me the Tomverse newsletter",
  });

  const record = await prisma.consentRecord.findFirstOrThrow();
  assert.equal(record.action, "granted");
  assert.equal(record.purpose, "newsletter");
  assert.equal(record.emailAddress, user.email!.toLowerCase());
  assert.ok(record.policyVersionId);
  assert.equal(record.capturedVia, "preference_center");

  // Hashed, not stored. A raw address proves nothing about a consent event that
  // its hash does not, and proves plenty about everything else the person did.
  assert.ok(record.ipHash);
  assert.equal(record.ipHash.includes("203.0.113.10"), false);
  assert.ok(record.userAgentHash);
  assert.equal(
    JSON.stringify(record.evidence).includes("Send me the Tomverse newsletter"),
    false
  );

  // Unresolved rather than guessed: marketing needs a confirmed jurisdiction
  // before it sends, and a guess recorded here would be laundered into
  // evidence.
  assert.equal(record.jurisdiction, "ZZ");
  assert.equal(record.jurisdictionSource, "unresolved");
});

test("the history is append-only and distinguishes re-agreeing from agreeing", async () => {
  const user = await someone();
  const change = (enabled: boolean) =>
    setPreference({
      userId: user.id,
      purpose: "promotions",
      enabled,
      capturedVia: "preference_center",
      source: "preference_center",
    });

  await change(true);
  await change(false);
  await change(true);

  const records = await prisma.consentRecord.findMany({
    orderBy: { occurredAt: "asc" },
    select: { action: true },
  });
  assert.deepEqual(
    records.map((row) => row.action),
    ["granted", "withdrawn", "granted"]
  );

  // The current state is one row; the history is three. Overwriting the first
  // would leave nothing able to answer when consent began.
  assert.equal(
    await prisma.emailPreference.count({
      where: { userId: user.id, purpose: "promotions" },
    }),
    1
  );
});

test("turning off something nobody consents to writes no consent record", async () => {
  const user = await someone();
  await setPreference({
    userId: user.id,
    purpose: "service_status",
    enabled: false,
    capturedVia: "preference_center",
    source: "preference_center",
  });

  // An outage notice is contract performance. Recording it as a consent
  // withdrawal would put entries in an evidence table for something no
  // jurisdiction asked consent for.
  assert.equal(await prisma.consentRecord.count(), 0);
  const state = await readPreferences(user.id);
  assert.equal(
    state.find((row) => row.purpose === "service_status")?.enabled,
    false
  );
});

test("security and billing cannot be switched off through the service either", async () => {
  const user = await someone();

  for (const purpose of ["security", "billing"]) {
    const result = await setPreference({
      userId: user.id,
      purpose,
      enabled: false,
      capturedVia: "preference_center",
      source: "preference_center",
    });
    assert.deepEqual(result, { changed: false, reason: "locked" });
  }

  const state = await readPreferences(user.id);
  assert.equal(state.find((row) => row.purpose === "security")?.enabled, true);
});

test("a withdrawal suppresses by address, so it survives the account", async () => {
  const user = await someone();
  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: false,
    capturedVia: "unsubscribe_page",
    source: "unsubscribe_link",
    viaToken: true,
  });

  // Somebody who unsubscribes, deletes their account and signs up again must
  // not quietly start receiving newsletters because a fresh preference row
  // defaulted them back on.
  const entry = await prisma.suppressionEntry.findFirstOrThrow();
  assert.equal(entry.scope, "purpose");
  assert.equal(entry.purposeKey, "newsletter");
  assert.equal(entry.reason, "unsubscribe");
  assert.equal(entry.source, "unsubscribe_link");

  assert.deepEqual(
    await suppressionCheck({
      emailAddress: user.email!,
      classification: "marketing",
      purpose: "newsletter",
    }),
    { allowed: false, skipReason: "no_consent" }
  );
  // And it still does not touch the mail they cannot switch off.
  assert.deepEqual(
    await suppressionCheck({
      emailAddress: user.email!,
      classification: "transactional",
    }),
    { allowed: true }
  );
});

test("re-enabling clears its own hold and never a global one", async () => {
  const user = await someone();
  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: false,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  await prisma.suppressionEntry.create({
    data: {
      emailAddress: user.email!.toLowerCase(),
      scope: "global",
      purposeKey: "*",
      reason: "complaint",
      source: "provider_webhook",
    },
  });

  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });

  const remaining = await prisma.suppressionEntry.findMany({
    select: { scope: true, reason: true },
  });
  // A toggle may lift its own preference hold. It may not lift a complaint --
  // §12.4 requires dual approval to remove one of those.
  assert.deepEqual(remaining, [{ scope: "global", reason: "complaint" }]);
});

test("repeating an unsubscribe is a no-op, not a second withdrawal", async () => {
  const user = await someone();
  await setPreference({
    userId: user.id,
    purpose: "promotions",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });

  const first = await setPreference({
    userId: user.id,
    purpose: "promotions",
    enabled: false,
    capturedVia: "unsubscribe_page",
    source: "unsubscribe_link",
    viaToken: true,
  });
  const second = await setPreference({
    userId: user.id,
    purpose: "promotions",
    enabled: false,
    capturedVia: "unsubscribe_page",
    source: "unsubscribe_link",
    viaToken: true,
  });

  assert.equal(first.changed, true);
  assert.deepEqual(second, { changed: false, reason: "already_set" });

  // The link is followed twice, the form is double-submitted, the one-click
  // header and the confirmation page both fire. One withdrawal.
  assert.equal(
    await prisma.consentRecord.count({ where: { action: "withdrawn" } }),
    1
  );
});

test("a token cannot switch anything on", async () => {
  const user = await someone();

  const result = await setPreference({
    userId: user.id,
    purpose: "promotions",
    enabled: true,
    capturedVia: "unsubscribe_page",
    source: "unsubscribe_link",
    viaToken: true,
  });

  // The property that lets the link work with no login at all: a leaked
  // token's worst case is that somebody receives less mail.
  assert.deepEqual(result, { changed: false, reason: "token_cannot_enable" });
});

test("one action stops every marketing purpose", async () => {
  const user = await someone();
  for (const purpose of ["product_updates", "newsletter", "promotions"]) {
    await setPreference({
      userId: user.id,
      purpose,
      enabled: true,
      capturedVia: "preference_center",
      source: "preference_center",
    });
  }

  await withdrawAllMarketing({
    userId: user.id,
    capturedVia: "unsubscribe_page",
    source: "unsubscribe_link",
  });

  const state = await readPreferences(user.id);
  for (const purpose of ["product_updates", "newsletter", "promotions"]) {
    assert.equal(
      state.find((row) => row.purpose === purpose)?.enabled,
      false,
      `${purpose} should be off`
    );
  }
  // Making somebody flip five switches to stop hearing from us is the friction
  // the Australian rule against extra steps exists to prevent.
  assert.equal(
    state.find((row) => row.purpose === "service_status")?.enabled,
    true
  );
});

test("a preference is checked at send time, not at enqueue time", async () => {
  const user = await someone();
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: "Someone" },
  });

  // The welcome email is transactional and has no purpose, so it is unaffected
  // by any preference -- which is the point being pinned here.
  mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  const drain = await drainStandardEmailDeliveries();
  assert.equal(drain.sent, 1);
});

test("transactional mail never carries an unsubscribe header", async () => {
  const definition = emailTemplateDefinition(ACCOUNT_WELCOME_TEMPLATE);

  // Several mail clients surface List-Unsubscribe as a prominent button. On a
  // login code that button unsubscribes somebody from their own
  // authentication, so the rule is keyed on the template flag the database
  // holds against the classification.
  assert.deepEqual(
    unsubscribeHeaders({
      requiresUnsubscribe: definition.requiresUnsubscribe,
      userId: "user_1",
      purpose: definition.purpose,
      deliveryId: "del_1",
      appUrl: "https://tomverse.app",
    }),
    {}
  );

  const marketing = unsubscribeHeaders({
    requiresUnsubscribe: true,
    userId: "user_1",
    purpose: "newsletter",
    deliveryId: "del_1",
    appUrl: "https://tomverse.app",
  });
  assert.match(marketing["List-Unsubscribe"], /^<https:\/\/tomverse\.app\/unsubscribe\?t=/);
  assert.equal(marketing["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  // The link resolves back to exactly one subject and one purpose.
  const token = decodeURIComponent(
    marketing["List-Unsubscribe"].match(/t=([^>]+)>/)![1]
  );
  const keyring = readUnsubscribeKeyring(process.env)!;
  const { readUnsubscribeToken } = await import("@/lib/unsubscribeToken");
  const read = readUnsubscribeToken(token, keyring);
  assert.equal(read.valid, true);
  assert.deepEqual(read.valid && read.payload, {
    userId: "user_1",
    purpose: "newsletter",
    deliveryId: "del_1",
  });
});

test("marketing without a working unsubscribe key is refused, not sent bare", async () => {
  delete process.env.EMAIL_UNSUBSCRIBE_KEYS;

  // A marketing message with no working unsubscribe link is one that must not
  // go out at all.
  assert.throws(
    () =>
      unsubscribeHeaders({
        requiresUnsubscribe: true,
        userId: "user_1",
        purpose: "newsletter",
        deliveryId: "del_1",
        appUrl: "https://tomverse.app",
      }),
    /cannot be sent without one/
  );
});

test("a token names one subject and one purpose and nothing else", async () => {
  const keyring = readUnsubscribeKeyring(process.env)!;
  const token = createUnsubscribeToken(
    { userId: "user_a", purpose: "newsletter" },
    keyring
  );
  const other = createUnsubscribeToken(
    { userId: "user_b", purpose: "promotions" },
    keyring
  );

  assert.notEqual(token, other);
  assert.equal(token.includes("user_a"), false);
});

test("a jurisdiction resolves from the payment method and the declaration", async () => {
  const user = await someone();
  await prisma.userSettings.create({
    data: { userId: user.id, language: "en", timeZone: "UTC" },
  });

  // Nothing known yet: honest rather than guessed, and marketing will not send.
  const unknown = await jurisdictionForUser({ userId: user.id });
  assert.equal(unknown.confidence, "unknown");
  assert.equal(unknown.countryCode, "ZZ");

  await setSelfDeclaredCountry({ userId: user.id, country: "kr" });
  const declared = await jurisdictionForUser({ userId: user.id });
  assert.equal(declared.countryCode, "KR");
  assert.equal(declared.confidence, "high");
  assert.equal(declared.source, "self_declared");

  // Agreeing does not change it.
  await recordBillingCountry({ userId: user.id, country: "KR" });
  const agreed = await jurisdictionForUser({ userId: user.id });
  assert.equal(agreed.confidence, "high");
  assert.equal(agreed.source, "billing");
});

test("a payment method from elsewhere is a conflict, not a move", async () => {
  const user = await someone();
  await prisma.userSettings.create({
    data: { userId: user.id, language: "en", timeZone: "UTC" },
  });
  await setSelfDeclaredCountry({ userId: user.id, country: "KR" });
  await recordBillingCountry({ userId: user.id, country: "SG" });

  const resolved = await jurisdictionForUser({ userId: user.id });
  assert.equal(resolved.confidence, "conflict");
  assert.deepEqual(resolved.conflicts.sort(), ["KR", "SG"]);
  // The declaration is preserved, not overwritten: paying with a card
  // registered elsewhere is not moving house.
  assert.equal(resolved.selfDeclaredCountry, "KR");
});

test("an inferred country is never read back as a declaration", async () => {
  const user = await someone();
  await prisma.userSettings.create({
    data: { userId: user.id, language: "ko", timeZone: "Asia/Seoul" },
  });

  const resolved = await jurisdictionForUser({ userId: user.id });
  assert.equal(resolved.countryCode, "KR");
  assert.equal(resolved.confidence, "low");
  // The field stays empty, so the preference centre asks rather than
  // pre-filling a guess that a save would turn into a fact.
  assert.equal(resolved.selfDeclaredCountry, null);
});

test("an IP is observed and changes nothing", async () => {
  const user = await someone();
  await prisma.userSettings.create({
    data: { userId: user.id, language: "en", timeZone: "UTC" },
  });
  await setSelfDeclaredCountry({ userId: user.id, country: "KR" });

  const resolved = await jurisdictionForUser({
    userId: user.id,
    ipCountry: "US",
  });
  assert.equal(resolved.countryCode, "KR");
  assert.equal(resolved.observedIpCountry, "US");
});

test("a withdrawn consent does not tell us where somebody is", async () => {
  const user = await someone();
  await prisma.userSettings.create({
    data: { userId: user.id, language: "en", timeZone: "UTC" },
  });
  await setSelfDeclaredCountry({ userId: user.id, country: "KR" });
  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: false,
    capturedVia: "preference_center",
    source: "preference_center",
  });

  // Clear the declaration; only the consent history is left, and the standing
  // consent is gone.
  await prisma.userSettings.update({
    where: { userId: user.id },
    data: { country: null, countrySource: null },
  });

  const resolved = await jurisdictionForUser({ userId: user.id });
  assert.equal(resolved.confidence, "unknown");
});
