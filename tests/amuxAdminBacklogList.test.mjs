import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { amuxBacklogHref, amuxBacklogPage, amuxBacklogSearch,
  amuxBacklogSummary, amuxBacklogWhere } from "../lib/amux/adminBacklogListCore.ts";
import { adminNavItemTabs } from "../lib/adminNavigation.ts";

test("backlog search covers card number and ID before pagination, without archived or runnable work", () => {
  assert.deepEqual(amuxBacklogWhere("chat-01"), { archivedAt: null, status: "backlog", OR: [
    { sourceKey: { contains: "chat-01", mode: "insensitive" } },
    { id: { contains: "chat-01", mode: "insensitive" } },
  ] });
  assert.deepEqual(amuxBacklogSearch("  CHAT-01  "), { search: "CHAT-01", valid: true });
  assert.equal(amuxBacklogSearch("%_").valid, false);
  assert.equal(amuxBacklogSearch("a".repeat(129)).valid, false);
  assert.deepEqual(amuxBacklogWhere(""), { archivedAt: null, status: "backlog" });
});

test("search and pagination survive direct links and summaries stay bounded", () => {
  assert.equal(amuxBacklogHref("CHAT-01", 3), "/admin/amux-backlog?tab=list&cardNumber=CHAT-01&page=3");
  assert.equal(amuxBacklogPage("-1"), 1);
  assert.equal(amuxBacklogPage("0"), 1);
  assert.equal(amuxBacklogPage("10000000"), 1);
  assert.equal(amuxBacklogPage("3"), 3);
  assert.equal(amuxBacklogSummary("one\n\ttwo"), "one two");
  assert.equal(amuxBacklogSummary(null), null);
  assert.equal(amuxBacklogSummary("card ea5dcb900861ccbb"), null);
  assert.equal(amuxBacklogSummary(" "), null);
  assert.equal(amuxBacklogSummary("a".repeat(400)).length, 240);
});

test("backlog opens its list and reads private summaries only after recent owner authentication", async () => {
  assert.equal(adminNavItemTabs("amux-backlog")[0].id, "list");
  const page = await readFile(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getAdminRole\(session\) !== "owner"\) notFound\(\)/);
  assert.match(page, /tab\.id === "list" && search\.valid && hasRecentAdminAuthentication\(session\)/);
});
