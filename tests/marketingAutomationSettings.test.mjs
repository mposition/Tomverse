import assert from "node:assert/strict";
import test from "node:test";

import { readMarketingAutomationSettingsFrom } from "../lib/appSettings.ts";

const clientReturning = (rows) => ({
  appSetting: {
    findMany: async () => rows,
  },
});

test("marketing automation settings are default-off when the database is disabled", async () => {
  let reads = 0;
  const client = {
    appSetting: {
      findMany: async () => {
        reads += 1;
        return [];
      },
    },
  };

  const settings = await readMarketingAutomationSettingsFrom(client, false);
  assert.equal(reads, 0);
  assert.deepEqual(settings, {
    draftsEnabled: { ok: true, value: false },
    publishEnabled: { ok: true, value: false },
    autoPublishEnabled: { ok: true, value: false },
    experimentsEnabled: { ok: true, value: false },
    webhookShadowEnabled: { ok: true, value: false },
    webhookShadowStoredValue: { ok: true, value: null },
    webhookApplyScopeValue: { ok: true, value: null },
  });
});

test("marketing automation settings enable only the exact stored true value", async () => {
  const settings = await readMarketingAutomationSettingsFrom(
    clientReturning([
      { key: "marketingAutomation.draftsEnabled", value: "true" },
      { key: "marketingAutomation.publishEnabled", value: "TRUE" },
      { key: "marketingAutomation.autoPublishEnabled", value: " true " },
      { key: "marketingAutomation.experimentsEnabled", value: "false" },
      { key: "marketingAutomation.webhookShadowEnabled", value: "true" },
      {
        key: "marketingAutomation.webhookApplyScope",
        value: '{"recordId":"2026-09-18__zernio-published","scope":[]}',
      },
    ]),
    true,
  );

  assert.deepEqual(settings, {
    draftsEnabled: { ok: true, value: true },
    publishEnabled: { ok: true, value: false },
    autoPublishEnabled: { ok: true, value: false },
    experimentsEnabled: { ok: true, value: false },
    webhookShadowEnabled: { ok: true, value: true },
    webhookShadowStoredValue: { ok: true, value: "true" },
    webhookApplyScopeValue: {
      ok: true,
      value: '{"recordId":"2026-09-18__zernio-published","scope":[]}',
    },
  });
});

test("a failed combined settings read marks every derived input unreadable", async () => {
  const settings = await readMarketingAutomationSettingsFrom(
    {
      appSetting: {
        findMany: async () => {
          throw new Error("database unavailable");
        },
      },
    },
    true,
  );

  assert.deepEqual(settings, {
    draftsEnabled: { ok: false },
    publishEnabled: { ok: false },
    autoPublishEnabled: { ok: false },
    experimentsEnabled: { ok: false },
    webhookShadowEnabled: { ok: false },
    webhookShadowStoredValue: { ok: false },
    webhookApplyScopeValue: { ok: false },
  });
});
