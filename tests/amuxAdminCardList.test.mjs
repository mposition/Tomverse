import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ADMIN_LEGACY_ROUTES,
  ADMIN_SEARCHABLE_PAGES,
  adminHrefIsVisibleTo,
  adminNavItemTabs,
  resolveAdminPageMeta,
} from "../lib/adminNavigation.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the AMUX card list is an owner-only section that is not advertised to other roles", async () => {
  // The list moved from /admin/amux-cards to Execution's Cards section, and
  // the old address redirects there.
  const page = await read("app/(site)/(application)/admin/amux-execution/page.tsx");
  assert.match(page, /getAdminRole\(session\) !== "owner"\) notFound\(\)/);
  assert.match(page, /listAmuxCardsForAdmin\(\)/);
  assert.equal(ADMIN_LEGACY_ROUTES["/admin/amux-cards"], "/admin/amux-execution?tab=cards");
  const meta = resolveAdminPageMeta("/admin/amux-execution");
  assert.equal(meta.isKnown, true);
  assert.equal(meta.label, "Execution");
  const cards = adminNavItemTabs("amux-execution").find((tab) => tab.id === "cards");
  assert.equal(cards?.label, "Cards");
  assert.deepEqual(cards?.viewRoles, ["owner"]);
  for (const role of ["billing", "support", "ops", "readonly"]) {
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-execution?tab=cards"), false, role);
  }
  assert.equal(ADMIN_SEARCHABLE_PAGES.some((entry) => entry.href === "/admin/amux-cards"), false);
});

test("the card list reads identifiers and state only", async () => {
  const loader = await read("lib/amux/adminCardList.ts");
  const select = loader.slice(loader.indexOf("select: {"), loader.indexOf("]);"));
  for (const forbidden of ["executionBrief:", "description:", "title:", "sourceSnapshot:", "classification:", "reason:"]) {
    assert.equal(select.includes(forbidden), false, forbidden);
  }
  assert.match(select, /executionBriefDigest: true/);
  assert.match(loader, /take: AMUX_ADMIN_CARD_LIST_LIMIT/);
  assert.doesNotMatch(loader, /\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\(/);
  // One set query per page for the latest attempt and one for the counts.
  assert.doesNotMatch(loader, /executionAttempts: \{/);
  assert.match(loader, /SELECT DISTINCT ON \("taskId"\)/);
  // The pg adapter sends parameters untyped; an uncast array is refused.
  assert.match(loader, /ANY\(\$\{ids\}::text\[\]\)/);
  assert.match(loader, /groupBy\(\{\s*by: \["taskId"\]/);
});

test("the panel states how many rows it shows out of how many", async () => {
  const panel = await read("components/admin/AmuxCardListPanel.tsx");
  assert.match(panel, /messages\.shown\(rows\.length, total, limit\)/);
  assert.match(panel, /adminFetch\(`\/api\/admin\/amux\/v22-task-result/);
  assert.match(panel, /const requestId = \+\+resultRequestId\.current/);
  assert.equal((panel.match(/if \(requestId !== resultRequestId\.current\) return;/g) ?? []).length, 2);
  assert.doesNotMatch(panel, /\bfetch\s*\(/);
});
