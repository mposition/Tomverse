import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_ADMIN_ACCESS_LEGACY_TABS,
  ADMIN_AGENT_DIGESTS_DEFAULT_ROUTE,
  ADMIN_AGENT_DIGESTS_LEGACY_TABS,
  ADMIN_AMUX_BACKLOG_LEGACY_TABS,
  ADMIN_AMUX_EXECUTION_LEGACY_TABS,
  ADMIN_AMUX_SETTINGS_LEGACY_TABS,
  ADMIN_DETAIL_ROUTES,
  ADMIN_ENGINEERING_AGENT_LEGACY_TABS,
  ADMIN_LEGACY_ROUTES,
  ADMIN_LEGACY_TAB_ROUTES,
  ADMIN_MARKETING_LEGACY_TABS,
  ADMIN_NAVIGATION,
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ITEMS_BY_GROUP,
  ADMIN_QA_RELEASE_LEGACY_TABS,
  ADMIN_SEARCHABLE_PAGES,
  ADMIN_UNLISTED_PAGES,
  adminHrefIsVisibleTo,
  adminIsVisibleTo,
  adminItemIsWritable,
  adminNavigationFor,
  adminNavItemsByGroupFor,
  adminNavItemTabs,
  adminRedirectTarget,
  adminSearchablePagesFor,
  findAdminNavItem,
  matchAdminPages,
  resolveAdminPageMeta,
  resolveAdminTab,
  resolveAdminTabFor,
  resolveAdminView,
} from "../lib/adminNavigation.ts";
import { ADMIN_ROLE_ORDER } from "../lib/adminAuthCore.ts";
import { localizedAdminSearchablePages } from "../lib/adminNavigationLocale.ts";
import {
  EMPTY_ADMIN_NAVIGATION_COUNTS,
  adminNavigationBadge,
} from "../lib/adminNavigationBadges.ts";

const ADMIN_ROUTE_ROOT = join(
  process.cwd(),
  "app",
  "(site)",
  "(application)",
  "admin"
);

const routeSegments = () =>
  readdirSync(ADMIN_ROUTE_ROOT).filter((name) =>
    statSync(join(ADMIN_ROUTE_ROOT, name)).isDirectory()
  );

const liveHrefs = () =>
  new Set([
    ...ADMIN_NAVIGATION.map((item) => item.href),
    ...ADMIN_UNLISTED_PAGES.map((page) => page.href),
  ]);

test("the navigation is eight groups of unique, non-empty entries, six at most to a group", () => {
  assert.deepEqual([...ADMIN_NAV_GROUPS], [
    "Home",
    "Customers & Revenue",
    "AI Platform",
    "AI Agents",
    "Development",
    "System",
    "Messaging",
    "Governance",
  ]);
  assert.equal(ADMIN_NAV_ITEMS_BY_GROUP.length, ADMIN_NAV_GROUPS.length);
  for (const group of ADMIN_NAV_ITEMS_BY_GROUP) {
    assert.ok(group.items.length > 0, `${group.label} has no entries`);
    assert.ok(group.items.length <= 6, `${group.label} has more than six entries`);
  }
  assert.equal(ADMIN_NAVIGATION.length, 32);
  const hrefs = ADMIN_NAVIGATION.map((item) => item.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "duplicate navigation href");
  const ids = ADMIN_NAVIGATION.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate navigation id");
  for (const item of ADMIN_NAVIGATION) {
    const tabIds = (item.tabs || []).map((tab) => tab.id);
    assert.equal(new Set(tabIds).size, tabIds.length, `${item.id} repeats a tab id`);
  }
});

test("the approved sitemap is the table: every group, entry and tab, in order", () => {
  // Written out rather than read back from the table (2026-11-07 approval):
  // the screen work that follows changes pages, never this.
  const expected = {
    Home: [
      ["overview", "/admin/overview", ["summary", "health"]],
      ["work-queue", "/admin/work-queue", ["all", "customers", "agents", "development", "system"]],
      ["analytics", "/admin/analytics", ["usage", "product", "ai-review", "imports"]],
    ],
    "Customers & Revenue": [
      ["users", "/admin/users", undefined],
      ["support", "/admin/support", ["feedback", "autofix", "privacy"]],
      ["billing", "/admin/billing", ["plans", "prices", "promotions", "diagnostics"]],
      ["refunds", "/admin/refunds", undefined],
      ["credit-ledger", "/admin/credit-ledger", undefined],
    ],
    "AI Platform": [
      ["providers", "/admin/providers", ["health", "usage-cost", "incidents"]],
      ["models", "/admin/models", ["registry", "discovery", "defaults", "catalog"]],
      ["routing", "/admin/routing", ["auto", "optimizer", "shadow", "stats"]],
    ],
    "AI Agents": [
      ["office", "/admin/office", ["dashboard", "live"]],
      ["marketing", "/admin/marketing", ["overview", "queue", "published", "accounts", "reports", "settings"]],
      ["product-research", "/admin/product-research", ["suggestions", "runs", "observations"]],
      ["engineering-agent", "/admin/engineering-agent", ["overview", "queue", "runs", "settings"]],
      ["sre-ops", "/admin/sre-ops", ["overview", "daily", "settings"]],
      ["finance-agent", "/admin/finance-agent", ["overview", "report", "settings"]],
    ],
    Development: [
      ["amux-backlog", "/admin/amux-backlog", ["ideas", "list", "portfolio"]],
      ["amux-execution", "/admin/amux-execution", ["cards", "review", "diagnostics"]],
      ["release", "/admin/release", ["qa", "ci"]],
      ["amux-settings", "/admin/amux-settings", ["automatic-admission", "workers", "decision-maker", "analysis"]],
      ["amux-recovery", "/admin/amux-recovery", ["safety", "reservations", "legacy"]],
    ],
    System: [
      ["infrastructure", "/admin/infrastructure", undefined],
      ["automation", "/admin/automation", ["jobs", "webhooks", "reports"]],
      ["platform", "/admin/platform", ["emergency", "features", "account-defaults"]],
    ],
    Messaging: [
      ["email-campaigns", "/admin/email-campaigns", ["campaigns", "schedule", "new"]],
      ["email-delivery", "/admin/email-delivery", ["deliveries", "suppressions"]],
      ["alerts", "/admin/alerts", ["policy", "templates", "deliveries", "mail-test"]],
      ["email-policy", "/admin/email-policy", ["jurisdictions", "domains"]],
    ],
    Governance: [
      ["audit", "/admin/audit", ["log", "integrity"]],
      ["retention", "/admin/retention", undefined],
      ["admin-access", "/admin/admin-access", ["administrators", "readiness"]],
    ],
  };
  assert.deepEqual(
    ADMIN_NAV_ITEMS_BY_GROUP.map((group) => group.label),
    Object.keys(expected)
  );
  for (const group of ADMIN_NAV_ITEMS_BY_GROUP) {
    assert.deepEqual(
      group.items.map((item) => [item.id, item.href, item.tabs?.map((tab) => tab.id)]),
      expected[group.label],
      group.label
    );
  }
  // The user detail's sections are declared with the table too.
  const detail = ADMIN_DETAIL_ROUTES.find((route) => route.id === "user-detail");
  assert.deepEqual(detail.tabs.map((tab) => tab.id), [
    "overview",
    "billing",
    "security",
    "conversations",
    "notes",
  ]);
});

test("every navigation entry resolves to a real route segment", () => {
  const segments = new Set(routeSegments());
  for (const item of ADMIN_NAVIGATION) {
    const segment = item.href.replace("/admin/", "");
    assert.ok(
      segments.has(segment),
      `${item.href} has no app/(site)/(application)/admin/${segment} directory`
    );
  }
  for (const page of ADMIN_UNLISTED_PAGES) {
    const segment = page.href.replace("/admin/", "");
    assert.ok(segments.has(segment), `${page.href} has no route directory`);
  }
});

test("every retired route still exists as a redirect to a live destination", () => {
  const live = liveHrefs();
  const segments = new Set(routeSegments());
  for (const [from, to] of Object.entries(ADMIN_LEGACY_ROUTES)) {
    const segment = from.replace("/admin/", "");
    assert.ok(
      segments.has(segment),
      `${from} has no redirect route; the bookmark would 404`
    );
    const source = readFileSync(
      join(ADMIN_ROUTE_ROOT, segment, "page.tsx"),
      "utf8"
    );
    assert.match(source, /redirect\(/, `${from} does not redirect`);
    const [path, query] = to.split("?");
    assert.ok(live.has(path), `${from} points at ${path}, which is not a page`);
    if (query) {
      // A consolidated destination must name its tab, or the redirect quietly
      // lands the operator on the page's first section instead of the one the
      // link meant.
      const tab = new URLSearchParams(query).get("tab");
      const item = ADMIN_NAVIGATION.find((entry) => entry.href === path);
      assert.ok(
        item?.tabs?.some((entry) => entry.id === tab),
        `${from} redirects to an unknown tab "${tab}" on ${path}`
      );
    }
  }
});

test("every legacy ?tab= value maps to a live path", () => {
  const live = liveHrefs();
  for (const [tab, destination] of Object.entries(ADMIN_LEGACY_TAB_ROUTES)) {
    const [path] = destination.split("?");
    assert.ok(live.has(path), `?tab=${tab} points at ${path}`);
  }
});

test("every per-page legacy tab map lands on a live page, a tab it has and a view it knows", () => {
  const live = liveHrefs();
  // Each map with the page that owns the old address.
  const maps = {
    ADMIN_AGENT_DIGESTS_LEGACY_TABS: ["/admin/agent-digests", ADMIN_AGENT_DIGESTS_LEGACY_TABS],
    ADMIN_QA_RELEASE_LEGACY_TABS: ["/admin/qa-release", ADMIN_QA_RELEASE_LEGACY_TABS],
    ADMIN_AMUX_BACKLOG_LEGACY_TABS: ["/admin/amux-backlog", ADMIN_AMUX_BACKLOG_LEGACY_TABS],
    ADMIN_AMUX_SETTINGS_LEGACY_TABS: ["/admin/amux-settings", ADMIN_AMUX_SETTINGS_LEGACY_TABS],
    ADMIN_AMUX_EXECUTION_LEGACY_TABS: ["/admin/amux-execution", ADMIN_AMUX_EXECUTION_LEGACY_TABS],
    ADMIN_ADMIN_ACCESS_LEGACY_TABS: ["/admin/admin-access", ADMIN_ADMIN_ACCESS_LEGACY_TABS],
    ADMIN_MARKETING_LEGACY_TABS: ["/admin/marketing", ADMIN_MARKETING_LEGACY_TABS],
    ADMIN_ENGINEERING_AGENT_LEGACY_TABS: ["/admin/engineering-agent", ADMIN_ENGINEERING_AGENT_LEGACY_TABS],
  };
  // The views a tab holds until its own screen is built (`?view=`).
  const views = {
    "/admin/release|qa": ["overview", "train", "lane"],
    "/admin/marketing|queue": ["drafts", "assets", "comments"],
    "/admin/marketing|reports": ["reports", "competitors", "experiments"],
    "/admin/engineering-agent|runs": ["runs", "pull-requests"],
  };
  for (const [name, [owner, map]] of Object.entries(maps)) {
    const ownerItem = ADMIN_NAVIGATION.find((entry) => entry.href === owner);
    for (const [from, to] of Object.entries(map)) {
      // A value the map redirects away from must not also be a tab the page
      // still draws, or that tab could never open.
      assert.equal(
        ownerItem?.tabs?.some((entry) => entry.id === from) ?? false,
        false,
        `${name}[${from}] is still a tab of ${owner}`
      );
      const [path, query] = to.split("?");
      assert.ok(live.has(path), `${name}[${from}] points at ${path}, which is not a page`);
      const params = new URLSearchParams(query ?? "");
      const tab = params.get("tab");
      if (tab) {
        const item = ADMIN_NAVIGATION.find((entry) => entry.href === path);
        assert.ok(
          item?.tabs?.some((entry) => entry.id === tab),
          `${name}[${from}] redirects to an unknown tab "${tab}" on ${path}`
        );
        const view = params.get("view");
        if (view) {
          assert.ok(
            views[`${path}|${tab}`]?.includes(view),
            `${name}[${from}] names the view "${view}", which ${path}?tab=${tab} does not hold`
          );
        }
      }
    }
  }
});

test("the approved redirect table: every old address lands where the sitemap says", () => {
  // Written out from the 2026-11-07 sitemap approval, not read back from the
  // maps: this is the table the operator signed.
  const expected = [
    // [old route, old tab, redirect map, new destination]
    ["agent-digests", "qa-release", ADMIN_AGENT_DIGESTS_LEGACY_TABS, "/admin/release?tab=qa"],
    ["agent-digests", "ci-admission", ADMIN_AGENT_DIGESTS_LEGACY_TABS, "/admin/release?tab=ci"],
    ["agent-digests", "billing-finance-ops", ADMIN_AGENT_DIGESTS_LEGACY_TABS, "/admin/finance-agent"],
    ["amux-backlog", "import", ADMIN_AMUX_BACKLOG_LEGACY_TABS, "/admin/amux-recovery?tab=legacy"],
    ["amux-backlog", "reconciliation", ADMIN_AMUX_BACKLOG_LEGACY_TABS, "/admin/amux-recovery?tab=legacy"],
    ["amux-backlog", "metadata", ADMIN_AMUX_BACKLOG_LEGACY_TABS, "/admin/amux-recovery?tab=legacy"],
    ["amux-backlog", "recovery", ADMIN_AMUX_BACKLOG_LEGACY_TABS, "/admin/amux-recovery?tab=reservations"],
    ["amux-settings", "safety", ADMIN_AMUX_SETTINGS_LEGACY_TABS, "/admin/amux-recovery?tab=safety"],
    ["amux-execution", "assignment", ADMIN_AMUX_EXECUTION_LEGACY_TABS, "/admin/amux-execution?tab=review"],
    ["admin-access", "integrity", ADMIN_ADMIN_ACCESS_LEGACY_TABS, "/admin/audit?tab=integrity"],
  ];
  for (const [route, tab, map, to] of expected) {
    assert.equal(map[tab], to, `/admin/${route}?tab=${tab}`);
    // The page that owns the old address reads that very map, so the table
    // and the redirect cannot drift.
    const page = readFileSync(join(ADMIN_ROUTE_ROOT, route, "page.tsx"), "utf8");
    assert.match(page, /redirect\(/, `${route} does not redirect`);
    const mapName = Object.entries({
      ADMIN_AGENT_DIGESTS_LEGACY_TABS,
      ADMIN_AMUX_BACKLOG_LEGACY_TABS,
      ADMIN_AMUX_SETTINGS_LEGACY_TABS,
      ADMIN_AMUX_EXECUTION_LEGACY_TABS,
      ADMIN_ADMIN_ACCESS_LEGACY_TABS,
    }).find(([, value]) => value === map)[0];
    assert.ok(page.includes(`${mapName}[`), `${route} does not read ${mapName}`);
  }
  // Whole pages: `/admin/amux-promotion?tab=*` is the Legacy tools tab.
  assert.equal(ADMIN_LEGACY_ROUTES["/admin/amux-promotion"], "/admin/amux-recovery?tab=legacy");
  assert.equal(ADMIN_LEGACY_ROUTES["/admin/qa-release"], "/admin/release?tab=qa");
  assert.equal(ADMIN_AGENT_DIGESTS_DEFAULT_ROUTE, "/admin/release");
  // The old QA and release sections each land on the tab and view that hold them.
  assert.deepEqual(ADMIN_QA_RELEASE_LEGACY_TABS, {
    overview: "/admin/release?tab=qa",
    train: "/admin/release?tab=qa&view=train",
    lane: "/admin/release?tab=qa&view=lane",
    "ci-admission": "/admin/release?tab=ci",
  });
  // Every redirect carries the request's own query and never its stale tab.
  assert.equal(
    adminRedirectTarget(ADMIN_QA_RELEASE_LEGACY_TABS.lane, { tab: "lane", pr: "12" }),
    "/admin/release?tab=qa&view=lane&pr=12"
  );
  assert.equal(
    adminRedirectTarget(ADMIN_AGENT_DIGESTS_LEGACY_TABS["ci-admission"], { tab: "ci-admission", pr: "2890" }),
    "/admin/release?tab=ci&pr=2890"
  );
  assert.equal(
    adminRedirectTarget(ADMIN_AMUX_SETTINGS_LEGACY_TABS.safety, { tab: "safety", taskId: "t-1" }),
    "/admin/amux-recovery?tab=safety&taskId=t-1"
  );
  assert.equal(
    adminRedirectTarget(ADMIN_AMUX_BACKLOG_LEGACY_TABS.recovery, { tab: "recovery", analysisHoldId: "h-1" }),
    "/admin/amux-recovery?tab=reservations&analysisHoldId=h-1"
  );
});

test("the Trust and safety digest keeps its address and every other digest address redirects", () => {
  const page = readFileSync(join(ADMIN_ROUTE_ROOT, "agent-digests", "page.tsx"), "utf8");
  assert.ok(page.includes("ADMIN_AGENT_DIGESTS_LEGACY_TABS[requestedTab]"));
  assert.ok(page.includes("redirect(adminRedirectTarget(legacy, query))"));
  // Everything but the one tab that stayed goes to Release.
  assert.match(page, /requestedTab !== "trust-safety"\) redirect\(adminRedirectTarget\(ADMIN_AGENT_DIGESTS_DEFAULT_ROUTE, query\)\)/);
  assert.equal("trust-safety" in ADMIN_AGENT_DIGESTS_LEGACY_TABS, false);
  const unlisted = ADMIN_UNLISTED_PAGES.find((entry) => entry.href === "/admin/agent-digests");
  assert.ok(unlisted, "the Trust and safety digest is a known page");
  assert.equal(resolveAdminPageMeta("/admin/agent-digests").isKnown, true);
  // The activation route and the Agent office still send people to it.
  assert.match(
    readFileSync(join(process.cwd(), "app/api/admin/agents/trust-safety/activation/route.ts"), "utf8"),
    /\/admin\/agent-digests\?tab=trust-safety/
  );
});

test("a redirect carries the request's own query but never its stale tab", () => {
  assert.equal(
    adminRedirectTarget("/admin/support?tab=feedback", { status: "open" }),
    "/admin/support?tab=feedback&status=open"
  );
  // `/admin?tab=refunds` consumed its tab in the lookup; copying it forward
  // would produce `/admin/refunds?tab=refunds`.
  assert.equal(
    adminRedirectTarget("/admin/refunds", { tab: "refunds" }),
    "/admin/refunds"
  );
  assert.equal(adminRedirectTarget("/admin/overview", {}), "/admin/overview");
  assert.equal(
    adminRedirectTarget("/admin/audit", { q: "plan", target: undefined }),
    "/admin/audit?q=plan"
  );
});

test("an unknown route gets neutral metadata rather than the first entry's", () => {
  const meta = resolveAdminPageMeta("/admin/a-route-that-no-longer-exists");
  assert.equal(meta.isKnown, false);
  assert.equal(meta.label, "Admin Console");
  assert.notEqual(meta.label, ADMIN_NAVIGATION[0].label);
});

test("the global search workspace is titled Global search, not Today", () => {
  const meta = resolveAdminPageMeta("/admin/search");
  assert.equal(meta.label, "Global search");
  assert.equal(meta.isKnown, true);
  assert.equal(findAdminNavItem("/admin/search"), null);
});

test("detail routes keep their parent breadcrumb and their parent nav entry", () => {
  const user = resolveAdminPageMeta("/admin/users/abc123");
  assert.equal(user.label, "Customer detail");
  assert.equal(user.parentHref, "/admin/users");
  assert.equal(findAdminNavItem("/admin/users/abc123")?.href, "/admin/users");

  const provider = resolveAdminPageMeta("/admin/providers/openai");
  assert.equal(provider.label, "Provider detail");
  assert.equal(provider.parentHref, "/admin/providers");

  const refiner = resolveAdminPageMeta("/admin/prompt-refiner-shadow");
  assert.equal(refiner.label, "Prompt Refiner shadow run");
  assert.equal(refiner.parentHref, "/admin/models");

  const amuxTestCard = resolveAdminPageMeta("/admin/amux-u21-test-card");
  assert.equal(amuxTestCard.label, "AMUX U21 test card");
  assert.equal(amuxTestCard.parentHref, "/admin/amux-execution");
  assert.equal(amuxTestCard.parentLabel, "Execution board");
  assert.equal(resolveAdminPageMeta(
    "/admin/amux-u21-test-card", "support").isKnown, false);
  assert.equal(ADMIN_SEARCHABLE_PAGES.some(
    (page) => page.href === "/admin/amux-u21-test-card"), false);

  // Every detail route belongs to a group of the table, and its parent is a page of it.
  for (const route of ADMIN_DETAIL_ROUTES) {
    assert.ok(ADMIN_NAV_GROUPS.includes(route.group), `${route.id} names an unknown group`);
    assert.ok(findAdminNavItem(route.parentHref), `${route.id} has no parent entry`);
  }
});

test("the palette can reach every page, including the unlisted ones", () => {
  const pages = new Set(ADMIN_SEARCHABLE_PAGES.map((page) => page.href));
  for (const item of ADMIN_NAVIGATION) assert.ok(pages.has(item.href));
  // An unlisted page opens at `openHref` when its bare address would redirect.
  for (const page of ADMIN_UNLISTED_PAGES) assert.ok(pages.has("openHref" in page ? page.openHref : page.href));
  assert.ok(pages.has("/admin/agent-digests?tab=trust-safety"), "the palette opens the Trust and safety digest on its tab");
  assert.equal(pages.has("/admin/agent-digests"), false);
  // Every page is findable by its own label, which the old
  // `ALL_ITEMS.slice(0, 9)` empty state could not claim.
  for (const page of ADMIN_SEARCHABLE_PAGES) {
    const matches = matchAdminPages(page.label);
    assert.ok(
      matches.some((match) => match.href === page.href),
      `${page.label} is not findable by its own label`
    );
  }
});

test("pages are searchable by alias and by group, not only by label", () => {
  const byAlias = matchAdminPages("coupon");
  assert.ok(byAlias.some((page) => page.href === "/admin/billing"));

  const byOutage = matchAdminPages("outage");
  assert.ok(byOutage.some((page) => page.href === "/admin/providers"));

  const byCron = matchAdminPages("cron");
  assert.ok(byCron.some((page) => page.href === "/admin/automation"));

  const byGroup = matchAdminPages("Governance");
  assert.ok(byGroup.some((page) => page.href === "/admin/audit"));

  // The old names still find the new pages.
  assert.ok(matchAdminPages("qa-release").some((page) => page.href === "/admin/release"));
  assert.ok(matchAdminPages("work queue").some((page) => page.href === "/admin/work-queue"));
  assert.ok(matchAdminPages("integrity").some((page) => page.href === "/admin/audit"));
  assert.ok(matchAdminPages("halt").some((page) => page.href === "/admin/amux-recovery"));
  assert.ok(matchAdminPages("platform settings").some((page) => page.href === "/admin/platform"));

  assert.deepEqual(matchAdminPages("   "), []);
});

test("a stale or missing ?tab= falls back to the page's first section", () => {
  const tabs = adminNavItemTabs("providers");
  assert.equal(resolveAdminTab(tabs, undefined).id, tabs[0].id);
  assert.equal(resolveAdminTab(tabs, "not-a-tab").id, tabs[0].id);
  assert.equal(resolveAdminTab(tabs, "incidents").id, "incidents");
  assert.equal(resolveAdminTab(tabs, ["usage-cost"]).id, "usage-cost");
});

test("a tab's view falls back to the first view and never invents one", () => {
  const views = ["overview", "train", "lane"];
  assert.equal(resolveAdminView(views, undefined), "overview");
  assert.equal(resolveAdminView(views, "nope"), "overview");
  assert.equal(resolveAdminView(views, "lane"), "lane");
  assert.equal(resolveAdminView(views, ["train"]), "train");
});

test("write permission is unchanged: an entry with no writeRoles is open to all", () => {
  const users = ADMIN_NAVIGATION.find((item) => item.id === "users");
  assert.equal(adminItemIsWritable("support", users), true);
  assert.equal(adminItemIsWritable("billing", users), false);

  const audit = ADMIN_NAVIGATION.find((item) => item.id === "audit");
  assert.equal(adminItemIsWritable("readonly", audit), true);

  const access = ADMIN_NAVIGATION.find((item) => item.id === "admin-access");
  assert.equal(adminItemIsWritable("owner", access), true);
  assert.equal(adminItemIsWritable("ops", access), false);
});

test("the table's write roles match what the pages' routes check", () => {
  // Routing's router routes all take `ops:write` (owner and ops); the table
  // said nothing, so the screen never marked itself read-only.
  const routing = ADMIN_NAVIGATION.find((item) => item.id === "routing");
  assert.deepEqual(routing.writeRoles, ["owner", "ops"]);
  assert.equal(adminItemIsWritable("billing", routing), false);
  assert.equal(adminItemIsWritable("ops", routing), true);
  for (const route of [
    "app/api/admin/auto-llm-router/route.ts",
    "app/api/admin/auto-llm-router/optimizer/route.ts",
    "app/api/admin/auto-llm-router/rewrite-optimizer/route.ts",
  ]) {
    assert.match(readFileSync(join(process.cwd(), route), "utf8"), /hasAdminPermission\(session, "ops:write"\)/, route);
  }
  // The credit ledger writes nothing, so it declares no write role.
  const ledger = ADMIN_NAVIGATION.find((item) => item.id === "credit-ledger");
  assert.equal(ledger.writeRoles, undefined);
  // The panel and its client-side table (type chips, customer search) are both
  // read-only: neither sends a write or any request.
  for (const file of ["components/admin/AdminCreditLedgerPanel.tsx", "components/admin/AdminCreditLedgerTable.tsx"]) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /method:\s*"(POST|PATCH|PUT|DELETE)"/, file);
    assert.doesNotMatch(source, /adminFetch|fetch\(/, file);
  }
});

test("a badge with no known count renders nothing rather than zero", () => {
  assert.equal(
    adminNavigationBadge("workQueue", EMPTY_ADMIN_NAVIGATION_COUNTS),
    null
  );
  assert.equal(
    adminNavigationBadge("workQueue", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      pendingRefunds: 2,
      openFeedback: 3,
    }),
    5
  );
  assert.equal(
    adminNavigationBadge("refunds", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      pendingRefunds: 0,
    }),
    0
  );
  assert.equal(
    adminNavigationBadge("not-a-badge", EMPTY_ADMIN_NAVIGATION_COUNTS),
    null
  );
});

test("every badge key a navigation entry declares is one the resolver knows", () => {
  // Built from the shape rather than written out. A hand-listed object here
  // goes stale the moment a count is added, and it fails as "the new badge
  // resolves to nothing" -- which is what an unregistered badge key looks like
  // too, so the failure would not say which of the two happened.
  const counts = Object.fromEntries(
    Object.keys(EMPTY_ADMIN_NAVIGATION_COUNTS).map((key) => [key, 1])
  );
  for (const item of ADMIN_NAVIGATION) {
    if (!item.badge) continue;
    assert.notEqual(
      adminNavigationBadge(item.badge, counts),
      null,
      `${item.label} declares badge "${item.badge}", which resolves to nothing`
    );
  }
  // A tab strip derives its badges with the same resolver.
  for (const item of ADMIN_NAVIGATION) {
    for (const tab of item.tabs || []) {
      if (!tab.badge) continue;
      assert.notEqual(
        adminNavigationBadge(tab.badge, counts),
        null,
        `${item.label}/${tab.label} declares badge "${tab.badge}", which resolves to nothing`
      );
    }
  }
});

test("Decisions carries the work queue's own badge", () => {
  const decisions = ADMIN_NAVIGATION.find((item) => item.id === "work-queue");
  assert.equal(decisions.label, "Decisions");
  assert.equal(decisions.badge, "workQueue");
});

test("the discovery backlog keeps a way in", () => {
  // The finding this whole surface answers is that discovery wrote its results
  // to a table nothing read. A tab removed, a badge unwired or a renamed id
  // would put it back there, so the path is pinned rather than assumed.
  const models = ADMIN_NAVIGATION.find((item) => item.id === "models");
  assert.ok(models, "the models entry exists");
  assert.equal(models.badge, "modelLifecycle");
  assert.deepEqual(
    models.tabs?.map((tab) => tab.id),
    ["registry", "discovery", "defaults", "catalog"]
  );
  // The registry stays the default: an operator opening /admin/models is far
  // more often there for the catalogue than for the backlog.
  assert.equal(resolveAdminTab(adminNavItemTabs("models"), undefined).id, "registry");
  assert.equal(resolveAdminTab(adminNavItemTabs("models"), "discovery").id, "discovery");
  assert.equal(resolveAdminTab(adminNavItemTabs("models"), "defaults").id, "defaults");
  assert.equal(resolveAdminTab(adminNavItemTabs("models"), "catalog").id, "catalog");
});

// ---------------------------------------------------------------------------
// The Development group and view roles
// ---------------------------------------------------------------------------

const readPage = (segment) =>
  readFileSync(join(ADMIN_ROUTE_ROOT, segment, "page.tsx"), "utf8");

const loaderSource = () =>
  readFileSync(join(process.cwd(), "lib", "adminNavigationCounts.ts"), "utf8");

const OWNER_GATE =
  /if \(!session\?\.user\?\.id \|\| getAdminRole\(session\) !== "owner"\) notFound\(\);/;

const NON_OWNER_ROLES = ADMIN_ROLE_ORDER.filter((role) => role !== "owner");

test("the Development group holds Ideas, the execution board, Release, AMUX settings and Safety & recovery", () => {
  const group = ADMIN_NAV_ITEMS_BY_GROUP.find((entry) => entry.label === "Development");
  assert.ok(group, "the Development group exists");
  assert.deepEqual(
    group.items.map((item) => [item.id, item.label, item.href]),
    [
      ["amux-backlog", "Ideas", "/admin/amux-backlog"],
      ["amux-execution", "Execution board", "/admin/amux-execution"],
      ["release", "Release", "/admin/release"],
      ["amux-settings", "AMUX settings", "/admin/amux-settings"],
      ["amux-recovery", "Safety & recovery", "/admin/amux-recovery"],
    ]
  );
  assert.deepEqual(
    adminNavItemTabs("amux-backlog").map((tab) => tab.id),
    ["ideas", "list", "portfolio"]
  );
  assert.deepEqual(
    adminNavItemTabs("amux-execution").map((tab) => tab.id),
    ["cards", "review", "diagnostics"]
  );
  assert.deepEqual(
    adminNavItemTabs("amux-settings").map((tab) => tab.id),
    ["automatic-admission", "workers", "decision-maker", "analysis"]
  );
  assert.deepEqual(
    adminNavItemTabs("amux-recovery").map((tab) => tab.id),
    ["safety", "reservations", "legacy"]
  );
  // Agents sit between AI Platform and Development; Messaging follows System.
  assert.deepEqual(
    ADMIN_NAV_GROUPS.slice(ADMIN_NAV_GROUPS.indexOf("AI Agents"), ADMIN_NAV_GROUPS.indexOf("System") + 1),
    ["AI Agents", "Development", "System"]
  );
});

test("each of the eight AMUX screens redirects to its current section", () => {
  // Written out rather than read back from the table: these are the addresses
  // policy documents, runbooks and audit summaries already name. Import,
  // reconciliation, metadata and the three promotion screens are the Legacy
  // tools of Safety & recovery.
  const expected = {
    "/admin/amux-intake": "/admin/amux-backlog?tab=ideas",
    "/admin/amux-board-import": "/admin/amux-recovery?tab=legacy",
    "/admin/amux-reconciliation": "/admin/amux-recovery?tab=legacy",
    "/admin/amux-backlog-metadata": "/admin/amux-recovery?tab=legacy",
    "/admin/amux-board-recommendation": "/admin/amux-recovery?tab=legacy",
    "/admin/amux-board-promotion": "/admin/amux-recovery?tab=legacy",
    "/admin/amux-board-auto-promotion": "/admin/amux-recovery?tab=legacy",
    "/admin/amux-cards": "/admin/amux-execution?tab=cards",
  };
  for (const [from, to] of Object.entries(expected)) {
    assert.equal(ADMIN_LEGACY_ROUTES[from], to, from);
    const source = readPage(from.replace("/admin/", ""));
    assert.match(source, /redirect\(/, `${from} does not redirect`);
    assert.ok(
      source.includes(`ADMIN_LEGACY_ROUTES["${from}"]`),
      `${from} redirects somewhere other than its own table entry`
    );
    // The redirect carries the request's own query and never its tab.
    assert.match(source, /adminRedirectTarget\(/);
    // Access is the destination's to decide; the redirect confirms nothing
    // the destination would not.
    assert.doesNotMatch(source, /notFound|getAdminRole/, `${from} decides access itself`);
  }
  // A retired address is a redirect now, not a titled detail route.
  for (const from of Object.keys(expected)) {
    assert.equal(
      ADMIN_DETAIL_ROUTES.some((route) => route.pattern.test(from)),
      false,
      `${from} is still a detail route`
    );
  }
  assert.equal(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-cards"], {
      tab: "x",
      sourceKey: "A-1",
    }),
    "/admin/amux-execution?tab=cards&sourceKey=A-1"
  );
  // The Promotion and QA and release pages redirect too, whatever their tab.
  for (const from of ["/admin/amux-promotion", "/admin/qa-release"]) {
    const source = readPage(from.replace("/admin/", ""));
    assert.match(source, /redirect\(/, `${from} does not redirect`);
    assert.ok(source.includes(`ADMIN_LEGACY_ROUTES["${from}"]`), from);
    assert.doesNotMatch(source, /notFound|getAdminRole/, `${from} decides access itself`);
  }
});

test("the owner sees everything while other roles cannot see the owner's sections", () => {
  const owner = adminNavigationFor("owner");
  for (const item of ADMIN_NAVIGATION) {
    const shown = owner.find((entry) => entry.id === item.id);
    assert.ok(shown, `owner does not see ${item.id}`);
    assert.deepEqual(
      shown.tabs?.map((tab) => tab.id),
      item.tabs?.map((tab) => tab.id),
      `owner does not see every section of ${item.id}`
    );
  }
  assert.equal(owner.length, 32);

  for (const role of NON_OWNER_ROLES) {
    const visible = adminNavigationFor(role);
    assert.equal(visible.length, 31, `${role}: the entries it sees`);
    const development = visible.filter((item) => item.group === "Development");
    // Ideas is the one owner-only entry.
    assert.deepEqual(
      development.map((item) => item.id),
      ["amux-execution", "release", "amux-settings", "amux-recovery"],
      `${role}: Development entries`
    );
    const tabsOf = (id) => development.find((item) => item.id === id).tabs.map((tab) => tab.id);
    assert.deepEqual(tabsOf("amux-execution"), ["review", "diagnostics"], `${role}: board sections`);
    // Workers and Decision Maker are read by every role; the registry change
    // takes the owner role (orchestration policy version 31, section 3).
    assert.deepEqual(tabsOf("amux-settings"), ["workers", "decision-maker"], `${role}: settings sections`);
    // Execution safety is readable by every role; the owner clears.
    assert.deepEqual(tabsOf("amux-recovery"), ["safety"], `${role}: Safety & recovery sections`);
    // Statistics are the owner's.
    assert.deepEqual(
      visible.find((item) => item.id === "routing").tabs.map((tab) => tab.id),
      ["auto", "optimizer", "shadow"],
      `${role}: routing sections`
    );
    // Nothing else moves for this role.
    assert.deepEqual(
      visible.filter((item) => item.group !== "Development").map((item) => item.id),
      ADMIN_NAVIGATION.filter((item) => item.group !== "Development").map((item) => item.id),
      `${role}: entries outside Development`
    );
    const group = adminNavItemsByGroupFor(role).find((entry) => entry.label === "Development");
    assert.deepEqual(group.items.map((item) => item.id), ["amux-execution", "release", "amux-settings", "amux-recovery"]);
  }
});

test("a role that cannot be determined sees only what every role sees", () => {
  for (const role of [null, undefined]) {
    assert.deepEqual(
      adminNavigationFor(role)
        .filter((item) => item.group === "Development")
        .map((item) => [item.id, item.tabs.map((tab) => tab.id)]),
      [
        ["amux-execution", ["review", "diagnostics"]],
        ["release", ["qa", "ci"]],
        ["amux-settings", ["workers", "decision-maker"]],
        ["amux-recovery", ["safety"]],
      ]
    );
  }
});

test("the palette, pins and recents do not offer a non-owner the owner's pages", () => {
  for (const role of NON_OWNER_ROLES) {
    const hrefs = adminSearchablePagesFor(role).map((page) => page.href);
    assert.equal(hrefs.includes("/admin/amux-backlog"), false, role);
    assert.equal(hrefs.includes("/admin/amux-execution"), true, role);
    assert.equal(hrefs.includes("/admin/release"), true, role);
    assert.equal(hrefs.includes("/admin/amux-settings"), true, role);
    assert.equal(hrefs.includes("/admin/amux-recovery"), true, role);
    for (const locale of ["en", "ko"]) {
      assert.deepEqual(
        localizedAdminSearchablePages(locale, role).map((page) => page.href),
        hrefs,
        `${role}/${locale}`
      );
    }

    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-backlog"), false);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-execution"), true);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-execution?tab=review"), true);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-execution?tab=cards"), false);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-settings"), true);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-settings?tab=workers"), true);
    assert.equal(
      adminHrefIsVisibleTo(role, "/admin/amux-settings?tab=automatic-admission"),
      false
    );
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-recovery?tab=safety"), true);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-recovery?tab=legacy"), false);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-recovery?tab=reservations"), false);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/routing?tab=stats"), false);
    // A page outside the table is left to the caller's own rule.
    assert.equal(adminHrefIsVisibleTo(role, "/admin/search"), true);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/refunds"), true);
  }
  const ownerHrefs = adminSearchablePagesFor("owner").map((page) => page.href);
  for (const href of [
    "/admin/amux-backlog",
    "/admin/amux-execution",
    "/admin/amux-settings",
    "/admin/amux-recovery",
    "/admin/release",
  ]) {
    assert.ok(ownerHrefs.includes(href), href);
    assert.equal(adminHrefIsVisibleTo("owner", href), true);
  }
  assert.equal(adminHrefIsVisibleTo("owner", "/admin/amux-execution?tab=cards"), true);
  assert.equal(adminHrefIsVisibleTo("owner", "/admin/amux-recovery?tab=legacy"), true);
  assert.equal(adminHrefIsVisibleTo("owner", "/admin/routing?tab=stats"), true);
  assert.equal(
    adminHrefIsVisibleTo("owner", "/admin/amux-settings?tab=automatic-admission"),
    true
  );
  // Without a role the palette fails closed.
  assert.equal(
    localizedAdminSearchablePages("en").some((page) => page.href === "/admin/amux-backlog"),
    false
  );
  // The unfiltered list still names every page, so a stored pin is judged
  // against what exists before it is judged against who is looking.
  assert.equal(
    ADMIN_SEARCHABLE_PAGES.length,
    ADMIN_NAVIGATION.length + ADMIN_UNLISTED_PAGES.length
  );
});

test("the board and settings open on the first section each role may see", () => {
  const tabs = adminNavItemTabs("amux-execution");
  assert.equal(resolveAdminTabFor(tabs, "owner", undefined).tab.id, "cards");
  assert.equal(resolveAdminTabFor(tabs, "owner", "review").tab.id, "review");
  // Workers moved to AMUX settings; the board no longer offers it.
  assert.equal(resolveAdminTabFor(tabs, "owner", "workers").tab.id, "cards");
  assert.equal(resolveAdminTabFor(adminNavItemTabs("amux-settings"), "owner", "workers").tab.id, "workers");
  assert.equal(resolveAdminTabFor(tabs, "owner", "not-a-tab").tab.id, "cards");
  for (const role of [...NON_OWNER_ROLES, null]) {
    const opened = resolveAdminTabFor(tabs, role, undefined);
    assert.equal(opened.tab.id, "review", String(role));
    assert.deepEqual(opened.visible.map((tab) => tab.id), ["review", "diagnostics"]);
    assert.equal(resolveAdminTabFor(adminNavItemTabs("amux-settings"), role, "workers").tab.id, "workers", String(role));
    assert.equal(resolveAdminTabFor(adminNavItemTabs("amux-settings"), role, "decision-maker").tab.id, "decision-maker", String(role));
    assert.equal(resolveAdminTabFor(adminNavItemTabs("amux-recovery"), role, "safety").tab.id, "safety", String(role));
    // A stale value that names no section still falls back...
    assert.equal(resolveAdminTabFor(tabs, role, "not-a-tab").tab.id, "review");
    // ...but naming the owner's section is a 404, not a silent substitute.
    assert.equal(resolveAdminTabFor(tabs, role, "cards"), null, String(role));
    assert.equal(resolveAdminTabFor(tabs, role, ["cards"]), null, String(role));
    assert.equal(resolveAdminTabFor(adminNavItemTabs("amux-recovery"), role, "legacy"), null, String(role));
    assert.equal(resolveAdminTabFor(adminNavItemTabs("amux-recovery"), role, "reservations"), null, String(role));
    assert.equal(resolveAdminTabFor(adminNavItemTabs("routing"), role, "stats"), null, String(role));
  }

  const settings = adminNavItemTabs("amux-settings");
  assert.equal(
    resolveAdminTabFor(settings, "owner", undefined).tab.id,
    "automatic-admission"
  );
  for (const role of [...NON_OWNER_ROLES, null]) {
    const opened = resolveAdminTabFor(settings, role, undefined);
    assert.equal(opened.tab.id, "workers", String(role));
    assert.deepEqual(
      opened.visible.map((tab) => tab.id),
      ["workers", "decision-maker"],
      String(role)
    );
    assert.equal(
      resolveAdminTabFor(settings, role, "automatic-admission"),
      null,
      String(role)
    );
    assert.equal(resolveAdminTabFor(settings, role, "analysis"), null, String(role));
  }
});

test("view roles never promise more than the pages grant, nor hide what they grant", () => {
  // Written out: the only entry the owner alone is shown is Ideas, and every
  // restricted section is one of these.
  const restrictedEntries = ADMIN_NAVIGATION.filter((item) => item.viewRoles).map((item) => item.id);
  assert.deepEqual(restrictedEntries, ["amux-backlog"]);
  const restrictedTabs = ADMIN_NAVIGATION.flatMap((item) =>
    (item.tabs || []).filter((tab) => tab.viewRoles).map((tab) => `${item.id}/${tab.id}`)
  );
  assert.deepEqual(restrictedTabs, [
    "routing/stats",
    "amux-execution/cards",
    "amux-settings/automatic-admission",
    "amux-settings/analysis",
    "amux-recovery/reservations",
    "amux-recovery/legacy",
  ]);
  for (const item of ADMIN_NAVIGATION) {
    for (const tab of item.tabs || []) {
      if (tab.viewRoles) assert.deepEqual(tab.viewRoles, ["owner"], `${item.id}/${tab.id}`);
    }
  }
  // Owner-only entry: its page refuses every other role on its own.
  const ideas = ADMIN_NAVIGATION.find((entry) => entry.id === "amux-backlog");
  assert.deepEqual(ideas.viewRoles, ["owner"]);
  assert.match(readPage("amux-backlog"), OWNER_GATE, "amux-backlog does not refuse a non-owner");
  // Execution opens to every role and refuses the board to a non-owner in the
  // board branch itself, before the list is read.
  const execution = ADMIN_NAVIGATION.find((entry) => entry.id === "amux-execution");
  assert.equal(execution.viewRoles, undefined);
  const cards = execution.tabs.find((tab) => tab.id === "cards");
  const review = execution.tabs.find((tab) => tab.id === "review");
  const settings = ADMIN_NAVIGATION.find((entry) => entry.id === "amux-settings");
  const automaticAdmission = settings.tabs.find(
    (tab) => tab.id === "automatic-admission"
  );
  const recovery = ADMIN_NAVIGATION.find((entry) => entry.id === "amux-recovery");
  const safety = recovery.tabs.find((tab) => tab.id === "safety");
  assert.deepEqual(cards.viewRoles, ["owner"]);
  assert.equal(review.viewRoles, undefined);
  assert.deepEqual(automaticAdmission.viewRoles, ["owner"]);
  assert.equal(safety.viewRoles, undefined);
  const page = readPage("amux-execution");
  const branchAt = page.indexOf('if (tab.id === "cards")');
  assert.ok(branchAt > 0, "the Execution page has a Cards branch");
  assert.doesNotMatch(page.slice(0, branchAt), OWNER_GATE);
  const cardsBranch = page.slice(branchAt);
  const gateAt = cardsBranch.search(OWNER_GATE);
  assert.ok(
    gateAt >= 0 && gateAt < cardsBranch.indexOf("listAmuxCardsForAdmin()"),
    "the Cards branch reads the list before refusing a non-owner"
  );
  assert.match(page, /if \(!resolved\) notFound\(\);/);
  // Settings keeps the readable surface for every role.
  const settingsPage = readPage("amux-settings");
  assert.equal(settings.viewRoles, undefined);
  assert.match(settingsPage, /isAdminSession\(session\)/);
  assert.match(settingsPage, /const isOwner = role === "owner";/);
  assert.match(settingsPage, /hasAdminPermission\(session, "ops:write"\)/);
  assert.match(settingsPage, /const resolved = resolveAdminTabFor\(TABS, role, query\.tab\);/);
  assert.ok(
    settingsPage.indexOf("if (!resolved) notFound();") <
      settingsPage.indexOf('if (tab.id === "automatic-admission")'),
    "the role-aware 404 precedes selection of the owner-only control"
  );
  assert.match(settingsPage, /<AmuxV22PromotionControl \/>/);
  // Safety & recovery: every role reads the halts, the owner alone clears one
  // and opens the other two sections, each refused before anything is read.
  const recoveryPage = readPage("amux-recovery");
  assert.equal(recovery.viewRoles, undefined);
  assert.match(recoveryPage, /isAdminSession\(session\)/);
  assert.match(recoveryPage, /canClear=\{isOwner\}/);
  assert.match(recoveryPage, /const isOwner = role === "owner";/);
  assert.match(recoveryPage, /readAmuxOrchestratorHaltsForAdmin\(\)\.catch\(\(\) => null\)/);
  assert.match(recoveryPage, /const resolved = resolveAdminTabFor\(TABS, role, query\.tab\);/);
  assert.match(recoveryPage, /if \(tab\.id === "legacy"\) \{\s*\/\/ Owner only[^\n]*\n\s*if \(!isOwner\) notFound\(\);/);
  assert.match(recoveryPage, /if \(tab\.id === "reservations"\) \{[\s\S]*?if \(!isOwner\) notFound\(\);/);
  // The statistics tab of Routing is refused to a non-owner by the page.
  const routingPage = readPage("routing");
  assert.match(routingPage, /resolveAdminTabFor\(TABS, role, query\.tab\)/);
  assert.match(routingPage, /role === "owner" \? <AdminAdaptiveStatisticsPanel \/> : notFound\(\)/);
  assert.match(page, /redirect\(adminRedirectTarget\(legacy, query\)\)/);
  assert.equal(adminIsVisibleTo("readonly", { viewRoles: ["owner"] }), false);
  assert.equal(adminIsVisibleTo("owner", { viewRoles: ["owner"] }), true);
  assert.equal(adminIsVisibleTo("readonly", {}), true);
});

test("Routing is the router, its optimizers, its shadow comparison and the owner's statistics", () => {
  const routing = ADMIN_NAVIGATION.find((item) => item.id === "routing");
  assert.equal(routing.group, "AI Platform");
  assert.equal(routing.aliases.includes("amux"), false);
  const execution = ADMIN_NAVIGATION.find((item) => item.id === "amux-execution");
  assert.ok(execution.aliases.includes("amux"));
  assert.ok(matchAdminPages("amux").some((page) => page.href === "/admin/amux-execution"));
  assert.equal(matchAdminPages("amux").some((page) => page.href === "/admin/routing"), false);

  const page = readPage("routing");
  assert.doesNotMatch(page, /AdminAmuxRoutingPanel/);
  assert.match(page, /<AdminRoutingShadowPanel \/>/);
  assert.match(page, /<AutoRouterTab canWrite=\{canWrite\} \/>/);
  assert.match(page, /href="\/admin\/amux-execution\?tab=review"/);
  assert.match(readPage("amux-execution"), /<AmuxOwnerQueueScreen canInspectCards=\{isOwner\} focusEscalationId=/);
});

test("execution board and Safety & recovery count distinct actions without duplicating halts", () => {
  const execution = ADMIN_NAVIGATION.find((item) => item.id === "amux-execution");
  const settings = ADMIN_NAVIGATION.find((item) => item.id === "amux-settings");
  const recovery = ADMIN_NAVIGATION.find((item) => item.id === "amux-recovery");
  // The entry and its "Waiting on me" tab show one number: the cards that wait
  // on the owner (lib/amux/ownerQueueCore.ts). Decision Maker requests keep the
  // Board tab's own chip.
  assert.equal(execution.badge, "amuxOwnerQueue");
  assert.equal(execution.tabs.find((tab) => tab.id === "review").badge, "amuxOwnerQueue");
  assert.equal(execution.tabs.find((tab) => tab.id === "review").label, "Waiting on me");
  assert.equal(execution.tabs.find((tab) => tab.id === "cards").badge, "amuxDecisionMaker");
  // Halts moved to Safety & recovery with execution safety, and only there.
  assert.equal(settings.badge, undefined);
  assert.equal(recovery.badge, "amuxOrchestratorHalts");
  assert.equal(recovery.tabs.find((tab) => tab.id === "safety").badge, "amuxOrchestratorHalts");
  const counts = { ...EMPTY_ADMIN_NAVIGATION_COUNTS, awaitingAmuxOwnerQueue: 14, openAmuxEscalations: 3,
    openAmuxOrchestratorHalts: 2, awaitingAmuxDecisionMaker: 4 };
  // One count for the sidebar entry and the tab; neither is a sum of other counts.
  assert.equal(adminNavigationBadge(execution.badge, counts), 14);
  assert.equal(
    adminNavigationBadge(execution.tabs.find((tab) => tab.id === "review").badge, counts),
    adminNavigationBadge(execution.badge, counts),
  );
  assert.equal(adminNavigationBadge("amuxDecisionMaker", counts), 4);
  assert.equal(adminNavigationBadge(execution.badge, { ...counts, awaitingAmuxDecisionMaker: null }), 14);
  assert.equal(adminNavigationBadge(recovery.badge, counts), 2);
  assert.equal(adminNavigationBadge(recovery.badge, { ...counts, openAmuxOrchestratorHalts: null }), null);
  // An unread count is no badge, never zero.
  assert.equal(adminNavigationBadge(execution.badge, { ...counts, awaitingAmuxOwnerQueue: null }), null);
  assert.equal(adminNavigationBadge(execution.badge, { ...counts, awaitingAmuxOwnerQueue: 0 }), 0);
  assert.equal(adminNavigationBadge(recovery.badge, EMPTY_ADMIN_NAVIGATION_COUNTS), null);
  // One definition of the set for the count and for the list it points at: the
  // layout badge, the page's tab badge and the list all go through
  // amuxOwnerQueueWhere, so a card counted is a card listed.
  const loader = loaderSource();
  const queueRead = readFileSync(join(process.cwd(), "lib", "amux", "adminOwnerQueueRead.ts"), "utf8");
  assert.match(loader, /countAmuxOwnerQueue\(\)/);
  assert.match(queueRead, /prisma\.amuxWorkItem\.count\(\{ where: amuxOwnerQueueWhere\(\) \}\)/);
  assert.match(queueRead, /const where = amuxOwnerQueueWhere\(\);/);
  assert.match(queueRead, /findMany\(\{\s*where, orderBy/);
  assert.match(queueRead, /take: AMUX_OWNER_QUEUE_LIMIT/);
  // The list is bounded and says so: its total counts the same set as the badge.
  assert.match(queueRead, /return \{ items, total, processedToday/);
  // The page's tab badge turns a failed read into no badge.
  assert.match(
    readPage("amux-execution"),
    /countAmuxOwnerQueue\(\)\.catch\(\(\) => null\)/
  );
  assert.match(
    readPage("amux-recovery"),
    /countOpenAmuxOrchestratorHalts\(\)\.catch\(\(\) => null\)/
  );
});

test("a tab strip never offers a section the viewer's role cannot open", () => {
  const strip = readFileSync(
    join(process.cwd(), "components", "admin", "AdminPageTabs.tsx"),
    "utf8"
  );
  assert.match(strip, /adminVisibleTabs\(/);
  // Every page with a restricted entry or section hands its strip the role.
  for (const item of ADMIN_NAVIGATION) {
    if (!item.viewRoles && !(item.tabs || []).some((tab) => tab.viewRoles)) continue;
    const page = readPage(item.href.replace("/admin/", ""));
    assert.match(page, /role=\{role\}/, `${item.id} does not pass the role to its tab strip`);
  }
});

test("the shell does not title a page the role cannot view", () => {
  for (const path of ["/admin/amux-backlog"]) {
    assert.equal(resolveAdminPageMeta(path, "owner").isKnown, true, path);
    for (const role of ADMIN_ROLE_ORDER.filter((r) => r !== "owner")) {
      const meta = resolveAdminPageMeta(path, role);
      assert.equal(meta.isKnown, false, `${path} for ${role}`);
      assert.equal(meta.label, "Admin Console");
    }
    // Unfiltered callers keep the entry.
    assert.equal(resolveAdminPageMeta(path).isKnown, true);
  }
  assert.equal(resolveAdminPageMeta("/admin/amux-execution", "support").isKnown, true);
  assert.equal(resolveAdminPageMeta("/admin/amux-recovery", "support").isKnown, true);
});

test("product research is its own workspace and the engineering agent's old tab link opens it", () => {
  const research = ADMIN_NAVIGATION.find((item) => item.id === "product-research");
  assert.equal(research.href, "/admin/product-research");
  assert.equal(research.group, "AI Agents");
  assert.equal(research.badge, "productResearch");
  assert.deepEqual(research.tabs.map((tab) => tab.id), ["suggestions", "runs", "observations"]);
  assert.equal(research.tabs[0].badge, "productResearch");
  assert.equal(
    adminNavigationBadge("productResearch", { ...EMPTY_ADMIN_NAVIGATION_COUNTS, openProductResearchSuggestions: 42 }),
    42
  );
  assert.equal(adminNavigationBadge("productResearch", EMPTY_ADMIN_NAVIGATION_COUNTS), null);

  // The tab moved, so the engineering agent no longer offers it, and the old
  // link lands on what it showed in production -- the observation record --
  // with the rest of its query.
  assert.equal(adminNavItemTabs("engineering-agent").some((tab) => tab.id === "product-research"), false);
  assert.equal(
    ADMIN_ENGINEERING_AGENT_LEGACY_TABS["product-research"],
    "/admin/product-research?tab=observations"
  );
  assert.equal(
    adminRedirectTarget(ADMIN_ENGINEERING_AGENT_LEGACY_TABS["product-research"], { tab: "product-research", from: "office" }),
    "/admin/product-research?tab=observations&from=office"
  );
  const page = readFileSync(join(process.cwd(), "app/(site)/(application)/admin/engineering-agent/page.tsx"), "utf8");
  assert.ok(page.includes("ADMIN_ENGINEERING_AGENT_LEGACY_TABS[query.tab]"));
  assert.ok(page.includes("redirect(adminRedirectTarget(legacy, query))"));
});

test("the engineering agent's pull requests and marketing's extra sections stay reachable as views", () => {
  // Runs & PRs holds the pull request record as a view; Marketing keeps its
  // competitors, experiments, assets and comment alerts as views of the tab
  // each belongs to. Nothing the old screens showed is unreachable.
  assert.equal(
    ADMIN_ENGINEERING_AGENT_LEGACY_TABS["pull-requests"],
    "/admin/engineering-agent?tab=runs&view=pull-requests"
  );
  assert.deepEqual(ADMIN_MARKETING_LEGACY_TABS, {
    competitors: "/admin/marketing?tab=reports&view=competitors",
    assets: "/admin/marketing?tab=queue&view=assets",
    experiments: "/admin/marketing?tab=reports&view=experiments",
    comments: "/admin/marketing?tab=queue&view=comments",
  });
  const marketing = readPage("marketing");
  assert.ok(marketing.includes("ADMIN_MARKETING_LEGACY_TABS[query.tab]"));
  assert.ok(marketing.includes("redirect(adminRedirectTarget(legacy, query))"));
});

test("Release holds QA and release, the merge lane, the train and the CI queue; the old addresses redirect to it", () => {
  assert.deepEqual(adminNavItemTabs("release").map((tab) => tab.id), ["qa", "ci"]);
  assert.deepEqual(
    Object.keys(ADMIN_QA_RELEASE_LEGACY_TABS),
    ["overview", "train", "lane", "ci-admission"]
  );
  const page = readPage("release");
  // The three views the QA tab holds, and the CI section on its own tab.
  assert.match(page, /const QA_VIEWS = \["overview", "train", "lane"\] as const;/);
  assert.match(page, /<CiAdmissionSection key=\{tab\.id\}/);
  assert.match(page, /<AdminAgentDigestsPanel/);
  const legacy = readPage("qa-release");
  assert.ok(legacy.includes("ADMIN_QA_RELEASE_LEGACY_TABS[tab]"));
  // The step-up returns of the components point at the new addresses.
  for (const file of [
    "AdminAgentDigestsPanel.tsx",
    "QaReleaseMergeLaneSection.tsx",
    "CiAdmissionSection.tsx",
    "QaReleaseTrainCargoSection.tsx",
    "QaReleaseTrainEmergencySection.tsx",
    "qaReleaseTabParts.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), "components/admin", file), "utf8");
    assert.doesNotMatch(source, /\/admin\/qa-release/, `${file} still links the retired address`);
  }
  // Billing and finance is its own agent page, with the panel it had.
  const finance = readPage("finance-agent");
  assert.match(finance, /<AdminBillingFinanceOpsDigestsPanel/);
  assert.match(finance, /hasAdminPermission\(session, "ops:write"\)/);
});

test("legacy execution controls retain their exact section and query", () => {
  assert.deepEqual(ADMIN_AMUX_EXECUTION_LEGACY_TABS, {
    assignment: "/admin/amux-execution?tab=review",
    halts: "/admin/amux-recovery?tab=safety",
    "decision-maker": "/admin/amux-settings?tab=decision-maker",
    workers: "/admin/amux-settings?tab=workers",
  });
  assert.equal(adminRedirectTarget(ADMIN_AMUX_EXECUTION_LEGACY_TABS.halts, {tab:"halts", taskId:"task-1"}), "/admin/amux-recovery?tab=safety&taskId=task-1");
  // The old Workers address keeps the request's own query and drops its stale tab.
  assert.equal(
    adminRedirectTarget(ADMIN_AMUX_EXECUTION_LEGACY_TABS.workers, { tab: "workers", from: "office" }),
    "/admin/amux-settings?tab=workers&from=office"
  );
  // The review queue's old name keeps the escalation focus the links carry.
  assert.equal(
    adminRedirectTarget(ADMIN_AMUX_EXECUTION_LEGACY_TABS.assignment, { tab: "assignment", focusEscalation: "cabc" }),
    "/admin/amux-execution?tab=review&focusEscalation=cabc"
  );
  assert.equal(adminNavItemTabs("amux-execution").some((tab) => tab.id === "workers"), false);
  assert.equal(adminNavItemTabs("amux-execution").some((tab) => tab.id === "assignment"), false);
  assert.equal(adminNavItemTabs("amux-settings").some((tab) => tab.id === "safety"), false);
  const executionPage = readFileSync(join(process.cwd(), "app/(site)/(application)/admin/amux-execution/page.tsx"), "utf8");
  assert.ok(executionPage.includes("ADMIN_AMUX_EXECUTION_LEGACY_TABS[query.tab]"));
  assert.ok(executionPage.includes("redirect(adminRedirectTarget(legacy, query))"));
  assert.doesNotMatch(executionPage, /AmuxWorker/);
  const settingsPage = readFileSync(join(process.cwd(), "app/(site)/(application)/admin/amux-settings/page.tsx"), "utf8");
  assert.ok(settingsPage.includes('tab.id === "workers"'));
  assert.ok(settingsPage.includes("ADMIN_AMUX_SETTINGS_LEGACY_TABS[query.tab]"));
  assert.doesNotMatch(settingsPage, /AmuxOrchestratorHaltsPanel/);
  const backlogPage = readPage("amux-backlog");
  assert.ok(backlogPage.includes("ADMIN_AMUX_BACKLOG_LEGACY_TABS[requestedTab]"));
  assert.doesNotMatch(backlogPage, /AmuxBoardImportPanel|AmuxReconciliationPanel|AmuxBacklogMetadataPanel/);
});

test("the legacy tools tab holds every panel the retired pages held, each behind its own switch", () => {
  const page = readPage("amux-recovery");
  for (const panel of [
    "AmuxBoardImportPanel",
    "AmuxReconciliationPanel",
    "AmuxBacklogMetadataPanel",
    "AmuxBoardRecommendationPanel",
    "AmuxBoardPromotionPanel",
    "AmuxBoardAutoPromotionPanel",
  ]) {
    assert.ok(page.includes(`<${panel} />`), `${panel} is not on the Legacy tools tab`);
  }
  assert.match(
    page,
    /const LEGACY_SECTIONS = \[\s*"import",\s*"reconciliation",\s*"metadata",\s*"recommendation",\s*"promotion",\s*"auto-promotion",\s*\] as const;/
  );
  assert.ok(page.includes("amuxSwitchedTabStatuses(LEGACY_SECTIONS)"));
  // Each panel's step-up returns to the tab, not to a retired address.
  for (const file of [
    "AmuxBoardImportPanel",
    "AmuxReconciliationPanel",
    "AmuxBacklogMetadataPanel",
    "AmuxBoardRecommendationPanel",
    "AmuxBoardPromotionPanel",
    "AmuxBoardAutoPromotionPanel",
  ]) {
    const source = readFileSync(join(process.cwd(), "components/admin", `${file}.tsx`), "utf8");
    assert.match(source, /adminRecentAuthenticationHref\("\/admin\/amux-recovery\?tab=legacy"\)/, file);
  }
  // The halts panel's step-up returns to its new section.
  assert.match(
    readFileSync(join(process.cwd(), "components/admin/AmuxOrchestratorHaltsPanel.tsx"), "utf8"),
    /const RETURN_TO = "\/admin\/amux-recovery\?tab=safety";/
  );
});

test("the local intake panel nothing imports is gone, and the U21 test card's panel stays", () => {
  assert.throws(() => statSync(join(process.cwd(), "components/admin/AmuxLocalIntakePanel.tsx")));
  // The U21 test card page imports the registration panel, so it is not dead.
  assert.match(
    readFileSync(join(process.cwd(), "app/(site)/(application)/admin/amux-u21-test-card/page.tsx"), "utf8"),
    /AmuxIntakePanel/
  );
});

test("the retired Support tab still lands on the inbox", () => {
  const tabs = adminNavItemTabs("support");
  assert.deepEqual(tabs.map((tab) => tab.id), ["feedback", "autofix", "privacy"]);
  assert.equal(resolveAdminTab(tabs, "fixes").id, "feedback");
});

test("Billing's sections are addresses, not component state", () => {
  assert.deepEqual(adminNavItemTabs("billing").map((tab) => tab.id), ["plans", "prices", "promotions", "diagnostics"]);
  const page = readPage("billing");
  assert.match(page, /initialTab=\{tab\.id as "plans" \| "prices" \| "promotions"\}/);
  // The panel draws no tab strip and keeps no tab state of its own: the screen is whatever `?tab=` says.
  const panel = readFileSync(join(process.cwd(), "components/admin/BillingAdminPanel.tsx"), "utf8");
  assert.match(panel, /const activeTab = initialTab;/);
  assert.doesNotMatch(panel, /urlTabs|setActiveTab/);
});

test("Platform's default models are Models' Default models tab", () => {
  assert.deepEqual(adminNavItemTabs("platform").map((tab) => tab.id), ["emergency", "features", "account-defaults"]);
  assert.match(readPage("models"), /<PlatformSettingsPanel view="default-models"/);
  const platform = readPage("platform");
  assert.match(platform, /view=\{tab\.id as "emergency" \| "features" \| "account-defaults"\}/);
  const registry = readFileSync(join(process.cwd(), "components/admin/AdminModelRegistryPanel.tsx"), "utf8");
  assert.doesNotMatch(registry, /\/admin\/platform#default-models/);
  // The route saves the nine flags together, so a tab sends its own sections'
  // values and reads the rest from the server when Save is pressed: a tab
  // opened before another operator engaged an emergency stop must not write
  // the old value back, and a failed read saves nothing.
  const panel = readFileSync(join(process.cwd(), "components/admin/PlatformSettingsPanel.tsx"), "utf8");
  const save = panel.slice(panel.indexOf("const save = async"), panel.indexOf("const data = (await response.json()", panel.indexOf("const save = async")));
  assert.match(save, /if \(!\(show\("emergency"\) && show\("features"\)\)\) \{\s*const currentResponse = await adminFetch\("\/api\/admin\/app-settings", \{ cache: "no-store" \}\);/);
  assert.match(save, /if \(!readable\) \{\s*dispatchAppToast\(m\.toast\.notSaved, "error"\);\s*return;/);
  assert.match(save, /const emergency = show\("emergency"\) \|\| !current\?\.settings\s*\? \{ aiChatEnabled, attachmentsEnabled, publicSharingEnabled \}/);
  assert.match(save, /const rollout = show\("features"\) \|\| !current/);
  assert.match(save, /body: JSON\.stringify\(\{ \.\.\.emergency, \.\.\.rollout \}\)/);
  // The route still takes all nine together (its own rule, unchanged).
  assert.match(
    readFileSync(join(process.cwd(), "app/api/admin/app-settings/route.ts"), "utf8"),
    /Feature flags are saved together\./
  );
  // The old hash link is moved on in the browser.
  assert.match(panel, /window\.location\.hash === "#default-models"/);
  assert.match(panel, /router\.replace\("\/admin\/models\?tab=defaults#default-models"\)/);
});

test("the audit integrity check is the Audit log's, and its old address redirects", () => {
  assert.deepEqual(adminNavItemTabs("audit").map((tab) => tab.id), ["log", "integrity"]);
  assert.deepEqual(adminNavItemTabs("admin-access").map((tab) => tab.id), ["administrators", "readiness"]);
  assert.match(readPage("audit"), /<AdminAuditIntegrityPanel \/>/);
  assert.doesNotMatch(readPage("admin-access"), /AdminAuditIntegrityPanel/);
});
