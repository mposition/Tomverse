import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import {
  ACCOUNT_WELCOME_TEMPLATE,
  MODEL_LAUNCH_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { MARKETING_HALT_SETTING_KEY } from "@/lib/marketingSendHealthCore";
import {
  activatePolicyVersion,
  ensureJurisdictionPolicyDraft,
} from "@/lib/emailJurisdictionPolicy";
import { observeOperationalIncidents } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import {
  drainStandardEmailDeliveries,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";

// The marketing path, executed rather than assumed (EM-03).
//
// Contract: docs/policy/email-notifications.md §5.1 C1, C5, C10, §5.3, §6.3.
//
// Three branches of `sendClaimedDelivery` are reachable only by a marketing
// message: the jurisdiction re-check, the `List-Unsubscribe` headers, and the
// marketing sending stream. Until `model_launch` existed there was no marketing
// template, so none of them had ever run and the first real campaign would have
// been their first execution.
//
// Nothing here sends to anyone: the provider is stubbed, and the default case
// is the one production is in -- `MARKETING_EMAIL_FROM` unset, so the lane
// refuses.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "ConsentRecord", "EmailPreference", "SuppressionEntry",
      "JurisdictionCountryMap", "JurisdictionProfile", "EmailPolicyVersion",
      "AppSetting", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

type SentBody = {
  subject: string;
  html: string;
  text: string;
  from?: string;
  /** Resend carries message headers in the request body, not as HTTP headers. */
  headers?: Record<string, string>;
};

const stubProvider = () => {
  const calls: Array<{ body: SentBody }> = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) as SentBody });
    return new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
};

const IDENTITY_ENV = {
  EMAIL_BUSINESS_LEGAL_NAME: "Tomverse Pty Ltd",
  EMAIL_BUSINESS_POSTAL_ADDRESS: "1 Example Street, Brisbane QLD 4000",
  EMAIL_BUSINESS_CONTACT_EMAIL: "support@tomverse.app",
  EMAIL_BUSINESS_REGISTRATION_NUMBER: "000-00-00000",
  EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER: "2026-Seoul-00000",
  EMAIL_BUSINESS_ABN: "00 000 000 000",
};

const PAYLOAD = {
  modelName: "Claude Opus 5.1",
  plans: "Pro and Max",
  highlights: ["200K context window"],
  creditLine: "Premium tier - 12 credits per message",
  ctaUrl: "https://tomverse.app/chat",
};

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.EMAIL_UNSUBSCRIBE_KEYS = "v1:test-unsubscribe-key";
  process.env.RESEND_API_KEY = "test-key";
  process.env.TRANSACTIONAL_EMAIL_FROM = "Tomverse <no-reply@mail.tomverse.app>";
  // The production state: marketing has no sending identity of its own.
  delete process.env.MARKETING_EMAIL_FROM;
  delete process.env.MARKETING_RESEND_API_KEY;
  for (const [key, value] of Object.entries(IDENTITY_ENV)) process.env[key] = value;
});

after(async () => {
  mock.restoreAll();
  for (const key of Object.keys(IDENTITY_ENV)) delete process.env[key];
  delete process.env.MARKETING_EMAIL_FROM;
  await reset();
  await prisma.$disconnect();
});

const activatePolicy = async () => {
  const draft = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({
    versionId: draft.version.id,
    actorId: randomUUID(),
    actorEmail: "ops@example.test",
  });
};

/** An account that opted in to product updates, in a country we can name. */
const subscriber = async (options?: { country?: string; consented?: boolean }) => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Subscriber" },
  });
  await prisma.userSettings.create({
    data: {
      userId: user.id,
      // Self-declared: an inferred country is not a declaration, and marketing
      // refuses anything that is not high confidence (§6.3).
      country: options?.country ?? "US",
      countrySource: "self_declared",
      language: "en",
    },
  });
  if (options?.consented !== false) {
    await prisma.emailPreference.create({
      data: {
        userId: user.id,
        purpose: "product_updates",
        enabled: true,
        source: "preference_center",
        grantedAt: new Date(),
      },
    });
  }
  return user;
};

const queue = async (user: { id: string; email: string | null }) =>
  enqueueStandardEmail({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    language: "en",
    payload: PAYLOAD,
  });

test("an account that never opted in is not sent product news", async () => {
  await activatePolicy();
  const calls = stubProvider();
  const user = await subscriber({ consented: false });
  const rows = await queue(user);

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 0);
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { status: true, skipReason: true },
  });
  assert.equal(delivery.status, "skipped");
  assert.equal(delivery.skipReason, "no_consent");
});

test("an unconfirmed jurisdiction stops marketing, and says which", async () => {
  await activatePolicy();
  const calls = stubProvider();
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Nowhere" },
  });
  await prisma.emailPreference.create({
    data: {
      userId: user.id,
      purpose: "product_updates",
      enabled: true,
      source: "preference_center",
      grantedAt: new Date(),
    },
  });
  const rows = await queue(user);

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 0);
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { status: true, skipReason: true },
  });
  assert.equal(delivery.status, "skipped");
  // Not "no_consent": they did consent. What is missing is where they are, and
  // "(광고)" versus "<ADV>" is not a difference anything can split.
  assert.equal(delivery.skipReason, "jurisdiction_unconfirmed");
});

test("with no marketing sending identity the send fails and reports once", async () => {
  // A key but no domain. With neither, the provider stops at the missing key
  // and never reaches the identity question -- see the test below.
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  await activatePolicy();
  const calls = stubProvider();
  const incidents: string[] = [];
  const stop = observeOperationalIncidents((incident) => incidents.push(incident.code));
  const user = await subscriber();
  const rows = await queue(user);

  try {
    await drainStandardEmailDeliveries({ limit: 1 });
  } finally {
    stop();
  }

  assert.equal(calls.length, 0, "nothing may reach the provider");
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { status: true, lastErrorKind: true },
  });
  // Permanent, not retried: no amount of waiting sets an environment variable.
  assert.equal(delivery.status, "failed");
  assert.match(String(delivery.lastErrorKind), /identity_marketing_from_missing/);
  assert.deepEqual(
    incidents.filter((code) => code === "EMAIL_SENDING_IDENTITY_REFUSED"),
    ["EMAIL_SENDING_IDENTITY_REFUSED"]
  );
});

test("with neither key nor domain the message waits rather than failing", async () => {
  // Today's production state. The provider stops at the missing key, which is
  // "not configured" and therefore transient: the message stays queued and
  // retries, because setting a variable is something that can happen later.
  // It is a different outcome from the identity refusal above, and conflating
  // the two would either lose messages or retry a refusal forever.
  await activatePolicy();
  const calls = stubProvider();
  const user = await subscriber();
  const rows = await queue(user);

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 0);
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { status: true, attempts: true, nextAttemptAt: true },
  });
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempts, 1);
  assert.ok(delivery.nextAttemptAt);
});

test("configured, it sends from the marketing domain with one-click headers", async () => {
  // The marketing stream has its own key by design: it does not fall back to
  // the transactional one, so a promotion cannot be sent on the credential
  // stream's reputation.
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  await activatePolicy();
  const calls = stubProvider();
  const user = await subscriber();
  await queue(user);

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 1);
  assert.match(String(calls[0].body.from), /news@news\.tomverse\.app/);
  // RFC 8058. C5 requires them here and C10 forbids them everywhere else.
  const headers = calls[0].body.headers ?? {};
  assert.match(String(headers["List-Unsubscribe"]), /^<https:\/\/.*\/unsubscribe\?t=.+>$/);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("a Korean subscriber's subject carries the advertising label", async () => {
  // The marketing stream has its own key by design: it does not fall back to
  // the transactional one, so a promotion cannot be sent on the credential
  // stream's reputation.
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  await activatePolicy();
  const calls = stubProvider();
  const user = await subscriber({ country: "KR" });
  await queue(user);

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 1);
  // 정보통신망법 제50조제4항. The body stays in the account's own language:
  // jurisdiction and language are different axes.
  assert.ok(calls[0].body.subject.startsWith("(광고)"));
  assert.ok(calls[0].body.subject.includes("Claude Opus 5.1"));
  assert.ok(calls[0].body.text.includes("200K context window"));
  // The Korean footer blocks, and the unsubscribe link marketing must carry.
  assert.ok(calls[0].body.text.includes(IDENTITY_ENV.EMAIL_BUSINESS_REGISTRATION_NUMBER));
  assert.match(calls[0].body.text, /\/unsubscribe\?t=/);
});

test("the same message to a US subscriber is not labelled", async () => {
  // The marketing stream has its own key by design: it does not fall back to
  // the transactional one, so a promotion cannot be sent on the credential
  // stream's reputation.
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  await activatePolicy();
  const calls = stubProvider();
  const user = await subscriber({ country: "US" });
  await queue(user);

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].body.subject, /광고/);
  assert.ok(calls[0].body.subject.startsWith("Claude Opus 5.1"));
});

test("an incomplete business identity holds marketing rather than sending it", async () => {
  // The marketing stream has its own key by design: it does not fall back to
  // the transactional one, so a promotion cannot be sent on the credential
  // stream's reputation.
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  // The KR footer names the registration numbers, and an advertisement that
  // cannot say who sent it cannot be recalled once it has arrived.
  delete process.env.EMAIL_BUSINESS_REGISTRATION_NUMBER;
  await activatePolicy();
  const calls = stubProvider();
  const user = await subscriber({ country: "KR" });
  const rows = await queue(user);

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 0);
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { status: true, skipReason: true },
  });
  assert.equal(delivery.status, "skipped");
  assert.equal(delivery.skipReason, "jurisdiction_footer_incomplete");
});

test("a transactional message keeps its own stream and carries no unsubscribe", async () => {
  // The marketing stream has its own key by design: it does not fall back to
  // the transactional one, so a promotion cannot be sent on the credential
  // stream's reputation.
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  await activatePolicy();
  const calls = stubProvider();
  const user = await subscriber();
  await enqueueStandardEmail({
    templateKey: "account_welcome",
    emailAddress: user.email,
    userId: user.id,
    language: "en",
    payload: { name: user.name },
  });

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 1);
  assert.match(String(calls[0].body.from), /mail\.tomverse\.app/);
  assert.equal(calls[0].body.headers, undefined);
  assert.doesNotMatch(calls[0].body.subject, /광고/);
});

// EM-09: the stream stops itself.
//
// Contract: docs/policy/email-notifications.md §14.5.
//
// The thresholds and the arithmetic have unit tests. What needs a database is
// that the switch is reached from a real send, that a halted stream refuses,
// and -- the part that matters most -- that it refuses marketing only.

/** Marketing deliveries in the window, as the counter will see them. */
const priorMarketingSends = async (input: {
  sent: number;
  complained: number;
}) => {
  const template = await prisma.emailTemplate.findFirstOrThrow({
    where: { key: MODEL_LAUNCH_TEMPLATE },
    select: { id: true },
  });
  const version = await prisma.templateVersion.findFirstOrThrow({
    where: { templateId: template.id },
    select: { id: true },
  });
  const policy = await prisma.emailPolicyVersion.findFirstOrThrow({
    select: { id: true },
  });
  const now = new Date();
  for (let index = 0; index < input.sent; index += 1) {
    const event = await prisma.emailEvent.create({
      data: {
        kind: `email.${MODEL_LAUNCH_TEMPLATE}`,
        templateId: template.id,
        payload: { language: "en" },
        audienceKind: "single_user",
        status: "expanded",
      },
      select: { id: true },
    });
    await prisma.emailDelivery.create({
      data: {
        eventId: event.id,
        recipientKey: `addr:prior-${index}@example.test`,
        lane: "standard",
        emailAddress: `prior-${index}@example.test`,
        language: "en",
        jurisdictionCountry: "AU",
        jurisdictionProfileKey: "AU",
        policyVersionId: policy.id,
        templateVersionId: version.id,
        idempotencyKey: `prior-${index}-${randomUUID()}`,
        status: index < input.complained ? "complained" : "delivered",
        attempts: 1,
        sentAt: now,
      },
    });
  }
};

test("a complaint rate over the threshold halts the stream", async () => {
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  await activatePolicy();
  // Seed the template and its version by queuing one message first.
  const seed = await subscriber();
  await queue(seed);
  await priorMarketingSends({ sent: 200, complained: 5 });

  const calls = stubProvider();
  const incidents: string[] = [];
  const stop = observeOperationalIncidents((incident) => incidents.push(incident.code));
  const user = await subscriber();
  const rows = await queue(user);

  try {
    await drainStandardEmailDeliveries({ limit: 5 });
  } finally {
    stop();
  }

  assert.equal(calls.length, 0, "a halted stream sends nothing");
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { status: true, skipReason: true },
  });
  assert.equal(delivery.status, "skipped");
  assert.equal(delivery.skipReason, "marketing_halted");
  assert.ok(incidents.includes("EMAIL_MARKETING_HALTED"));

  // Sticky: the reason is stored, so clearing it is a person's decision.
  const stored = await prisma.appSetting.findUniqueOrThrow({
    where: { key: MARKETING_HALT_SETTING_KEY },
    select: { value: true },
  });
  assert.match(stored.value, /complaint/);
});

test("a halt does not lift when the numbers improve", async () => {
  // The window rolls. A halt that lifted with it would resume into exactly the
  // reputation it was protecting.
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  await activatePolicy();
  await prisma.appSetting.create({
    data: {
      key: MARKETING_HALT_SETTING_KEY,
      value: JSON.stringify({
        haltedAt: new Date().toISOString(),
        metric: "complaint",
        rate: 0.02,
        observed: 20,
        sent: 1000,
        reason: "Complaint rate 2.00% is above the halt threshold.",
      }),
    },
  });

  const calls = stubProvider();
  const user = await subscriber();
  const rows = await queue(user);
  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 0);
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { skipReason: true },
  });
  assert.equal(delivery.skipReason, "marketing_halted");
});

test("a halted marketing stream does not stop a transactional message", async () => {
  // The boundary that matters most. Provider suppression is already
  // account-wide (§5.3.1), so a kill switch that could stop transactional mail
  // would be a second route to login codes not arriving.
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  await activatePolicy();
  await prisma.appSetting.create({
    data: {
      key: MARKETING_HALT_SETTING_KEY,
      value: JSON.stringify({
        haltedAt: new Date().toISOString(),
        metric: "complaint",
        rate: 0.02,
        observed: 20,
        sent: 1000,
        reason: "halted",
      }),
    },
  });

  const calls = stubProvider();
  const user = await subscriber();
  const rows = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    language: "en",
    payload: { name: "Subscriber" },
  });

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(calls.length, 1, "the welcome still goes out");
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { status: true, skipReason: true },
  });
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.skipReason, null);
});

test("a clean window sends and stores no halt", async () => {
  process.env.MARKETING_EMAIL_FROM = "Tomverse <news@news.tomverse.app>";
  process.env.MARKETING_RESEND_API_KEY = "test-marketing-key";
  await activatePolicy();
  const seed = await subscriber();
  await queue(seed);
  await priorMarketingSends({ sent: 200, complained: 0 });

  const calls = stubProvider();
  const user = await subscriber();
  await queue(user);
  await drainStandardEmailDeliveries({ limit: 5 });

  assert.ok(calls.length > 0, "nothing was wrong, so it sends");
  assert.equal(
    await prisma.appSetting.count({ where: { key: MARKETING_HALT_SETTING_KEY } }),
    0
  );
});
