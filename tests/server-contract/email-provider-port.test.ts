import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The one implementation of the provider port, driven as its callers drive it.
//
// Contract: docs/policy/email-notifications.md §8.2, §9.1 step [5].
//
// `lib/emailProviderPortCore.ts` is unit-tested without a server; this file
// exists for the half that only the server binding decides: which environment
// variable each stream reads, and what happens when the stream has no sending
// identity of its own. Those are the two ways a message ends up sent from the
// wrong place, and neither is visible from the core.
//
// Runs here rather than in the unit suite because `lib/emailProviderPort.ts` is
// `server-only`.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

type PortModule = typeof import("@/lib/emailProviderPort");
let port: PortModule;
type IdentityModule = typeof import("@/lib/emailSendingIdentity");
let identity: IdentityModule;

const ENV_KEYS = [
  "RESEND_API_KEY",
  "TRANSACTIONAL_RESEND_API_KEY",
  "MARKETING_RESEND_API_KEY",
  "TRANSACTIONAL_EMAIL_FROM",
  "EMAIL_FROM",
  "MARKETING_EMAIL_FROM",
  "EMAIL_BUSINESS_CONTACT_EMAIL",
  "RESEND_WEBHOOK_SECRET",
] as const;
const originalEnv: Record<string, string | undefined> = {};

const setEnv = (values: Record<string, string | undefined>) => {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) env[key] = value;
  }
};

before(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  port = (await import(mod("lib/emailProviderPort.ts"))) as PortModule;
  identity = (await import(mod("lib/emailSendingIdentity.ts"))) as IdentityModule;
});

after(() => {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete env[key];
    else env[key] = originalEnv[key];
  }
});

test("the implementation has exactly the port's two methods", async () => {
  // An interface is erased, so it enforces nothing on its own. This is what
  // actually fails when somebody adds a third method: the surface constant and
  // the object have to agree, and `npm run check:email-provider-port` reads the
  // same constant against the declaration.
  const core = (await import(
    mod("lib/emailProviderPortCore.ts")
  )) as typeof import("@/lib/emailProviderPortCore");
  const methods = Object.getOwnPropertyNames(
    Object.getPrototypeOf(port.emailProvider())
  ).filter((name) => name !== "constructor");
  assert.deepEqual(methods.sort(), [...core.EMAIL_PROVIDER_PORT_SURFACE].sort());
});

test("an unconfigured deployment sends nothing and calls it that", async () => {
  setEnv({});
  const result = await port
    .emailProvider()
    .send({ to: "a@example.com", subject: "s", text: "t" },
      { stream: "transactional", senderRole: "general" }
    );
  assert.equal(result.ok, false);
  if (result.ok) return;
  // Distinct from a 401. A key the provider refused is an incident on a running
  // service; an absent one is the ordinary state of a local checkout, and a
  // lane that conflates them pages somebody every time a developer signs in.
  assert.equal(result.notConfigured, true);
  assert.equal(result.status, null);
});

test("marketing is refused rather than sent from the transactional account", async () => {
  // Both halves have to refuse independently: the account, because Resend's
  // suppression list is account-wide (§5.3.1), and the domain, because a
  // promotion's complaints must not land on the domain carrying login codes
  // (§5.3). This asserts the account half -- a marketing key present but no
  // marketing From still refuses, and no marketing key refuses first.
  setEnv({
    RESEND_API_KEY: "shared",
    TRANSACTIONAL_EMAIL_FROM: "Tomverse <hello@mail.example.com>",
  });
  const noAccount = await port
    .emailProvider()
    .send({ to: "a@example.com", subject: "s", text: "t" },
      { stream: "marketing", senderRole: "marketing" }
    );
  assert.equal(noAccount.ok, false);
  if (!noAccount.ok) assert.equal(noAccount.notConfigured, true);

  setEnv({
    RESEND_API_KEY: "shared",
    MARKETING_RESEND_API_KEY: "news",
    TRANSACTIONAL_EMAIL_FROM: "Tomverse <hello@mail.example.com>",
  });
  const noDomain = await port
    .emailProvider()
    .send({ to: "a@example.com", subject: "s", text: "t" },
      { stream: "marketing", senderRole: "marketing" }
    );
  assert.equal(noDomain.ok, false);
  if (!noDomain.ok) {
    assert.equal(noDomain.identityRefusal, "MARKETING_FROM_MISSING");
    assert.equal(
      noDomain.notConfigured,
      undefined,
      "an identity refusal is not a missing key"
    );
  }
});

test("a role on the wrong stream is refused before the wire", async () => {
  // The stream refusal above has a companion. A key and a domain being present
  // is not enough: `marketing` on the transactional stream would send a
  // promotion from the domain that carries login codes, and a transactional
  // role on the marketing stream would put a receipt on the marketing domain.
  // Neither reaches the provider (docs/policy/email-notifications.md §14.1a).
  setEnv({
    RESEND_API_KEY: "shared",
    MARKETING_RESEND_API_KEY: "news",
    TRANSACTIONAL_EMAIL_FROM: "Tomverse <hello@mail.example.com>",
    MARKETING_EMAIL_FROM: "Tomverse <news@news.example.com>",
  });

  const promotionOnTransactional = await port
    .emailProvider()
    .send(
      { to: "a@example.com", subject: "s", text: "t" },
      { stream: "transactional", senderRole: "marketing" }
    );
  assert.equal(promotionOnTransactional.ok, false);
  if (!promotionOnTransactional.ok) {
    assert.equal(
      promotionOnTransactional.identityRefusal,
      "SENDER_ROLE_NOT_ON_STREAM"
    );
  }

  const receiptOnMarketing = await port
    .emailProvider()
    .send(
      { to: "a@example.com", subject: "s", text: "t" },
      { stream: "marketing", senderRole: "billing" }
    );
  assert.equal(receiptOnMarketing.ok, false);
  if (!receiptOnMarketing.ok) {
    assert.equal(receiptOnMarketing.identityRefusal, "SENDER_ROLE_NOT_ON_STREAM");
  }
});

test("the readiness /api/ready reads covers every role, unmocked", async () => {
  // `getSendingIdentityReadiness` is the exact entry point the route calls, so
  // this is the regression that would catch the role checks being wired to a
  // function nothing reads. The route's own test mocks this module, which is
  // why the assertion has to live where the real one can be reached.
  const healthy = identity.getSendingIdentityReadiness({
    TRANSACTIONAL_EMAIL_FROM: "Tomverse Review <hello@mail.tomverse.app>",
    NODE_ENV: "production",
  });
  assert.equal(healthy.ready, true);
  assert.deepEqual(
    healthy.errors.map((problem) => problem.code),
    []
  );

  // Every role resolves through it, and every one of them lands on the domain
  // `TRANSACTIONAL_EMAIL_FROM` authenticates.
  for (const role of ["general", "security", "billing", "support", "operations"] as const) {
    const from = identity.senderIdentityFor("transactional", role, {
      TRANSACTIONAL_EMAIL_FROM: "Tomverse Review <hello@mail.tomverse.app>",
    });
    assert.equal(from.ok, true, role);
    if (from.ok) assert.equal(from.domain, "mail.tomverse.app", role);
  }

  // And the stream refusal it has always reported is unchanged.
  const shared = identity.getSendingIdentityReadiness({
    TRANSACTIONAL_EMAIL_FROM: "Tomverse <hello@mail.tomverse.app>",
    MARKETING_EMAIL_FROM: "Tomverse <news@mail.tomverse.app>",
  });
  assert.equal(shared.ready, false);
  assert.ok(
    shared.errors.some((problem) => problem.code === "STREAMS_SHARE_A_DOMAIN")
  );
});

test("a missing webhook secret is its own reason, not a bad signature", async () => {
  setEnv({});
  const verification = port
    .emailProvider()
    .verifyWebhook("{}", new Headers());
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.reason, "secret_missing");
});
