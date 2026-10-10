import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import React from "react";

const root = resolve(import.meta.dirname, "../..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const priorReact = globalThis.React;
globalThis.React = React;
let session;
let messageReads;
class Redirect extends Error {
  constructor(destination) { super(destination); this.destination = destination; }
}
mock.module("next/navigation", { namedExports: {
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (destination) => { throw new Redirect(destination); },
} });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => session } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { getAdminRole: (value) => value.user.role } });
mock.module(mod("lib/adminLocaleServer.ts"), { namedExports: {
  getAdminMessages: async (messages) => { messageReads++; return messages.en; },
} });
mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), { namedExports: {
  AMUX_V4_TASK_CATALOG_WRITE_ENV: "TOMVERSE_AMUX_V4_TASK_CATALOG_WRITE",
  amuxV4TaskCatalogWriteEnabled: () => false,
} });
mock.module(mod("lib/amux/portfolioAssessmentService.ts"), { namedExports: {
  AMUX_V4_PORTFOLIO_WRITE_ENV: "TOMVERSE_AMUX_V4_PORTFOLIO_WRITE",
  amuxV4PortfolioWriteEnabled: () => false,
} });
const panels = {};
for (const name of ["AdminPageTabs", "AmuxBacklogMetadataPanel", "AmuxBoardImportPanel",
  "AmuxIdeaInputPanel", "AmuxUnusedAnalysisReservationPanel", "AmuxAnalysisClaimResolutionPanel",
  "AmuxTaskCostCatalogApprovalPanel", "AmuxPortfolioPanel", "AmuxReconciliationPanel"]) {
  const panel = () => null;
  panels[name] = panel;
  mock.module(mod(`components/admin/${name}.tsx`), { namedExports: { [name]: panel } });
}
const { default: open } = await import(mod("app/(site)/(application)/admin/amux-backlog/page.tsx"));
const { ADMIN_LEGACY_ROUTES, adminRedirectTarget } = await import(mod("lib/adminNavigation.ts"));
test.beforeEach(() => {
  session = { user: { id: "owner-a", role: "owner" } };
  messageReads = 0;
});
test.after(() => {
  if (priorReact === undefined) delete globalThis.React;
  else globalThis.React = priorReact;
});
function elements(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)];
}
const query = (values = {}) => ({ searchParams: Promise.resolve(values) });

test("default and unknown tabs render Ideas without offering legacy intake", async () => {
  for (const values of [{}, { tab: "unknown" }]) {
    const tree = elements(await open(query(values)));
    const tabs = tree.find((element) => element.type === panels.AdminPageTabs).props;
    assert.equal(tabs.activeTabId, "ideas");
    assert.deepEqual(tabs.tabs.map((tab) => tab.id), ["ideas", "import", "reconciliation", "metadata"]);
    assert.equal("intake" in tabs.chips, false);
    assert.ok(tree.some((element) => element.type === panels.AmuxIdeaInputPanel));
  }
  const page = readFileSync(resolve(root, "app/(site)/(application)/admin/amux-backlog/page.tsx"), "utf8");
  assert.doesNotMatch(page, /AmuxIntakePanel|AmuxLocalIntakePanel/);
});

test("old intake tab redirects before panel reads and preserves recovery and filter queries", async () => {
  const values = { tab: ["intake", "metadata"], analysisHoldId: "hold-a", sourceKey: "source-a" };
  await assert.rejects(open(query(values)), (error) => {
    assert.ok(error instanceof Redirect);
    assert.equal(error.destination, "/admin/amux-backlog?tab=ideas&analysisHoldId=hold-a&sourceKey=source-a");
    return true;
  });
  assert.equal(messageReads, 0);
  assert.equal(ADMIN_LEGACY_ROUTES["/admin/amux-intake"], "/admin/amux-backlog?tab=ideas");
  assert.equal(adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-intake"], values),
    "/admin/amux-backlog?tab=ideas&analysisHoldId=hold-a&sourceKey=source-a");
});

test("non-owners are refused before a legacy tab redirect or any panel read", async () => {
  for (const role of ["ops", "support", "billing", "readonly", null]) {
    session = role ? { user: { id: "admin-a", role } } : null;
    await assert.rejects(open(query({ tab: "intake" })), /NOT_FOUND/);
    await assert.rejects(open(query()), /NOT_FOUND/);
  }
  assert.equal(messageReads, 0);
});

test("surviving sections still mount only their own panel", async () => {
  for (const [tab, name] of [["import", "AmuxBoardImportPanel"],
    ["reconciliation", "AmuxReconciliationPanel"], ["metadata", "AmuxBacklogMetadataPanel"]]) {
    const tree = elements(await open(query({ tab })));
    assert.ok(tree.some((element) => element.type === panels[name]));
    assert.equal(tree.some((element) => element.type === panels.AmuxIdeaInputPanel), false);
    assert.deepEqual(tree.filter((element) => Object.values(panels).includes(element.type))
      .map((element) => element.type), [panels.AdminPageTabs, panels[name]]);
  }
});
