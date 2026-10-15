import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

// The catalog before the transaction is empty; nodes appear only inside it.
mock.module(mod("lib/prisma.ts"), {
  namedExports: { prisma: {
    amuxPortfolioNode: { findMany: async () => [] },
    amuxPortfolioNodeRevision: { findMany: async () => [] },
    amuxIdeaUnitDecision: { findMany: async () => [] },
  } },
});
mock.module(mod("lib/amux/ideaKeyStore.ts"), { namedExports: { loadAmuxContentKeyRing: async () => "keys" } });
let seen;
mock.module(mod("lib/amux/ideaNodeDuplicateScanCore.ts"), {
  namedExports: { scanAmuxNodeDuplicates: (input) => { seen = input.nodes.map((node) => [node.id, node.title]); return { ok: true, scan: { candidates: [] } }; } },
});

const { loadAmuxNodeDuplicateScanner, AmuxNodeDuplicateScanError } = await import(mod("lib/amux/ideaNodeDuplicateScanService.ts"));

const row = (id, level, parentId) => ({ id, level, parentId, state: "active", revision: 0, archivedAt: null,
  titleCiphertext: Buffer.from(`t-${id}`), descriptionCiphertext: Buffer.from(`d-${id}`), contentKeyId: "k",
  contentKeyVersion: 1, contentDigest: "a".repeat(64), contentDigestKeyId: "k" });
let txRows = [];
const tx = {
  amuxPortfolioNode: {
    findMany: async () => txRows,
    findUnique: async ({ where }) => txRows.find((entry) => entry.id === where.id) ?? null,
  },
  $queryRaw: async () => [{ now: new Date("2026-10-15T00:00:00Z") }],
};
const input = (unitId, level, parentId) => ({ unitId, title: "x", level, parentId });

const scanner = await loadAmuxNodeDuplicateScanner();
await scanner(tx, input("unit-init-01", "initiative", null));

// The plan creates an Initiative; admitted, the next unit's scan passes and sees it.
txRows = [row("node-init-0001", "initiative", null)];
await assert.rejects(scanner(tx, input("unit-epic-01", "epic", "node-init-0001")),
  (error) => error instanceof AmuxNodeDuplicateScanError && error.code === "catalog_incomplete",
  "without admission a new node is an unexpected catalog change");
await scanner.admitCreated(tx, { id: "node-init-0001", title: "Initiative" });
await scanner(tx, input("unit-epic-01", "epic", "node-init-0001"));
assert.deepEqual(seen, [["node-init-0001", "Initiative"]]);

// A node the plan did not create is still an incomplete catalog.
txRows = [...txRows, row("node-other-0001", "epic", "node-init-0001")];
await assert.rejects(scanner(tx, input("unit-feat-01", "feature", "node-other-0001")),
  (error) => error.code === "catalog_incomplete");

// A node cannot be admitted twice, or when it is not in the transaction.
await assert.rejects(scanner.admitCreated(tx, { id: "node-init-0001", title: "again" }),
  (error) => error.code === "catalog_incomplete");
await assert.rejects(scanner.admitCreated(tx, { id: "node-missing-01", title: "none" }),
  (error) => error.code === "catalog_incomplete");

// A changed admitted node is caught like any other change.
txRows = [{ ...row("node-init-0001", "initiative", null), revision: 1 }];
await assert.rejects(scanner(tx, input("unit-feat-01", "feature", null)),
  (error) => error.code === "catalog_incomplete");
