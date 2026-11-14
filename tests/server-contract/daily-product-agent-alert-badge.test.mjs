import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const rows = [
  { status: "sent", channel: "in_app", targetType: "DailyProductAgentRun", acknowledgedAt: null },
  { status: "failed", channel: "email", targetType: null, acknowledgedAt: null },
  { status: "sent", channel: "in_app", targetType: "AmuxIdeaRetentionHold", acknowledgedAt: null },
  { status: "sent", channel: "in_app", targetType: "DailyProductAgentRun", acknowledgedAt: "already-read" },
];
const matches = (row, where) => Object.entries(where).every(([key, value]) =>
  key === "OR" ? value.some(branch => matches(row, branch)) : row[key] === value);
const prisma = new Proxy({}, { get: (_, table) => ({ count: async ({ where }) =>
  table === "adminNotificationLog" ? rows.filter(row => matches(row, where)).length : 0 }) });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma } });
for (const [path, name] of [
  ["lib/adminEmailDeliveries.ts", "abandonedLegalEmailCount"],
  ["lib/modelLifecycleWorkItems.ts", "countOpenWorkItemFamilies"],
  ["lib/adminEmailCampaigns.ts", "overdueCampaignWaveCount"],
  ["lib/amux/orchestratorHaltStore.ts", "countOpenAmuxOrchestratorHalts"],
  ["lib/amux/decisionMakerAttention.ts", "countDecisionMakerAttention"],
  ["lib/amux/adminOwnerQueueRead.ts", "countAmuxOwnerQueue"],
]) mock.module(mod(path), { namedExports: { [name]: async () => 0 } });
mock.module(mod("lib/scheduledJobs.ts"), { namedExports: { getScheduledJobsDashboard: async () => [] } });
const { getAdminNavigationCounts } = await import(mod("lib/adminNavigationCounts.ts"));
test("the notification bell counts an unread agent halt even though its in-app notice was delivered", async () => {
  assert.equal((await getAdminNavigationCounts()).counts.failedAlerts, 2);
  rows[0].acknowledgedAt = "read";
  assert.equal((await getAdminNavigationCounts()).counts.failedAlerts, 1);
});
