import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract for the server-issued error report token.
 *
 * What must hold:
 *   - only a configured, sufficiently long secret issues or verifies tokens
 *     (fail-closed, while feedback itself stays up);
 *   - any tampering -- payload bytes, signature bytes, version prefix --
 *     resolves to a verification status, never a throw;
 *   - expiry and future-issuance are rejected;
 *   - optional-field canonicalisation: an absent errorCode and an empty one
 *     are different payloads;
 *   - the payload only ever authenticates server_generated traces.
 */

const SECRET = "an-error-report-secret-of-32-chars!!";

const withSecret = async <T>(
  secret: string | undefined,
  run: () => Promise<T>
): Promise<T> => {
  const previous = process.env.ERROR_REPORT_SIGNING_SECRET;
  if (secret === undefined) delete process.env.ERROR_REPORT_SIGNING_SECRET;
  else process.env.ERROR_REPORT_SIGNING_SECRET = secret;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ERROR_REPORT_SIGNING_SECRET;
    else process.env.ERROR_REPORT_SIGNING_SECRET = previous;
  }
};

const importToken = async () => import("../lib/errorReportToken");

test("issues and verifies a round-trip token", async () => {
  await withSecret(SECRET, async () => {
    const { issueErrorReportToken, verifyErrorReportToken } =
      await importToken();
    const token = issueErrorReportToken({
      traceId: "11111111-2222-4333-8444-555555555555",
      routeClass: "chat",
      errorCode: "AI_PROVIDER_ERROR",
      occurrenceId: "occ-1",
    });
    assert.ok(token, "token should be issued when the secret is configured");
    const outcome = verifyErrorReportToken(token!);
    assert.equal(outcome.status, "verified");
    assert.equal(
      outcome.payload?.traceId,
      "11111111-2222-4333-8444-555555555555"
    );
    assert.equal(outcome.payload?.errorCode, "AI_PROVIDER_ERROR");
    assert.equal(outcome.payload?.occurrenceId, "occ-1");
    assert.equal(outcome.payload?.traceProvenance, "server_generated");
  });
});

test("token without an errorCode verifies, and differs from an empty one", async () => {
  await withSecret(SECRET, async () => {
    const { issueErrorReportToken, verifyErrorReportToken } =
      await importToken();
    const bare = issueErrorReportToken({ traceId: "t-1", routeClass: "chat" });
    assert.ok(bare);
    const outcome = verifyErrorReportToken(bare!);
    assert.equal(outcome.status, "verified");
    assert.equal(outcome.payload?.errorCode, undefined);

    // Absent and empty are different canonical payloads: swapping one
    // payload under the other's signature must fail.
    const empty = issueErrorReportToken({
      traceId: "t-1",
      routeClass: "chat",
      errorCode: "",
    });
    assert.ok(empty);
    const [, barePayload] = bare!.split(".");
    const [, emptyPayload, emptySig] = empty!.split(".");
    assert.notEqual(barePayload, emptyPayload);
    const spliced = `terr1.${barePayload}.${emptySig}`;
    assert.equal(verifyErrorReportToken(spliced).status, "invalid_signature");
  });
});

test("rejects a tampered payload", async () => {
  await withSecret(SECRET, async () => {
    const { issueErrorReportToken, verifyErrorReportToken } =
      await importToken();
    const token = issueErrorReportToken({ traceId: "t-2", routeClass: "chat" })!;
    const [version, payload, signature] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    decoded.traceId = "attacker-chosen-trace";
    const forged = `${version}.${Buffer.from(JSON.stringify(decoded)).toString(
      "base64url"
    )}.${signature}`;
    assert.equal(verifyErrorReportToken(forged).status, "invalid_signature");
  });
});

test("rejects a tampered signature and malformed encodings", async () => {
  await withSecret(SECRET, async () => {
    const { issueErrorReportToken, verifyErrorReportToken } =
      await importToken();
    const token = issueErrorReportToken({ traceId: "t-3", routeClass: "chat" })!;
    // The tamper flips a bit in the decoded signature and re-encodes, rather
    // than overwriting the last characters of the string. Overwriting them was
    // not reliably a tamper at all: the final base64url character of a 32-byte
    // HMAC carries only four meaningful bits, so roughly one signature in a
    // thousand decoded to the same bytes after the edit and verified -- a test
    // that passed almost always and failed for reasons that looked like
    // nothing to do with it.
    const [version, payload, signature] = token.split(".");
    const bytes = Buffer.from(signature, "base64url");
    bytes[0] ^= 0x01;
    assert.equal(
      verifyErrorReportToken(
        `${version}.${payload}.${bytes.toString("base64url")}`
      ).status,
      "invalid_signature"
    );
    assert.equal(verifyErrorReportToken("").status, "invalid_signature");
    assert.equal(verifyErrorReportToken("terr1").status, "invalid_signature");
    assert.equal(
      verifyErrorReportToken("terr1.%%%.%%%").status,
      "invalid_signature"
    );
    assert.equal(
      verifyErrorReportToken(`terr1.${"a".repeat(4_000)}.sig`).status,
      "invalid_signature"
    );
  });
});

test("a re-encoded signature is rejected even when its bytes match", async () => {
  // Base64 is not canonical: the low bits of the last character are padding
  // the decoder discards, so several strings decode to one signature. Without
  // this check a token nobody issued verifies, and the token string stops
  // being unique per grant -- which is the property anything treating a token
  // as one-use depends on.
  await withSecret(SECRET, async () => {
    const { issueErrorReportToken, verifyErrorReportToken } =
      await importToken();
    const token = issueErrorReportToken({ traceId: "t-5", routeClass: "chat" })!;
    const [version, payload, signature] = token.split(".");
    const bytes = Buffer.from(signature, "base64url");

    // Sanity: the honest encoding still verifies.
    assert.equal(verifyErrorReportToken(token).status, "verified");

    // Every alternative spelling of the final character that decodes to the
    // same bytes must be refused.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let checked = 0;
    for (const character of alphabet) {
      const variant = signature.slice(0, -1) + character;
      if (variant === signature) continue;
      if (!Buffer.from(variant, "base64url").equals(bytes)) continue;
      checked += 1;
      assert.equal(
        verifyErrorReportToken(`${version}.${payload}.${variant}`).status,
        "invalid_signature",
        `variant ${character} decoded identically and was accepted`
      );
    }
    assert.ok(checked > 0, "no alternative spelling existed to test");
  });
});

test("rejects an unknown version prefix", async () => {
  await withSecret(SECRET, async () => {
    const { issueErrorReportToken, verifyErrorReportToken } =
      await importToken();
    const token = issueErrorReportToken({ traceId: "t-4", routeClass: "chat" })!;
    const [, payload, signature] = token.split(".");
    assert.equal(
      verifyErrorReportToken(`terr2.${payload}.${signature}`).status,
      "unsupported_version"
    );
  });
});

test("expires after the TTL and rejects future-issued tokens", async () => {
  await withSecret(SECRET, async () => {
    const { issueErrorReportToken, verifyErrorReportToken } =
      await importToken();
    const now = Date.now();
    const token = issueErrorReportToken({
      traceId: "t-5",
      routeClass: "chat",
      now,
    })!;
    const seventyTwoHours = 72 * 60 * 60 * 1000;
    assert.equal(
      verifyErrorReportToken(token, now + seventyTwoHours - 1_000).status,
      "verified",
      "just inside the 72h boundary"
    );
    assert.equal(
      verifyErrorReportToken(token, now + seventyTwoHours + 1_000).status,
      "expired",
      "just past the 72h boundary"
    );
    const futureToken = issueErrorReportToken({
      traceId: "t-5",
      routeClass: "chat",
      now: now + 60 * 60 * 1000,
    })!;
    assert.equal(
      verifyErrorReportToken(futureToken, now).status,
      "expired",
      "a token issued in the future is not valid now"
    );
  });
});

test("fails closed without a secret, and with a short secret", async () => {
  await withSecret(undefined, async () => {
    const {
      issueErrorReportToken,
      verifyErrorReportToken,
      isErrorReportSigningConfigured,
    } = await importToken();
    assert.equal(isErrorReportSigningConfigured(), false);
    assert.equal(
      issueErrorReportToken({ traceId: "t-6", routeClass: "chat" }),
      null
    );
    assert.equal(
      verifyErrorReportToken("terr1.x.y").status,
      "invalid_signature"
    );
  });
  await withSecret("too-short", async () => {
    const { issueErrorReportToken, isErrorReportSigningConfigured } =
      await importToken();
    assert.equal(isErrorReportSigningConfigured(), false);
    assert.equal(
      issueErrorReportToken({ traceId: "t-7", routeClass: "chat" }),
      null
    );
  });
});

test("TTL override is clamped to the safe range", async () => {
  await withSecret(SECRET, async () => {
    const { errorReportTokenTtlMs } = await importToken();
    const hour = 60 * 60 * 1000;
    const previous = process.env.ERROR_REPORT_TOKEN_TTL_HOURS;
    try {
      process.env.ERROR_REPORT_TOKEN_TTL_HOURS = "24";
      assert.equal(errorReportTokenTtlMs(), 24 * hour);
      process.env.ERROR_REPORT_TOKEN_TTL_HOURS = "0";
      assert.equal(errorReportTokenTtlMs(), 72 * hour, "below range → default");
      process.env.ERROR_REPORT_TOKEN_TTL_HOURS = "10000";
      assert.equal(errorReportTokenTtlMs(), 72 * hour, "above range → default");
      process.env.ERROR_REPORT_TOKEN_TTL_HOURS = "not-a-number";
      assert.equal(errorReportTokenTtlMs(), 72 * hour);
    } finally {
      if (previous === undefined) {
        delete process.env.ERROR_REPORT_TOKEN_TTL_HOURS;
      } else {
        process.env.ERROR_REPORT_TOKEN_TTL_HOURS = previous;
      }
    }
  });
});

test("a payload claiming a non-server provenance is rejected even if signed", async () => {
  await withSecret(SECRET, async () => {
    const { createHmac } = await import("node:crypto");
    const { verifyErrorReportToken } = await importToken();
    // Construct a token signed with the real secret but claiming a
    // client_supplied trace: issueErrorReportToken can never produce this,
    // so verification must refuse to bless it.
    const payload = {
      traceProvenance: "client_supplied",
      traceId: "t-8",
      routeClass: "chat",
      release: null,
      environment: null,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString(
      "base64url"
    );
    const signature = createHmac("sha256", SECRET)
      .update(`terr1.${payloadB64}`)
      .digest("base64url");
    assert.equal(
      verifyErrorReportToken(`terr1.${payloadB64}.${signature}`).status,
      "untrusted_trace_source"
    );
  });
});
