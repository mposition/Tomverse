import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_LEGACY_ROUTES,
  ADMIN_LEGACY_TAB_ROUTES,
  ADMIN_NAVIGATION,
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ITEMS_BY_GROUP,
  ADMIN_SEARCHABLE_PAGES,
  ADMIN_UNLISTED_PAGES,
  adminItemIsWritable,
  adminNavItemTabs,
  adminRedirectTarget,
  findAdminNavItem,
  matchAdminPages,
  resolveAdminPageMeta,
  resolveAdminTab,
} from "../lib/adminNavigation.ts";
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

test("the navigation is six groups of unique, non-empty entries", () => {
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
});
