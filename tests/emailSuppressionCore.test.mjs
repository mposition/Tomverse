import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SOFT_BOUNCE_SUPPRESSION_THRESHOLD,
  providerEventEffect,
  suppressionVerdict,
} from "../lib/emailSuppressionCore.ts";
import {
  SVIX_TIMESTAMP_TOLERANCE_SECONDS,
  readSvixHeaders,
  svixSignatureFor,
  verifySvixSignature,
} from "../lib/svixSignature.ts";

// Suppression decisions and webhook signature verification. Contract §13.3, §9.6.

const marketing = (records) =>
  suppressionVerdict({ classification: "marketing", records });
const transactional = (records) =>
  suppressionVerdict({ classification: "transactional", records });

test("a complaint about marketing does not stop a login code", () => {
  const records = [{ reason: "complaint", sourceStream: "marketing" }];

  // Blocking here locks someone out of the account they were trying to leave,
  // and transactional mail is not consent-based anywhere surveyed in section 4.
  assert.deepEqual(transactional(records), { allowed: true });
  assert.deepEqual(marketing(records), {
    allowed: false,
    skipReason: "suppressed_complaint",
  });
});

test("a complaint about transactional mail is sent and flagged", () => {
  // Either an account takeover is in progress and the victim is reporting our
  // own security alert, or we are calling something transactional that the
  // recipient does not experience that way. Both need a person to look.
  assert.deepEqual(
    transactional([{ reason: "complaint", sourceStream: "transactional" }]),
    { allowed: true, raiseIncident: "transactional_complaint" }
  );

  // An unattributed complaint is treated the same way rather than assumed
  // harmless: not knowing where it came from is not evidence that it was fine.
  assert.deepEqual(transactional([{ reason: "complaint" }]), {
    allowed: true,
    raiseIncident: "transactional_complaint",
  });
});

test("a hard bounce stops everything, including legal mail", () => {
  const records = [{ reason: "hard_bounce" }];

  for (const classification of ["transactional", "service", "legal", "marketing"]) {
    assert.deepEqual(
      suppressionVerdict({ classification, records }),
      { allowed: false, skipReason: "hard_bounce" },
      `${classification} should stop at a hard bounce`
    );
  }
});

test("a soft bounce holds bulk back but lets the important mail through", () => {
  const records = [
    { reason: "soft_bounce", expiresAt: new Date(Date.now() + 60_000) },
  ];

  assert.deepEqual(marketing(records), {
    allowed: false,
    skipReason: "soft_bounce",
  });
  assert.deepEqual(transactional(records), { allowed: true });
  assert.deepEqual(
    suppressionVerdict({ classification: "legal", records }),
    { allowed: true }
  );
});

test("an expired hold stops holding", () => {
  const stale = [
    { reason: "soft_bounce", expiresAt: new Date(Date.now() - 60_000) },
  ];
  assert.deepEqual(marketing(stale), { allowed: true });
});

test("an unsubscribe stops marketing and nothing else", () => {
  const records = [{ reason: "unsubscribe" }];
  assert.deepEqual(marketing(records), { allowed: false, skipReason: "no_consent" });
  assert.deepEqual(transactional(records), { allowed: true });
});

test("a deliberate stop outranks even the must-reach classes", () => {
  // Unlike a bounce or a complaint, an operator action and a data-subject
  // request are decisions somebody made about this address on purpose.
  for (const reason of ["manual", "privacy_request"]) {
    assert.deepEqual(
      suppressionVerdict({ classification: "legal", records: [{ reason }] }),
      { allowed: false, skipReason: "suppressed_complaint" }
    );
  }
});

test("a bounce is only permanent when the provider says it is", () => {
  assert.deepEqual(
    providerEventEffect({ type: "email.bounced", bounceType: "Hard" }),
    {
      kind: "suppress",
      reason: "hard_bounce",
      deliveryStatus: "bounced",
      temporary: false,
    }
  );

  // A full mailbox is not a dead one. Treating it as permanent throws away a
  // real recipient over a transient condition.
  assert.deepEqual(
    providerEventEffect({ type: "email.bounced", bounceType: "Transient" }),
    { kind: "soft_bounce" }
  );

  // No sub-type is read as soft, because a wrongly-permanent suppression is
  // invisible and a wrongly-transient one corrects itself.
  assert.deepEqual(providerEventEffect({ type: "email.bounced" }), {
    kind: "soft_bounce",
  });
});

test("events we deliberately do not collect are ignored, not errors", () => {
  for (const type of ["email.opened", "email.clicked", "contact.created"]) {
    assert.deepEqual(providerEventEffect({ type }), { kind: "ignored" });
  }

  assert.deepEqual(providerEventEffect({ type: "email.delivered" }), {
    kind: "delivery_status",
    status: "delivered",
  });
});

test("one deferral means nothing and a run of them means something", () => {
  assert.ok(SOFT_BOUNCE_SUPPRESSION_THRESHOLD > 1);
  assert.ok(SOFT_BOUNCE_SUPPRESSION_THRESHOLD <= 10);
});

const signed = (body, secret, timestamp) => {
  const id = "msg_test";
  return {
    headers: new Headers({
      "svix-id": id,
      "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${svixSignatureFor({ id, timestamp: String(timestamp), body, secret })}`,
    }),
    body,
  };
};

test("the published Svix vector verifies", () => {
  // https://docs.svix.com/receiving/verifying-payloads/how-manual
  assert.equal(
    svixSignatureFor({
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: "1614265330",
      body: '{"test": 2432232314}',
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    }),
    "g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
  );
});

test("a correctly signed request verifies and a tampered one does not", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const now = 1_700_000_000;
  const { headers, body } = signed('{"type":"email.bounced"}', secret, now);

  assert.deepEqual(
    verifySvixSignature({
      headers: readSvixHeaders(headers),
      body,
      secret,
      nowSeconds: now,
    }),
    { valid: true, id: "msg_test" }
  );

  // The raw bytes are signed, so a body re-serialised from a parsed object --
  // reordered keys, different whitespace -- verifies against nothing.
  assert.deepEqual(
    verifySvixSignature({
      headers: readSvixHeaders(headers),
      body: '{ "type": "email.bounced" }',
      secret,
      nowSeconds: now,
    }),
    { valid: false, reason: "signature_mismatch" }
  );
});

test("a captured signature stops working once it is stale", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const now = 1_700_000_000;
  const { headers, body } = signed('{"type":"email.complained"}', secret, now);

  // Without this, a replayed complaint suppresses any address on demand.
  assert.deepEqual(
    verifySvixSignature({
      headers: readSvixHeaders(headers),
      body,
      secret,
      nowSeconds: now + SVIX_TIMESTAMP_TOLERANCE_SECONDS + 1,
    }),
    { valid: false, reason: "timestamp_out_of_tolerance" }
  );
});

test("rotation is supported: any listed signature may match", () => {
  const oldSecret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const newSecret = "whsec_TXlOZXdTZWNyZXRWYWx1ZUZvclRlc3Rpbmch";
  const now = 1_700_000_000;
  const body = '{"type":"email.delivered"}';
  const id = "msg_rotate";

  const headers = new Headers({
    "svix-id": id,
    "svix-timestamp": String(now),
    "svix-signature": [
      `v1,${svixSignatureFor({ id, timestamp: String(now), body, secret: oldSecret })}`,
      `v1,${svixSignatureFor({ id, timestamp: String(now), body, secret: newSecret })}`,
    ].join(" "),
  });

  for (const secret of [oldSecret, newSecret]) {
    assert.equal(
      verifySvixSignature({
        headers: readSvixHeaders(headers),
        body,
        secret,
        nowSeconds: now,
      }).valid,
      true
    );
  }
});

test("missing pieces are reported as themselves, not as a forgery", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const empty = readSvixHeaders(new Headers());

  assert.deepEqual(verifySvixSignature({ headers: empty, body: "{}", secret }), {
    valid: false,
    reason: "headers_missing",
  });

  const { headers, body } = signed("{}", secret, 1_700_000_000);
  assert.deepEqual(
    verifySvixSignature({
      headers: readSvixHeaders(headers),
      body,
      secret: undefined,
    }),
    { valid: false, reason: "secret_missing" }
  );
});

test("both header prefixes are accepted", () => {
  // Svix sends webhook-* on paid plans and svix-* otherwise. Knowing only one
  // loses every bounce notification the day the sender changes plan.
  const read = readSvixHeaders(
    new Headers({
      "webhook-id": "msg_x",
      "webhook-timestamp": "1700000000",
      "webhook-signature": "v1,abc",
    })
  );
  assert.deepEqual(read, {
    id: "msg_x",
    timestamp: "1700000000",
    signature: "v1,abc",
  });
});
