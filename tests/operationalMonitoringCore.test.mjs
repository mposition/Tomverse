import assert from "node:assert/strict";
import test from "node:test";
import {
  operationalAlertCooldownMs,
  redactReportableRequestHeaders,
  sanitizeOperationalContext,
  sanitizeOperationalText,
} from "../lib/operationalMonitoringCore.ts";

test("operational logs redact credentials and bearer tokens", () => {
  const value = sanitizeOperationalText(
    "connect postgresql://tommy:super-secret@db.internal:5432/tomverse Bearer abc.def"
  );
  assert.equal(value.includes("super-secret"), false);
  assert.equal(value.includes("abc.def"), false);
  assert.match(value, /DATABASE_URL_REDACTED/);
});

test("operational context redacts secret-shaped keys", () => {
  assert.deepEqual(
    sanitizeOperationalContext({
      route: "/api/ready",
      databaseUrl: "postgresql://private",
      apiToken: "private",
      durationMs: 120,
    }),
    {
      route: "/api/ready",
      databaseUrl: "[REDACTED]",
      apiToken: "[REDACTED]",
      durationMs: 120,
    }
  );
});

test("operational alert cooldown is bounded", () => {
  assert.equal(operationalAlertCooldownMs(undefined), 600_000);
  assert.equal(operationalAlertCooldownMs("1"), 60_000);
  assert.equal(operationalAlertCooldownMs("999999"), 86_400_000);
});

test("request header reporting redacts the Cloudflare origin secret", () => {
  // The header that produced this test: `x-tomverse-origin-verify` carries
  // CLOUDFLARE_ORIGIN_SECRET and matched none of the patterns the previous
  // denylist tested for, so it reached Sentry in plaintext.
  const redacted = redactReportableRequestHeaders({
    "X-Tomverse-Origin-Verify": "origin-secret-value",
    "Cf-Ray": "a2b6c70a0d9dd717-BNE",
    "User-Agent": "Mozilla/5.0",
  });
  assert.equal(redacted["X-Tomverse-Origin-Verify"], "[REDACTED]");
  assert.equal(redacted["Cf-Ray"], "a2b6c70a0d9dd717-BNE");
  assert.equal(redacted["User-Agent"], "Mozilla/5.0");
});

test("request header reporting redacts anything it was not told to keep", () => {
  const redacted = redactReportableRequestHeaders({
    "x-internal-service-key": "value",
    "x-some-header-invented-tomorrow": "value",
    authorization: "Bearer abc",
    cookie: "session=abc",
    // A magic-link sign-in puts its login token in the URL, and the next
    // request from that page reports it here.
    referer: "https://tomverse.app/auth/verify?token=abc",
  });
  for (const value of Object.values(redacted)) {
    assert.equal(value, "[REDACTED]");
  }
});

test("request header reporting keeps header names and tolerates no headers", () => {
  const redacted = redactReportableRequestHeaders({ "x-secret": "value" });
  assert.deepEqual(Object.keys(redacted), ["x-secret"]);
  assert.equal(redactReportableRequestHeaders(undefined), undefined);
});
