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
let backlogReads;
let recentAuthentication;
const backlog = { rows: [], total: 0, page: 1, pageCount: 1, pageSize: 50 };
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
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  hasRecentAdminAuthentication: () => recentAuthentication,
} });
mock.module(mod("lib/amux/adminBacklogRead.ts"), { namedExports: {
  readAmuxBacklogList: async (search, page) => {
    backlogReads.push({ search, page });
    return backlog;
  },
} });
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
mock.module(mod("lib/amux/ideaProgressRead.ts"), { namedExports: {
  readAmuxIdeaProgressForOwner: async () => [],
} });
const panels = {};
for (const name of ["AdminPageTabs", "AmuxBacklogListPanel", "AmuxBacklogMetadataPanel", "AmuxBoardImportPanel",
  "AmuxIdeaInputPanel", "AmuxUnusedAnalysisReservationPanel", "AmuxAnalysisClaimResolutionPanel",
  "AmuxTaskCostCatalogApprovalPanel", "AmuxPortfolioPanel", "AmuxReconciliationPanel", "AmuxIdeaProgressPanel"]) {
  const panel = () => null;
  panels[name] = panel;
  mock.module(mod(`components/admin/${name}.tsx`), { namedExports: { [name]: panel } });
}
const { default: open } = await import(mod("app/(site)/(application)/admin/amux-backlog/page.tsx"));
const { ADMIN_LEGACY_ROUTES, adminRedirectTarget } = await import(mod("lib/adminNavigation.ts"));
test.beforeEach(() => {
  session = { user: { id: "owner-a", role: "owner" } };
  messageReads = 0;
  backlogReads = [];
  recentAuthentication = true;
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
    assert.deepEqual(tabs.tabs.map((tab) => tab.id),
      ["ideas", "list", "portfolio", "import", "reconciliation", "metadata", "recovery"]);
    assert.equal("intake" in tabs.chips, false);
    assert.ok(tree.some((element) => element.type === panels.AmuxIdeaInputPanel));
    assert.equal(tree.some((element) => element.type === panels.AmuxBacklogListPanel), false);
  }
  assert.deepEqual(backlogReads, []);
  const page = readFileSync(resolve(root, "app/(site)/(application)/admin/amux-backlog/page.tsx"), "utf8");
  assert.doesNotMatch(page, /AmuxIntakePanel|AmuxLocalIntakePanel/);
});

test("Ideas holds only the idea flow; portfolio, cleanup and the cost catalogue have their own sections", async () => {
  const ideas = elements(await open(query({ tab: "ideas" })));
  assert.ok(ideas.some((element) => element.type === panels.AmuxIdeaInputPanel));
  for (const moved of ["AmuxPortfolioPanel", "AmuxUnusedAnalysisReservationPanel", "AmuxTaskCostCatalogApprovalPanel",
    "AmuxBacklogListPanel"]) {
    assert.equal(ideas.some((element) => element.type === panels[moved]), false, moved);
  }
  assert.deepEqual(backlogReads, []);
  const portfolio = elements(await open(query({ tab: "portfolio" })));
  assert.ok(portfolio.some((element) => element.type === panels.AmuxPortfolioPanel));
  assert.equal(portfolio.some((element) => element.type === panels.AmuxIdeaInputPanel), false);
  const recovery = elements(await open(query({ tab: "recovery" })));
  assert.ok(recovery.some((element) => element.type === panels.AmuxUnusedAnalysisReservationPanel));
  const page = readFileSync(resolve(root, "app/(site)/(application)/admin/amux-backlog/page.tsx"), "utf8");
  assert.doesNotMatch(page, /AmuxTaskCostCatalogApprovalPanel/, "the catalogue lives in Operations settings");
  const settings = readFileSync(resolve(root, "app/(site)/(application)/admin/amux-settings/page.tsx"), "utf8");
  const analysis = settings.slice(settings.indexOf('if (tab.id === "analysis")'));
  for (const panel of ["<AmuxAnalysisMonthlyBudgetPanel", "<AmuxFrontierModelRegistrationPanel",
    "<AmuxTaskCostCatalogApprovalPanel"]) {
    assert.ok(analysis.slice(0, 1200).includes(panel), `${panel} is in Analysis settings`);
  }
});

test("List reads the normalized filter and page only after recent authentication", async () => {
  await open(query({ tab: "list", cardNumber: " CARD-1 ", page: "2" }));
  assert.deepEqual(backlogReads, [{ search: "CARD-1", page: 2 }]);
  backlogReads = [];
  recentAuthentication = false;
  const tree = elements(await open(query({ tab: "list", cardNumber: "CARD-1" })));
  const list = tree.find((element) => element.type === panels.AmuxBacklogListPanel);
  assert.equal(list.props.data, null);
  assert.equal(list.props.search, "CARD-1");
  assert.deepEqual(backlogReads, []);
});

test("invalid card-number filters do not read the backlog", async () => {
  const tree = elements(await open(query({ tab: "list", cardNumber: "%" })));
  const list = tree.find((element) => element.type === panels.AmuxBacklogListPanel);
  assert.equal(list.props.valid, false);
  assert.equal(list.props.data, null);
  assert.deepEqual(backlogReads, []);
});

test("old intake tab redirects before panel reads and preserves recovery and filter queries", async () => {
  const values = { tab: ["intake", "metadata"], analysisHoldId: "hold-a", sourceKey: "source-a" };
  await assert.rejects(open(query(values)), (error) => {
    assert.ok(error instanceof Redirect);
    assert.equal(error.destination, "/admin/amux-backlog?tab=ideas&analysisHoldId=hold-a&sourceKey=source-a");
    return true;
  });
  assert.equal(messageReads, 0);
  assert.deepEqual(backlogReads, []);
  assert.equal(ADMIN_LEGACY_ROUTES["/admin/amux-intake"], "/admin/amux-backlog?tab=ideas");
  assert.equal(adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-intake"], values),
    "/admin/amux-backlog?tab=ideas&analysisHoldId=hold-a&sourceKey=source-a");
});

test("the redirected Ideas page still renders recovery for the exact preserved hold", async () => {
  const prior = process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ;
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ = "enabled";
  const holdId = "12345678-1234-4123-8123-123456789abc";
  try {
    let destination;
    await assert.rejects(open(query({ tab: "intake", analysisHoldId: holdId })), (error) => {
      assert.ok(error instanceof Redirect);
      destination = error.destination;
      return true;
    });
    const redirected = Object.fromEntries(new URL(destination, "https://fixture.invalid").searchParams);
    assert.equal(redirected.tab, "ideas");
    assert.equal(redirected.analysisHoldId, holdId);
    const tree = elements(await open(query(redirected)));
    const recovery = tree.filter((element) => element.type === panels.AmuxAnalysisClaimResolutionPanel);
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].props.holdId, holdId);
    // React.Children.toArray prefixes explicit keys in the traversal helper.
    assert.equal(recovery[0].key, `.$${holdId}`);
  } finally {
    if (prior === undefined) delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ;
    else process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ = prior;
  }
});

test("non-owners are refused before a legacy tab redirect or any panel read", async () => {
  for (const role of ["ops", "support", "billing", "readonly", null]) {
    session = role ? { user: { id: "admin-a", role } } : null;
    await assert.rejects(open(query({ tab: "intake" })), /NOT_FOUND/);
    await assert.rejects(open(query()), /NOT_FOUND/);
  }
  assert.equal(messageReads, 0);
  assert.deepEqual(backlogReads, []);
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
  assert.deepEqual(backlogReads, []);
});
