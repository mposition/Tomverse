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
  assert.match(page, /listAmuxCardsForExecutionList\(\)/);
  assert.equal(ADMIN_LEGACY_ROUTES["/admin/amux-cards"], "/admin/amux-execution?tab=cards");
  const meta = resolveAdminPageMeta("/admin/amux-execution");
  assert.equal(meta.isKnown, true);
  assert.equal(meta.label, "Execution board");
  const cards = adminNavItemTabs("amux-execution").find((tab) => tab.id === "cards");
  assert.equal(cards?.label, "Board");
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

test("the list view states how many rows it shows out of how many and opens a row in the card detail", async () => {
  const panel = await read("components/admin/AmuxCardListPanel.tsx");
  assert.match(panel, /messages\.shown\(rows\.length, total, limit\)/);
  assert.match(panel, /<AdminDataTable /);
  // A row only opens the card; the table itself reads and writes nothing.
  assert.match(panel, /onOpen\(row\.id, event\.currentTarget\)/);
  assert.doesNotMatch(panel, /\bfetch\s*\(|adminFetch|method:/);
  // The Task ID, the source key and the brief are not columns; the card detail has them.
  assert.doesNotMatch(panel, /columnBrief|sourceKey\}|row\.briefPresent/);
  // What the old table offered per row is in the card detail: the worker result, and a waiting worker question with its answer form.
  const workspace = await read("components/admin/AmuxExecutionWorkspace.tsx");
  assert.match(workspace, /<AmuxTaskQuestionSection key=\{selected\.id/);
  assert.match(workspace, /selected\.result\?\.state === "available" && selected\.result\.text/);
  assert.match(workspace, /<AmuxCardListPanel rows=\{cardList\.rows\}/);
  assert.match(workspace, /\{view === "list" && cardList !== undefined/);
});

test("the list view's loader adds a title and a worker to the owner list and writes nothing", async () => {
  const loader = await read("lib/amux/adminExecutionCardList.ts");
  assert.match(loader, /listAmuxCardsForAdmin\(\)/);
  // The title is read the way the board reads it: digest-verified, or null.
  assert.match(loader, /readAmuxCardTitle/);
  assert.match(loader, /v22AcceptedAssignment: \{ select: \{ workerName: true \} \}/);
  assert.doesNotMatch(loader, /\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\(/);
});
