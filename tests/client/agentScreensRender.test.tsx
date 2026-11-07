import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AdminBillingFinanceOpsDigestsPanel } from "@/components/admin/AdminBillingFinanceOpsDigestsPanel";
import { AdminEngineeringOverview } from "@/components/admin/AdminEngineeringOverview";
import { AdminSreDaily, AdminSreOverviewSummary, AdminSreSettings } from "@/components/admin/AdminSreAgentScreens";
import { summarizeSreDigest } from "@/lib/adminSreDailyCore";
import type { AgentOfficeEngineeringState } from "@/lib/agentOffice/live";
import type { BillingFinanceOpsConsole } from "@/lib/billingFinanceOpsConsoleRead";
import type { EngineeringOverviewBody } from "@/lib/engineeringAgentOverviewRead";
import type { OpsObserverDigestView } from "@/lib/opsObserverDigest";
import type { OpsObserverAdminView } from "@/lib/opsObserverStore";

const router = {
  back: () => {}, forward: () => {}, refresh: () => {}, push: () => {},
  replace: () => {}, prefetch: () => {}, bfcacheId: "agent-screens-fixture",
} as unknown as AppRouterInstance;
const withRouter = (node: React.ReactNode) =>
  renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);

// --- Engineering -----------------------------------------------------------

const head: AgentOfficeEngineeringState = {
  kind: "observed",
  mode: "t1",
  frozen: false,
  killSwitch: false,
  halt: "none",
  pending: { t2Draft: 1, decision: 0, stateMismatch: 0 },
  activeRuns: 1,
  activeSince: "2026-11-07T01:00:00.000Z",
  lastRun: null,
  runnerLastFinishAt: null,
  publisherLastFinishAt: null,
};

const body: EngineeringOverviewBody = {
  openPrs: 2,
  pullRequests: [
    { prNumber: 3421, runId: "run-1", state: "open", approved: true, merged: null, createdAt: "2026-11-07T01:00:00.000Z" },
    { prNumber: 3419, runId: "run-2", state: "open", approved: false, merged: null, createdAt: "2026-11-06T01:00:00.000Z" },
    { prNumber: 3412, runId: "run-3", state: "open", approved: true, merged: true, createdAt: "2026-11-05T01:00:00.000Z" },
  ],
  rejectedDrafts30d: 0,
  minutesToPr: [12, 30, 18],
};

test("the engineering overview highlights only what waits for a person's check, and merging stays theirs", () => {
  const html = renderToStaticMarkup(<AdminEngineeringOverview head={head} body={body} />);
  assert.match(html, /data-testid="engineering-overview"/);
  // Exactly one row is the "check before merging" one, and it links to the record, not to a merge.
  assert.equal(html.match(/data-kind="ready"/g)?.length, 1);
  assert.equal(html.match(/data-kind="merged"/g)?.length, 1);
  assert.match(html, /Check before merging/);
  assert.match(html, /1 only wait for a person to check and merge\./);
  assert.doesNotMatch(html, /<button/i);
  // The times are minutes drawn as bars, with the latest named.
  assert.match(html, /Latest: 18 min/);
  assert.match(html, /<svg[^>]*role="img"/);
  // AEST, never UTC.
  assert.match(html, /AEST/);
  assert.doesNotMatch(html, /\bUTC\b/);
});

test("an engineering part that could not be read says so and is never a zero or an empty list", () => {
  const html = renderToStaticMarkup(
    <AdminEngineeringOverview
      head={{ kind: "unread" }}
      body={{ openPrs: null, pullRequests: null, rejectedDrafts30d: null, minutesToPr: null }}
    />,
  );
  assert.equal(html.match(/data-unread="true"/g)?.length, 4);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /The agent has not opened a pull request/);
});

test("a run history with no pull request draws no chart tile", () => {
  const html = renderToStaticMarkup(
    <AdminEngineeringOverview head={head} body={{ ...body, minutesToPr: [], pullRequests: [] }} />,
  );
  assert.doesNotMatch(html, /Time from a run/);
  assert.match(html, /has not opened a pull request that is still current/);
});

// --- SRE -------------------------------------------------------------------

const view = (payload: OpsObserverDigestView["payload"], id: string): OpsObserverDigestView => ({
  id,
  createdAt: "2026-11-07T21:00:00.000Z",
  countsComplete: true,
  payload,
});

const quietDay = view(
  { ownerDate: "2026-11-07", mode: "shadow", readiness: { db: true }, items: [], counts: [], channelCheckTaken: true },
  "11111111-1111-4111-8111-111111111111",
);
const busyDay = view(
  {
    ownerDate: "2026-11-06",
    mode: "shadow",
    readiness: { db: false },
    items: [{ key: "provider_down", kind: "new_open", capped: false, mode: "shadow", status: "shadowed" }],
    counts: [{ mode: "shadow", status: "shadowed", kind: "new_open", count: 1 }],
    channelCheckTaken: false,
  },
  "22222222-2222-4222-8222-222222222222",
);
const goneDay = view(null, "33333333-3333-4333-8333-333333333333");
const summaries = [quietDay, busyDay, goneDay].map(summarizeSreDigest);

test("with no report open the SRE tab lists the recent days, and a day without a body is not called quiet", () => {
  const html = renderToStaticMarkup(
    <AdminSreDaily summaries={summaries} selected={null} requestedId={null} limit={14} />,
  );
  assert.match(html, /data-testid="sre-daily-list"/);
  assert.match(html, /href="\/admin\/sre-ops\?tab=daily&amp;item=11111111-1111-4111-8111-111111111111"/);
  assert.match(html, /2026-11-07/);
  assert.match(html, /Body removed/);
  assert.equal(html.match(/data-tone="ok"/g)?.length, 1); // the quiet day
  assert.equal(html.match(/data-tone="unknown"/g)?.length, 1); // the day without a body is not quiet
  assert.doesNotMatch(html, /data-testid="sre-daily-report"/);
});

test("an open SRE report reads in plain words and keeps its keys closed", () => {
  const html = renderToStaticMarkup(
    <AdminSreDaily summaries={summaries} selected={busyDay} requestedId={busyDay.id} limit={14} />,
  );
  assert.match(html, /data-testid="sre-daily-report"/);
  assert.match(html, /There was something to look at/);
  assert.match(html, /A readiness check was failing/);
  assert.match(html, /In shadow mode these were recorded, not sent\./);
  // The raw key is inside the closed technical details.
  assert.match(html, /<details[^>]*>(?:(?!<\/details>)[\s\S])*provider_down/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});

test("a quiet SRE report says so, and an unknown report id is not drawn as a report", () => {
  const quiet = renderToStaticMarkup(
    <AdminSreDaily summaries={summaries} selected={quietDay} requestedId={quietDay.id} limit={14} />,
  );
  assert.match(quiet, /A quiet day/);
  const missing = renderToStaticMarkup(
    <AdminSreDaily summaries={summaries} selected={null} requestedId="44444444-4444-4444-8444-444444444444" limit={14} />,
  );
  assert.match(missing, /That report is not in the list/);
  assert.doesNotMatch(missing, /data-testid="sre-daily-report"/);
});

test("an SRE list that could not be read is an alert, not an empty list", () => {
  const html = renderToStaticMarkup(<AdminSreDaily summaries={null} selected={null} requestedId={null} limit={14} />);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /No daily report has been kept yet/);
});

const chain: OpsObserverAdminView = {
  head: { genesisId: "genesis-1", generation: 3, mode: "shadow", createdAt: "2026-11-01T00:00:00.000Z" },
  trustReason: "trusted",
  nextGenesisAt: "2026-11-08T00:00:00.000Z",
  genesisAllowedNow: true,
};

test("the SRE overview numbers are unavailable when their reads failed, not zero", () => {
  const html = renderToStaticMarkup(<AdminSreOverviewSummary view={null} summaries={null} />);
  assert.equal(html.match(/data-unread="true"/g)?.length, 4);
  const ok = renderToStaticMarkup(<AdminSreOverviewSummary view={chain} summaries={summaries} />);
  assert.match(ok, /Trusted/);
  assert.match(ok, /Shadow/);
  assert.match(ok, /For 2026-11-07/);
});

test("the SRE settings explain the mode, keep the ids closed and point at the genesis on Overview", () => {
  const html = renderToStaticMarkup(<AdminSreSettings view={chain} />);
  assert.match(html, /data-active="true"/);
  assert.match(html, /records the alerts it would have sent|writes down the alerts it would have sent/);
  assert.match(html, /href="\/admin\/sre-ops\?tab=overview"/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(renderToStaticMarkup(<AdminSreSettings view={null} />), /role="alert"/);
});

// --- Billing and finance ----------------------------------------------------

const finance: BillingFinanceOpsConsole = {
  limit: 14,
  canWrite: false,
  control: { state: "enabled", revision: 2, enabledAt: "2026-11-01T01:00:00.000Z" },
  monitorConfirmedAt: "2026-11-02T01:00:00.000Z",
  digests: [
    {
      id: "b",
      createdAt: "2026-11-07T01:00:00.000Z",
      sizeBytes: 400,
      body: "present",
      digest: {
        environment: "production",
        computedAtDate: "2026-11-07",
        verdict: "notice",
        items: [{ modelId: "model-a", registeredAt: "2026-10-01", expiresAt: "2026-11-12", remainingDays: 5, mark: "7" }],
        rejectedFields: [],
      },
    },
    { id: "a", createdAt: "2026-11-06T01:00:00.000Z", sizeBytes: 0, body: "expired", digest: null },
  ],
};

test("the finance overview draws figures from the digest and an expired body as an unknown day", () => {
  const html = renderToStaticMarkup(<AdminBillingFinanceOpsDigestsPanel initial={finance} section="overview" />);
  assert.match(html, /data-testid="finance-overview"/);
  assert.match(html, /5 days/);
  assert.match(html, /model-a/);
  assert.match(html, /data-tone="warn"/);
  assert.match(html, /data-tone="unknown"/);
  assert.match(html, /Observe only/);
  assert.doesNotMatch(html, /<button/i);
});

test("finance figures are unavailable when no digest body can give them", () => {
  const html = renderToStaticMarkup(
    <AdminBillingFinanceOpsDigestsPanel
      initial={{ ...finance, digests: [finance.digests[1]] }}
      section="overview"
    />,
  );
  assert.equal(html.match(/data-unread="true"/g)?.length, 4);
});

test("an unreadable finance switch is shown as unavailable on Overview and Settings, never as off", () => {
  const unreadable = { ...finance, control: { state: "unreadable" as const, revision: null, enabledAt: null } };
  for (const section of ["overview", "settings"] as const) {
    const html = renderToStaticMarkup(<AdminBillingFinanceOpsDigestsPanel initial={unreadable} section={section} />);
    assert.match(html, /data-tone="unknown"/);
    assert.doesNotMatch(html, />Off</);
  }
});

test("the finance report lists the digests with the latest open and an expired body marked as removed", () => {
  const html = renderToStaticMarkup(<AdminBillingFinanceOpsDigestsPanel initial={finance} section="report" />);
  assert.match(html, /data-testid="billing-finance-ops-digest-list"/);
  assert.equal(html.match(/data-testid="billing-finance-ops-digest"/g)?.length, 2);
  assert.equal(html.match(/<details open=""/g)?.length, 1);
  assert.match(html, /model-a/);
  assert.match(html, /removed after its retention period/);
});

test("the finance settings offer the two writes only to a writer, and keep the ids closed", () => {
  const reader = renderToStaticMarkup(<AdminBillingFinanceOpsDigestsPanel initial={finance} section="settings" />);
  assert.doesNotMatch(reader, /billing-finance-ops-turn-off/);
  assert.match(reader, /data-testid="billing-finance-ops-switch"/);
  assert.doesNotMatch(reader, /<details[^>]*open/);
  const writer = withRouter(
    <AdminBillingFinanceOpsDigestsPanel initial={{ ...finance, canWrite: true }} section="settings" />,
  );
  assert.match(writer, /billing-finance-ops-turn-off/);
  assert.match(writer, /billing-finance-ops-record-monitors/);
});
