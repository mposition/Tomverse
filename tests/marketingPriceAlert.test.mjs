import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MARKETING_PRICE_ALERT_INCIDENT_CODE, reportMarketingPriceSourceRefusal } from "@/lib/marketingPriceAlert";
import {
  MARKETING_PRICE_ALERT_RECIPIENT_ENVS,
  MARKETING_PRICE_SOURCE_REFUSAL_CODE,
  marketingPriceAlertReady,
  marketingPriceAlertReadyInput,
} from "@/lib/marketingPriceAlertCore";

test("the alert is ready exactly when the operational alert has a recipient", () => {
  assert.equal(marketingPriceAlertReady({}), false);
  assert.equal(marketingPriceAlertReady({ OPS_ALERT_EMAIL: "  " }), false);
  assert.equal(marketingPriceAlertReady({ OPS_ALERT_EMAIL: "ops@example.invalid" }), true);
  assert.equal(marketingPriceAlertReady({ ADMIN_ALERT_EMAIL: "admin@example.invalid" }), true);
  // The operational alert picks a set OPS_ALERT_EMAIL before trimming it, so a
  // blank one means no recipient, whatever ADMIN_ALERT_EMAIL says.
  assert.equal(
    marketingPriceAlertReady({ OPS_ALERT_EMAIL: "  ", ADMIN_ALERT_EMAIL: "admin@example.invalid" }),
    false,
  );
  assert.equal(marketingPriceAlertReady({ OPS_ALERT_EMAIL: "", ADMIN_ALERT_EMAIL: "admin@example.invalid" }), true);
  assert.deepEqual(marketingPriceAlertReadyInput({}), { ok: true, value: false });
});

test("the recipient variables are the operational alert's own, in its order", () => {
  // lib/operationalMonitoring.ts reads them privately; this keeps the two from parting.
  const source = readFileSync("lib/operationalMonitoring.ts", "utf8");
  const read = source.match(/process\.env\.(\w+) \|\| process\.env\.(\w+)\)\?\.trim\(\)/u);
  assert.ok(read, "the operational alert's recipient expression moved");
  assert.deepEqual([read[1], read[2]], [...MARKETING_PRICE_ALERT_RECIPIENT_ENVS]);
});

test("the code the alert answers is one the Guard actually emits", () => {
  assert.match(readFileSync("lib/marketingGuardCore.ts", "utf8"), new RegExp(`"${MARKETING_PRICE_SOURCE_REFUSAL_CODE}"`));
});

test("a refusal is reported as an operational incident carrying a link and an id, no words", async () => {
  const reported = [];
  await reportMarketingPriceSourceRefusal(
    { postId: "post_123" },
    { report: async (incident) => reported.push(incident), env: { PUBLIC_APP_URL: "https://staging.tomverse.app/" } },
  );
  assert.equal(reported.length, 1);
  assert.equal(reported[0].code, MARKETING_PRICE_ALERT_INCIDENT_CODE);
  assert.equal(reported[0].severity, "warning");
  assert.equal(reported[0].forceNotification, true, "each refusal reaches the operator, cooldown or not");
  assert.deepEqual(reported[0].context, {
    component: "marketing-guard",
    postId: "post_123",
    admin: "https://staging.tomverse.app/admin/marketing",
  });
  assert.equal("error" in reported[0], false);
});

test("two refusals in a row both reach the real reporter's notification step", async () => {
  // The cooldown gate in lib/operationalMonitoring.ts is skipped only by
  // forceNotification; the source is read so the two cannot part silently.
  const source = readFileSync("lib/operationalMonitoring.ts", "utf8");
  assert.ok(
    source.includes("if (!forceNotification && Date.now() - lastNotifiedAt < cooldownMs)"),
    "the operational alert's cooldown gate moved",
  );
  const reported = [];
  for (const postId of ["post_a", "post_b"]) {
    await reportMarketingPriceSourceRefusal({ postId }, { report: async (incident) => reported.push(incident), env: {} });
  }
  assert.deepEqual(reported.map((incident) => [incident.context.postId, incident.forceNotification]), [
    ["post_a", true],
    ["post_b", true],
  ]);
});

test("a failed alert is logged, never thrown into the intake", async () => {
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    await reportMarketingPriceSourceRefusal(
      { postId: "post_123" },
      {
        report: async () => {
          throw new Error("smtp down");
        },
        env: {},
      },
    );
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /marketing_price_alert_failed/);
  assert.equal(errors[0].includes("smtp down"), false);
});
