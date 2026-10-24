import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const mod = (name: string) => pathToFileURL(resolve(import.meta.dirname, "../..", name)).href;
let stored: string | null = null;
let auditFails = false;
let auditCount = 0;
let activeTransaction: unknown;
mock.module(mod("lib/e2eTestMode.ts"), { namedExports: { isE2EDatabaseDisabled: () => false } });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { getRuntimeModels: async () => [] } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  appSetting: { findUnique: async () => stored === null ? null : { value: stored } },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    let next = stored;
    activeTransaction = { appSetting: { upsert: async (input: { update: { value: string } }) => { next = input.update.value; } } };
    await run(activeTransaction);
    stored = next;
  },
} } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: { writeAdminAuditLog: async (entry: { tx: unknown; action: string }) => {
  assert.equal(entry.tx, activeTransaction);
  assert.equal(entry.action, "app_settings.review_defaults.update_completed");
  if (auditFails) throw new Error("audit unavailable");
  auditCount++;
} } });

const load = () => import(mod("lib/reviewProviderDefaults.ts"));
const session = { user: { id: "admin_1" }, expires: "2099-01-01" };
const request = new Request("http://localhost/api/admin/app-settings");
test.beforeEach(() => { stored = null; auditFails = false; auditCount = 0; });

test("missing or malformed platform defaults retain the existing OpenAI start", async () => {
  const { getPlatformReviewProviderDefaults } = await load();
  assert.deepEqual(await getPlatformReviewProviderDefaults(), ["openai"]);
  stored = "not-json";
  assert.deepEqual(await getPlatformReviewProviderDefaults(), ["openai"]);
});

test("platform providers and their audit entry commit in the same transaction", async () => {
  const { getPlatformReviewProviderDefaults, updatePlatformReviewProviderDefaults } = await load();
  await updatePlatformReviewProviderDefaults(["google", "openai"], session, request);
  assert.deepEqual(await getPlatformReviewProviderDefaults(), ["google", "openai"]);
  assert.equal(auditCount, 1);
});

test("an audit failure rolls back the platform selection", async () => {
  const { updatePlatformReviewProviderDefaults } = await load();
  stored = '["openai"]'; auditFails = true;
  await assert.rejects(() => updatePlatformReviewProviderDefaults(["google"], session, request), /audit unavailable/);
  assert.equal(stored, '["openai"]');
});
