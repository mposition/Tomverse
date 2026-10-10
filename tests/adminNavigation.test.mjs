import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_DETAIL_ROUTES,
  ADMIN_LEGACY_ROUTES,
  ADMIN_LEGACY_TAB_ROUTES,
  ADMIN_NAVIGATION,
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ITEMS_BY_GROUP,
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

test("the navigation is seven groups of unique, non-empty entries", () => {
  assert.equal(ADMIN_NAV_ITEMS_BY_GROUP.length, ADMIN_NAV_GROUPS.length);
  for (const group of ADMIN_NAV_ITEMS_BY_GROUP) {
    assert.ok(group.items.length > 0, `${group.label} has no entries`);
  }
  const hrefs = ADMIN_NAVIGATION.map((item) => item.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "duplicate navigation href");
  const ids = ADMIN_NAVIGATION.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate navigation id");
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
  const liveHrefs = new Set([
    ...ADMIN_NAVIGATION.map((item) => item.href),
    ...ADMIN_UNLISTED_PAGES.map((page) => page.href),
  ]);
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
    assert.ok(liveHrefs.has(path), `${from} points at ${path}, which is not a page`);
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
  const liveHrefs = new Set([
    ...ADMIN_NAVIGATION.map((item) => item.href),
    ...ADMIN_UNLISTED_PAGES.map((page) => page.href),
  ]);
  for (const [tab, destination] of Object.entries(ADMIN_LEGACY_TAB_ROUTES)) {
    const [path] = destination.split("?");
    assert.ok(liveHrefs.has(path), `?tab=${tab} points at ${path}`);
  }
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

test("the global search workspace is titled Global search, not Overview", () => {
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
});

test("the palette can reach every page, including the unlisted ones", () => {
  const pages = new Set(ADMIN_SEARCHABLE_PAGES.map((page) => page.href));
  for (const item of ADMIN_NAVIGATION) assert.ok(pages.has(item.href));
  for (const page of ADMIN_UNLISTED_PAGES) assert.ok(pages.has(page.href));
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

  assert.deepEqual(matchAdminPages("   "), []);
});

test("a stale or missing ?tab= falls back to the page's first section", () => {
  const tabs = adminNavItemTabs("providers");
  assert.equal(resolveAdminTab(tabs, undefined).id, tabs[0].id);
  assert.equal(resolveAdminTab(tabs, "not-a-tab").id, tabs[0].id);
  assert.equal(resolveAdminTab(tabs, "incidents").id, "incidents");
  assert.equal(resolveAdminTab(tabs, ["usage-cost"]).id, "usage-cost");
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

test("the discovery backlog keeps a way in", () => {
  // The finding this whole surface answers is that discovery wrote its results
  // to a table nothing read. A tab removed, a badge unwired or a renamed id
  // would put it back there, so the path is pinned rather than assumed.
  const models = ADMIN_NAVIGATION.find((item) => item.id === "models");
  assert.ok(models, "the models entry exists");
  assert.equal(models.badge, "modelLifecycle");
  assert.deepEqual(
    models.tabs?.map((tab) => tab.id),
    ["registry", "discovery"]
  );
  // The registry stays the default: an operator opening /admin/models is far
  // more often there for the catalogue than for the backlog.
  assert.equal(resolveAdminTab(adminNavItemTabs("models"), undefined).id, "registry");
  assert.equal(resolveAdminTab(adminNavItemTabs("models"), "discovery").id, "discovery");
});

// ---------------------------------------------------------------------------
// The AMUX group and view roles
// ---------------------------------------------------------------------------

const readPage = (segment) =>
  readFileSync(join(ADMIN_ROUTE_ROOT, segment, "page.tsx"), "utf8");

const loaderSource = () =>
  readFileSync(join(process.cwd(), "lib", "adminNavigationCounts.ts"), "utf8");

const OWNER_GATE =
  /if \(!session\?\.user\?\.id \|\| getAdminRole\(session\) !== "owner"\) notFound\(\);/;

const NON_OWNER_ROLES = ADMIN_ROLE_ORDER.filter((role) => role !== "owner");

test("the AMUX group holds Backlog, Promotion and Execution, with their sections", () => {
  const group = ADMIN_NAV_ITEMS_BY_GROUP.find((entry) => entry.label === "AMUX");
  assert.ok(group, "the AMUX group exists");
  assert.deepEqual(
    group.items.map((item) => [item.id, item.label, item.href]),
    [
      ["amux-backlog", "Backlog", "/admin/amux-backlog"],
      ["amux-promotion", "Promotion", "/admin/amux-promotion"],
      ["amux-execution", "Execution", "/admin/amux-execution"],
    ]
  );
  assert.deepEqual(
    adminNavItemTabs("amux-backlog").map((tab) => tab.id),
    ["ideas", "import", "reconciliation", "metadata"]
  );
  assert.deepEqual(
    adminNavItemTabs("amux-promotion").map((tab) => tab.id),
    ["recommendation", "promotion", "auto-promotion"]
  );
  assert.deepEqual(
    adminNavItemTabs("amux-execution").map((tab) => tab.id),
    ["cards", "assignment", "halts"]
  );
  // Between Operations and Governance.
  assert.deepEqual(
    ADMIN_NAV_GROUPS.slice(
      ADMIN_NAV_GROUPS.indexOf("Operations"),
      ADMIN_NAV_GROUPS.indexOf("Governance") + 1
    ),
    ["Operations", "AMUX", "Governance"]
  );
});

test("each of the eight AMUX screens redirects to its current section", () => {
  // Written out rather than read back from the table: these are the addresses
  // policy documents, runbooks and audit summaries already name.
  const expected = {
    "/admin/amux-intake": "/admin/amux-backlog?tab=ideas",
    "/admin/amux-board-import": "/admin/amux-backlog?tab=import",
    "/admin/amux-reconciliation": "/admin/amux-backlog?tab=reconciliation",
    "/admin/amux-backlog-metadata": "/admin/amux-backlog?tab=metadata",
    "/admin/amux-board-recommendation": "/admin/amux-promotion?tab=recommendation",
    "/admin/amux-board-promotion": "/admin/amux-promotion?tab=promotion",
    "/admin/amux-board-auto-promotion": "/admin/amux-promotion?tab=auto-promotion",
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
});

test("the owner sees the whole AMUX group; every other role sees Execution's Assignment and Halts only", () => {
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

  for (const role of NON_OWNER_ROLES) {
    const visible = adminNavigationFor(role);
    const amux = visible.filter((item) => item.group === "AMUX");
    assert.deepEqual(amux.map((item) => item.id), ["amux-execution"], `${role}: AMUX entries`);
    // Halts (orchestration policy version 20, section 7) is read by every
    // role the Execution badge counts it for; only the owner may clear one.
    assert.deepEqual(
      amux[0].tabs.map((tab) => tab.id),
      ["assignment", "halts"],
      `${role}: Execution sections`
    );
    // Nothing outside AMUX moves for this role.
    assert.deepEqual(
      visible.filter((item) => item.group !== "AMUX").map((item) => item.id),
      ADMIN_NAVIGATION.filter((item) => item.group !== "AMUX").map((item) => item.id),
      `${role}: entries outside AMUX`
    );
    const group = adminNavItemsByGroupFor(role).find((entry) => entry.label === "AMUX");
    assert.deepEqual(group.items.map((item) => item.id), ["amux-execution"]);
  }
});

test("a role that cannot be determined sees only what every role sees", () => {
  for (const role of [null, undefined]) {
    assert.deepEqual(
      adminNavigationFor(role)
        .filter((item) => item.group === "AMUX")
        .map((item) => [item.id, item.tabs.map((tab) => tab.id)]),
      [["amux-execution", ["assignment", "halts"]]]
    );
  }
});

test("the palette, pins and recents do not offer a non-owner the owner's AMUX pages", () => {
  for (const role of NON_OWNER_ROLES) {
    const hrefs = adminSearchablePagesFor(role).map((page) => page.href);
    assert.equal(hrefs.includes("/admin/amux-backlog"), false, role);
    assert.equal(hrefs.includes("/admin/amux-promotion"), false, role);
    assert.equal(hrefs.includes("/admin/amux-execution"), true, role);
    for (const locale of ["en", "ko"]) {
      assert.deepEqual(
        localizedAdminSearchablePages(locale, role).map((page) => page.href),
        hrefs,
        `${role}/${locale}`
      );
    }

    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-backlog"), false);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-promotion?tab=promotion"), false);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-execution"), true);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-execution?tab=assignment"), true);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-execution?tab=cards"), false);
    // A page outside the table is left to the caller's own rule.
    assert.equal(adminHrefIsVisibleTo(role, "/admin/search"), true);
    assert.equal(adminHrefIsVisibleTo(role, "/admin/refunds"), true);
  }
  const ownerHrefs = adminSearchablePagesFor("owner").map((page) => page.href);
  for (const href of ["/admin/amux-backlog", "/admin/amux-promotion", "/admin/amux-execution"]) {
    assert.ok(ownerHrefs.includes(href), href);
    assert.equal(adminHrefIsVisibleTo("owner", href), true);
  }
  assert.equal(adminHrefIsVisibleTo("owner", "/admin/amux-execution?tab=cards"), true);
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

test("Execution opens on Cards for the owner and on Assignment for everyone else", () => {
  const tabs = adminNavItemTabs("amux-execution");
  assert.equal(resolveAdminTabFor(tabs, "owner", undefined).tab.id, "cards");
  assert.equal(resolveAdminTabFor(tabs, "owner", "assignment").tab.id, "assignment");
  assert.equal(resolveAdminTabFor(tabs, "owner", "not-a-tab").tab.id, "cards");
  for (const role of [...NON_OWNER_ROLES, null]) {
    const opened = resolveAdminTabFor(tabs, role, undefined);
    assert.equal(opened.tab.id, "assignment", String(role));
    assert.deepEqual(opened.visible.map((tab) => tab.id), ["assignment", "halts"]);
    assert.equal(resolveAdminTabFor(tabs, role, "halts").tab.id, "halts", String(role));
    // A stale value that names no section still falls back...
    assert.equal(resolveAdminTabFor(tabs, role, "not-a-tab").tab.id, "assignment");
    // ...but naming the owner's section is a 404, not a silent substitute.
    assert.equal(resolveAdminTabFor(tabs, role, "cards"), null, String(role));
    assert.equal(resolveAdminTabFor(tabs, role, ["cards"]), null, String(role));
  }
});

test("view roles never promise more than the pages grant, nor hide what they grant", () => {
  // Owner-only entries: each page refuses every other role on its own.
  for (const id of ["amux-backlog", "amux-promotion"]) {
    const item = ADMIN_NAVIGATION.find((entry) => entry.id === id);
    assert.deepEqual(item.viewRoles, ["owner"], id);
    assert.match(readPage(id), OWNER_GATE, `${id} does not refuse a non-owner`);
  }
  // Execution opens to every role and refuses Cards to a non-owner in the
  // Cards branch itself, before the list is read.
  const execution = ADMIN_NAVIGATION.find((entry) => entry.id === "amux-execution");
  assert.equal(execution.viewRoles, undefined);
  const cards = execution.tabs.find((tab) => tab.id === "cards");
  const assignment = execution.tabs.find((tab) => tab.id === "assignment");
  const halts = execution.tabs.find((tab) => tab.id === "halts");
  assert.deepEqual(cards.viewRoles, ["owner"]);
  assert.equal(assignment.viewRoles, undefined);
  assert.equal(halts.viewRoles, undefined);
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
  // The Halts branch opens to every role and offers the clear to the owner
  // only; it never refuses a role the tab strip shows it to.
  const haltsAt = page.indexOf('if (tab.id === "halts")');
  assert.ok(haltsAt > 0, "the Execution page has a Halts branch");
  const haltsBranch = page.slice(haltsAt, page.indexOf("<AdminAmuxRoutingPanel />"));
  assert.doesNotMatch(haltsBranch, /notFound\(/);
  assert.match(haltsBranch, /canClear=\{isOwner\}/);
  assert.match(page, /const isOwner = Boolean\(session\?\.user\?\.id\) && role === "owner";/);
  // Every other entry is still open to every role.
  for (const item of ADMIN_NAVIGATION) {
    if (item.group === "AMUX") continue;
    assert.equal(item.viewRoles, undefined, item.id);
    for (const tab of item.tabs || []) {
      assert.equal(tab.viewRoles, undefined, `${item.id}/${tab.id}`);
    }
  }
  assert.equal(adminIsVisibleTo("readonly", { viewRoles: ["owner"] }), false);
  assert.equal(adminIsVisibleTo("owner", { viewRoles: ["owner"] }), true);
  assert.equal(adminIsVisibleTo("readonly", {}), true);
});

test("Routing keeps Chat shadow routing and points at where AMUX assignment went", () => {
  const routing = ADMIN_NAVIGATION.find((item) => item.id === "routing");
  assert.equal(routing.description, "Chat shadow routing");
  assert.equal(routing.aliases.includes("amux"), false);
  const execution = ADMIN_NAVIGATION.find((item) => item.id === "amux-execution");
  assert.ok(execution.aliases.includes("amux"));
  assert.ok(matchAdminPages("amux").some((page) => page.href === "/admin/amux-execution"));
  assert.equal(matchAdminPages("amux").some((page) => page.href === "/admin/routing"), false);

  const page = readPage("routing");
  assert.doesNotMatch(page, /AdminAmuxRoutingPanel/);
  assert.match(page, /<AdminRoutingShadowPanel \/>/);
  assert.match(page, /href="\/admin\/amux-execution\?tab=assignment"/);
  assert.match(readPage("amux-execution"), /<AdminAmuxRoutingPanel focusEscalationId=/);
});

test("the Execution badge counts the escalations the Assignment section lists and the open halts", () => {
  const execution = ADMIN_NAVIGATION.find((item) => item.id === "amux-execution");
  // Orchestration policy version 20, section 7: the entry's badge is the
  // escalation count plus the open orchestrator halt count, and the Halts tab
  // carries the halt count alone.
  assert.equal(execution.badge, "amuxExecution");
  assert.equal(execution.tabs.find((tab) => tab.id === "assignment").badge, "amuxEscalations");
  assert.equal(execution.tabs.find((tab) => tab.id === "halts").badge, "amuxOrchestratorHalts");
  assert.equal(adminNavigationBadge("amuxOrchestratorHalts", EMPTY_ADMIN_NAVIGATION_COUNTS), null);
  assert.equal(
    adminNavigationBadge("amuxOrchestratorHalts", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      openAmuxOrchestratorHalts: 2,
    }),
    2
  );
  assert.equal(
    adminNavigationBadge("amuxExecution", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      openAmuxEscalations: 3,
      openAmuxOrchestratorHalts: 2,
    }),
    5
  );
  // A halt count that could not be read is no badge on the entry, not the
  // escalations alone: that figure would read as "no halt".
  assert.equal(
    adminNavigationBadge("amuxExecution", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      openAmuxEscalations: 3,
    }),
    null
  );
  assert.equal(
    adminNavigationBadge("amuxExecution", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      openAmuxOrchestratorHalts: 2,
    }),
    null
  );
  assert.match(
    readPage("amux-execution"),
    /countOpenAmuxOrchestratorHalts\(\)\.catch\(\(\) => null\)/
  );
  assert.match(loaderSource(), /countOpenAmuxOrchestratorHalts\(\),/);
  // An unknown count is no badge; zero is zero.
  assert.equal(adminNavigationBadge("amuxEscalations", EMPTY_ADMIN_NAVIGATION_COUNTS), null);
  assert.equal(
    adminNavigationBadge("amuxEscalations", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      openAmuxEscalations: 0,
    }),
    0
  );
  assert.equal(
    adminNavigationBadge("amuxEscalations", {
      ...EMPTY_ADMIN_NAVIGATION_COUNTS,
      openAmuxEscalations: 4,
    }),
    4
  );
  // One status list for the count and for the list it points at.
  const loader = loaderSource();
  const report = readFileSync(join(process.cwd(), "lib", "amux", "explainability.ts"), "utf8");
  const sameWhere =
    /where: \{ status: \{ in: \[\.\.\.AMUX_ESCALATION_AWAITING_STATUSES\] \} \}/;
  assert.match(loader.slice(loader.indexOf("amuxHumanEscalation.count(")), sameWhere);
  assert.match(report.slice(report.indexOf("amuxHumanEscalation.findMany(")), sameWhere);
  // The list is bounded and says so: its total counts the same set as the badge.
  assert.match(report.slice(report.indexOf("amuxHumanEscalation.count(")), sameWhere);
  assert.match(report, /take: AMUX_ESCALATION_LIST_LIMIT/);
  assert.match(report, /escalations_total: escalationsTotal/);
  // The page's tab badge turns a failed read into no badge.
  assert.match(
    readPage("amux-execution"),
    /countAwaitingAmuxEscalations\(\)\.catch\(\(\) => null\)/
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
  for (const path of ["/admin/amux-backlog", "/admin/amux-promotion"]) {
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
});
