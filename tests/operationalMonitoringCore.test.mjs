import assert from "node:assert/strict";
import test from "node:test";
import {
  operationalAlertCooldownMs,
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
