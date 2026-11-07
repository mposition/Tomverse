import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminInfrastructureView } from "@/components/admin/AdminInfrastructurePanel";
import type { InfrastructureDashboard } from "@/lib/infrastructureTypes";

/**
 * Infrastructure, rendered. The view is hook-free apart from the message
 * context, so it is called with a read (or a failed read) and its markup is
 * checked: tones, the unread card, and who sees the credit form.
 */

const dashboard = (over: Partial<InfrastructureDashboard> = {}): InfrastructureDashboard => ({
  generatedAt: "2026-11-07T03:42:05.000Z",
  railway: {
    status: "healthy",
    message: "Usage is inside the credit.",
    tokenConfigured: true,
    scope: "workspace",
    projectedMonthCostMicroUsd: 12_340_000,
    configuredCreditMicroUsd: 20_000_000,
    projectedBalanceMicroUsd: 7_660_000,
    creditNote: null,
    warningReasons: [],
    measurements: [
      { measurement: "cpu_usage", estimatedValue: 1.5, unit: "vCPU-h", estimatedCostMicroUsd: 3_000_000, projectId: null },
    ],
    apiRateLimit: { limit: 100, remaining: 90, resetAt: null },
    checkedAt: "2026-11-07T03:42:00.000Z",
  },
  r2: {
    status: "warning",
    message: "Class B is above 70 percent.",
    warningReasons: [{ code: "R2_CLASS_B_HIGH", detail: "Reads are close to the free tier." }],
    bucketName: "tomverse-files",
    objectCredentialsConfigured: true,
    analyticsTokenConfigured: true,
    storageBytes: 41_231_686_041,
    metadataBytes: 0,
    objectCount: 1200,
    pendingUploads: 3,
    classAOperations: 1000,
    classBOperations: 8_000_000,
    unclassifiedOperations: 0,
    storageAllowancePercent: 40,
    classAAllowancePercent: 1,
    classBAllowancePercent: 80,
    checkedAt: "2026-11-07T03:42:00.000Z",
  },
  database: {
    status: "healthy",
    message: "Inside its limits.",
    activeSessions: 12,
    conversations: 340,
    messages: 5200,
    usageBuckets: 80,
    providerErrors24h: 2,
    providerErrorsPendingCleanup: 5,
    providerErrorsOverdueCleanup: 0,
    checkedAt: "2026-11-07T03:42:00.000Z",
  },
  prismaUsage: {
    status: "unconfigured",
    message: "No management token.",
    tokenConfigured: false,
    databaseIdConfigured: false,
    operationsUsed: null,
    operationsLimit: 1_000_000,
    operationsAllowancePercent: null,
    storageGiB: null,
    periodStart: null,
    periodEnd: null,
    checkedAt: "2026-11-07T03:42:00.000Z",
  },
  ...over,
});

const render = (over: Partial<Parameters<typeof AdminInfrastructureView>[0]> = {}) =>
  renderToStaticMarkup(
    <AdminInfrastructureView
      data={dashboard()}
      loading={false}
      error={null}
      saving={false}
      canManageCosts={false}
      creditUsd=""
      creditNote=""
      creditValid={false}
      onCreditUsd={() => {}}
      onCreditNote={() => {}}
      onRefresh={() => {}}
      onSaveCredit={() => {}}
      {...over}
    />
  );

test("four service cards lead the page, each with its own status chip", () => {
  const html = render();
  for (const id of ["railway", "r2", "database", "prisma"]) {
    assert.match(html, new RegExp(`data-testid="infra-card-${id}"`));
  }
  assert.match(html, /data-tone="ok"/);
  assert.match(html, /data-tone="warn"/);
  // Not set up is dashed, never drawn as healthy.
  assert.match(html, /data-tone="unknown"[^>]*>Not set up</);
  assert.match(html, /\$12\.34/);
  assert.match(html, /38\.40 GB/);
});

test("a number nobody could read says Unavailable, not zero or a dash", () => {
  const html = render();
  const prismaCard = html.slice(html.indexOf('data-testid="infra-card-prisma"'));
  assert.match(prismaCard.slice(0, 2000), />Unavailable</);
});

test("the checked time is shown in AEST, never UTC", () => {
  const html = render();
  assert.match(html, /Checked 2026-11-07 13:42 AEST/);
  assert.doesNotMatch(html, /UTC|GMT/);
});

test("a failed read is an alert with a retry, and shows no cards", () => {
  const html = render({ data: null, error: "Could not load the infrastructure numbers." });
  assert.match(html, /role="alert"/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /infra-card-/);
});

test("the credit form is for roles that can manage costs only", () => {
  assert.doesNotMatch(render({ canManageCosts: false }), /Save credit/);
  const html = render({ canManageCosts: true, creditUsd: "20.00", creditValid: true });
  assert.match(html, /Save credit/);
  assert.match(html, /value="20\.00"/);
});

test("a disabled Railway monitor explains itself and is idle, not red", () => {
  const base = dashboard();
  const html = render({
    data: dashboard({
      railway: { ...base.railway, status: "disabled", projectedMonthCostMicroUsd: null },
    }),
  });
  assert.match(html, /data-testid="railway-usage-monitor-disabled"/);
  assert.match(html, /RAILWAY_USAGE_MONITOR_ENABLED=false/);
  assert.match(html, /data-tone="idle"[^>]*>Off</);
});

test("warning reasons are written out, and tokens stay behind Technical details", () => {
  const html = render();
  assert.match(html, /Reads are close to the free tier\./);
  assert.match(html, /<details[^>]*>[\s\S]*Technical details/);
});
