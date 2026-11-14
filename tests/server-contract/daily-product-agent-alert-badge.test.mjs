import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const rows = [
  { id: "halt-1", title: "Daily product agent stopped", status: "sent", channel: "in_app", targetType: "DailyProductAgentRun", acknowledgedAt: null },
  { status: "failed", channel: "email", targetType: null, acknowledgedAt: null },
  { status: "sent", channel: "in_app", targetType: "AmuxIdeaRetentionHold", acknowledgedAt: null },
  { status: "sent", channel: "in_app", targetType: "DailyProductAgentRun", acknowledgedAt: "already-read" },
];
const matches = (row, where) => Object.entries(where).every(([key, value]) =>
  key === "OR" ? value.some(branch => matches(row, branch)) : row[key] === value);
const prisma = new Proxy({}, { get: (_, table) => ({
  count: async ({ where }) => table === "adminNotificationLog" ? rows.filter(row => matches(row, where)).length : 0,
  update: async ({ where, data }) => Object.assign(rows.find(row => row.id === where.id), data),
}) });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma } });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "owner", email: "owner@example.test" } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => true, hasAdminPermission: () => true } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: { writeAdminAuditLog: async () => "audit-1" } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null,
  readLimitedJson: async (request, _limit, schema) => schema.parse(await request.json()),
} });
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
const { PATCH } = await import(mod("app/api/admin/notifications/[notificationId]/route.ts"));
test("the notification bell counts an unread agent halt even though its in-app notice was delivered", async () => {
  assert.equal((await getAdminNavigationCounts()).counts.failedAlerts, 2);
  const response = await PATCH(new Request("https://app.example.test/api/admin/notifications/halt-1", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "acknowledge" }),
  }), { params: Promise.resolve({ notificationId: "halt-1" }) });
  assert.equal(response.status, 200);
  assert.ok(rows[0].acknowledgedAt);
  assert.equal(rows[0].status, "sent");
  assert.equal((await getAdminNavigationCounts()).counts.failedAlerts, 1);
});
