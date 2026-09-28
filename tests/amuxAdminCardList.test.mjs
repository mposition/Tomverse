import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ADMIN_SEARCHABLE_PAGES, resolveAdminPageMeta } from "../lib/adminNavigation.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the AMUX card list is an owner-only detail route that is not advertised", async () => {
  const page = await read("app/(site)/(application)/admin/amux-cards/page.tsx");
  assert.match(page, /getAdminRole\(session\) !== "owner"\) notFound\(\)/);
  assert.match(page, /await listAmuxCardsForAdmin\(\)/);
  const meta = resolveAdminPageMeta("/admin/amux-cards");
  assert.equal(meta.isKnown, true);
  assert.equal(meta.label, "AMUX cards");
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
});

test("the panel states how many rows it shows out of how many", async () => {
  const panel = await read("components/admin/AmuxCardListPanel.tsx");
  assert.match(panel, /messages\.shown\(rows\.length, total, limit\)/);
  assert.doesNotMatch(panel, /adminFetch|fetch\(/);
});
