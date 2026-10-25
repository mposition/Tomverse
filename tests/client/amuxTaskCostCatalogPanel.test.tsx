import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AdminLocaleProvider } from "@/components/admin/AdminLocaleProvider";
import { AmuxTaskCostCatalogApprovalPanel,
  type AmuxTaskCatalogCurrentView } from "@/components/admin/AmuxTaskCostCatalogApprovalPanel";
import { AMUX_TASK_CATALOG_DEFAULT_CAPS } from "@/lib/amux/v4TaskCostCatalogDraftCore";

const ssrRouter: AppRouterInstance = {
  back: () => {}, forward: () => {}, refresh: () => {}, push: () => {},
  replace: () => {}, prefetch: () => {}, bfcacheId: "task-catalog-ssr-fixture",
};
const render = (current: AmuxTaskCatalogCurrentView | null, locale: "ko" | "en" = "ko",
  approvalAvailable = true) => renderToStaticMarkup(
  <AppRouterContext.Provider value={ssrRouter}>
    <AdminLocaleProvider locale={locale}>
      <AmuxTaskCostCatalogApprovalPanel current={current} approvalAvailable={approvalAvailable}
        initialCaps={AMUX_TASK_CATALOG_DEFAULT_CAPS} />
    </AdminLocaleProvider>
  </AppRouterContext.Provider>);

test("with no catalog the owner is told Tasks cannot register, and no JSON is asked for", () => {
  const html = render({ status: "none" });
  assert.match(html, /아직 승인 없음/);
  assert.match(html, /비용표가 승인되기 전에는 어떤 Task도 등록되지 않습니다/);
  assert.doesNotMatch(html, /<textarea/, "the owner never types a catalog");
  assert.match(html, /data-testid="amux-task-cost-catalog-cap-frontier-outputTokens"[^>]*value="128000"/);
  assert.match(html, /data-testid="amux-task-cost-catalog-approve"[^>]*disabled=""/,
    "approval waits for a calculated draft");
});

test("an approved catalog shows its version, AEST times and priced workers", () => {
  const html = render({ status: "approved", version: 3, catalogVersion: "auto-20261025T010203Z",
    approvedAt: "2026-10-25T01:02:03.000Z", pricesExpireAt: "2027-01-23T01:02:03.000Z",
    routes: [{ workerName: "claude-impl", modelId: "claude-sonnet-5", grade: "advanced",
      inputUsdPerMillion: 3, outputUsdPerMillion: 15 }] }, "en");
  assert.match(html, />Approved</);
  assert.match(html, /Version 3 · approved 25\/10\/2026, 11:02 am AEST/);
  assert.match(html, /prices valid until 23\/01\/2027, 11:02 am AEST/);
  assert.match(html, /claude-impl[^]*claude-sonnet-5[^]*Advanced[^]*\$3\.00[^]*\$15\.00/);
});

test("an unreadable catalog and a switched-off server say so", () => {
  const html = render(null, "ko", false);
  assert.match(html, /읽을 수 없음/);
  assert.match(html, /이 서버에서는 비용표 승인이 꺼져 있습니다/);
});
