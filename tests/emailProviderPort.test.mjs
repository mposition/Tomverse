import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMAIL_PROVIDER_API_KEY_ENV_KEYS,
  EMAIL_PROVIDER_PORT_SURFACE,
  PORT_FORBIDDEN_CAPABILITIES,
  RESEND_SEND_ENDPOINT,
  parseRetryAfterMs,
  postToResend,
  providerApiKeyFor,
  verifyResendWebhook,
} from "../lib/emailProviderPortCore.ts";
import { svixSignatureFor } from "../lib/svixSignature.ts";

// One port, two methods, one provider.
// Contract: docs/policy/email-notifications.md §8.2, §9.1 step [5].

// ---------------------------------------------------------------------------
// The surface, which is the whole point of the port
// ---------------------------------------------------------------------------

test("the port is exactly send and verifyWebhook", () => {
  assert.deepEqual([...EMAIL_PROVIDER_PORT_SURFACE], ["send", "verifyWebhook"]);
});

test("the capabilities kept out of the port are the ones that hold product state", () => {
  // Each of these, at a provider, means the copy or the recipient list lives
  // there. Moving provider would then mean moving content, which is the
  // lock-in §8.2 exists to avoid -- not the API call, which is twenty lines.
  for (const capability of [
    "template",
    "contact",
    "segment",
    "audience",
    "broadcast",
    "automation",
    "campaign",
  ]) {
    assert.ok(
      PORT_FORBIDDEN_CAPABILITIES.includes(capability),
      `${capability} is not on the forbidden list`
    );
  }
});

// ---------------------------------------------------------------------------
// Which account each stream sends through
// ---------------------------------------------------------------------------

test("transactional reads its own key first and falls back to the shared one", () => {
  assert.equal(
    providerApiKeyFor("transactional", { RESEND_API_KEY: "shared" }),
    "shared"
  );
  assert.equal(
    providerApiKeyFor("transactional", {
      TRANSACTIONAL_RESEND_API_KEY: "own",
      RESEND_API_KEY: "shared",
    }),
    "own"
  );
  // Blank is not configured, or a deployment that cleared a variable by
  // setting it to empty would send from an account it did not choose.
  assert.equal(
    providerApiKeyFor("transactional", {
      TRANSACTIONAL_RESEND_API_KEY: "   ",
      RESEND_API_KEY: "shared",
    }),
    "shared"
  );
});

test("marketing never falls back to the transactional account", () => {
  // The failure this prevents has no symptom at send time: the promotion
  // arrives. Its complaints and unsubscribes then land on the account-wide
  // suppression list that decides whether login codes are delivered (§5.3.1).
  assert.equal(
    providerApiKeyFor("marketing", {
      RESEND_API_KEY: "shared",
      TRANSACTIONAL_RESEND_API_KEY: "own",
    }),
    null
  );
  assert.equal(
    providerApiKeyFor("marketing", { MARKETING_RESEND_API_KEY: "news" }),
    "news"
  );
  assert.ok(
    !EMAIL_PROVIDER_API_KEY_ENV_KEYS.marketing.includes("RESEND_API_KEY"),
    "marketing may not name the shared key at all"
  );
});

// ---------------------------------------------------------------------------
// The wire call
// ---------------------------------------------------------------------------

const okResponse = (body = { id: "msg_1" }) =>
  new Response(JSON.stringify(body), { status: 200 });

test("a send posts to the one endpoint and reports the From it used", async () => {
  let seen = null;
  const result = await postToResend(
    { to: "member@example.com", subject: "Hi", text: "hello", html: "<p>hi</p>" },
    {
      apiKey: "key",
      from: "Tomverse <hello@mail.example.com>",
      senderRole: "general",
      idempotencyKey: "delivery-1",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return okResponse();
      },
    }
  );

  assert.equal(seen.url, RESEND_SEND_ENDPOINT);
  assert.equal(seen.init.headers["Idempotency-Key"], "delivery-1");
  assert.equal(seen.init.headers.Authorization, "Bearer key");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.from, "Tomverse <hello@mail.example.com>");
  assert.equal(body.headers, undefined, "no headers key when none were given");
  assert.equal(body.reply_to, undefined, "no reply_to key when none was given");
  assert.deepEqual(result, {
    ok: true,
    providerMessageId: "msg_1",
    from: "Tomverse <hello@mail.example.com>",
    // Reported alongside the From, because with six senders on one domain the
    // address alone no longer answers "and was that the right one".
    senderRole: "general",
  });
});

test("a reply-to is sent only when one was resolved", async () => {
  // From and mailbox are different things: `security@` is an authenticated
  // sending identity and nothing says a person reads it, so a reply is directed
  // at the published contact address instead. Absent means the key is absent
  // rather than null -- the two are the same to Resend today, and only one of
  // them stays true if that changes.
  let seen = null;
  await postToResend(
    { to: "a@example.com", subject: "s", text: "t" },
    {
      apiKey: "key",
      from: "Tomverse Security <security@mail.example.com>",
      senderRole: "security",
      replyTo: "support@example.com",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return okResponse();
      },
    }
  );
  assert.equal(JSON.parse(seen.init.body).reply_to, "support@example.com");
});

test("the idempotency key is cut to the provider's limit", async () => {
  let seen = null;
  await postToResend(
    { to: "a@example.com", subject: "s", text: "t" },
    {
      apiKey: "key",
      from: "A <a@example.com>",
      senderRole: "general",
      idempotencyKey: "x".repeat(400),
      fetchImpl: async (_url, init) => {
        seen = init;
        return okResponse();
      },
    }
  );
  assert.equal(seen.headers["Idempotency-Key"].length, 256);
});

test("a text-only message sends no html field", async () => {
  // Operator alerts are text. Inventing an html body for them would mean
  // inventing a template for a message that exists to say the system is unwell.
  let body = null;
  await postToResend(
    { to: "ops@example.com", subject: "s", text: "t" },
    {
      apiKey: "key",
      from: "A <a@example.com>",
      senderRole: "general",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return okResponse();
      },
    }
  );
  assert.equal("html" in body, false);
  assert.equal(body.text, "t");
});

test("a rejected send reports its status and never its body", async () => {
  const result = await postToResend(
    { to: "a@example.com", subject: "s", text: "t" },
    {
      apiKey: "key",
      from: "A <a@example.com>",
      senderRole: "general",
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "member@example.com bounced" }), {
          status: 422,
          headers: { "Retry-After": "30" },
        }),
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.retryAfterMs, 30_000);
  assert.equal(
    JSON.stringify(result).includes("member@example.com"),
    false,
    "the provider's body reached the result"
  );
});

test("a transport failure is a null status, not a zero one", async () => {
  const boom = new Error("socket hang up");
  const result = await postToResend(
    { to: "a@example.com", subject: "s", text: "t" },
    {
      apiKey: "key",
      from: "A <a@example.com>",
      senderRole: "general",
      fetchImpl: async () => {
        throw boom;
      },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.transportError, boom);
});

test("Retry-After is read in both of its forms, and nonsense yields nothing", () => {
  assert.equal(parseRetryAfterMs("12"), 12_000);
  const now = Date.parse("2026-08-21T00:00:00Z");
  assert.equal(
    parseRetryAfterMs("Fri, 21 Aug 2026 00:00:30 GMT", now),
    30_000
  );
  // Not zero: "said nothing useful" and "go now" are different answers, and
  // only the caller's own schedule should decide the first.
  assert.equal(parseRetryAfterMs("soon"), undefined);
  assert.equal(parseRetryAfterMs(null), undefined);
});

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

const SECRET = ["whsec", "dGVzdHNlY3JldGZvcnRoZXBvcnQxMjM0NTY3OA"].join("_");

const signedHeaders = (body, { id = "msg_2vN", at = Date.now() } = {}) => {
  const timestamp = String(Math.floor(at / 1000));
  return new Headers({
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${svixSignatureFor({ id, timestamp, body, secret: SECRET })}`,
  });
};

test("a correctly signed webhook yields its id and parsed payload", () => {
  const body = JSON.stringify({ type: "email.bounced", data: { email_id: "e1" } });
  const verified = verifyResendWebhook(body, signedHeaders(body), SECRET);
  assert.equal(verified.ok, true);
  assert.equal(verified.id, "msg_2vN");
  assert.equal(verified.payload.type, "email.bounced");
});

test("a body altered after signing does not verify", () => {
  const body = JSON.stringify({ type: "email.bounced" });
  const headers = signedHeaders(body);
  const tampered = JSON.stringify({ type: "email.delivered" });
  const verified = verifyResendWebhook(tampered, headers, SECRET);
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "signature_mismatch");
});

test("a signed body that is not JSON says so, rather than blaming the signature", () => {
  // The endpoint answers 400 either way, but an operator reading the log needs
  // to know the signature verified: one of these is an attacker and the other
  // is the provider changing its payload.
  const body = "not json at all";
  const verified = verifyResendWebhook(body, signedHeaders(body), SECRET);
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "payload_not_json");
});

test("missing headers are their own reason", () => {
  const verified = verifyResendWebhook("{}", new Headers(), SECRET);
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "headers_missing");
});
