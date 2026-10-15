import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

// The catalog before the transaction is empty; cards appear only inside it.
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { amuxWorkItem: { findMany: async () => [] } } } });
mock.module(mod("lib/amux/ideaKeyStore.ts"), { namedExports: { loadAmuxContentKeyRing: async () => "keys" } });
let seen;
mock.module(mod("lib/amux/ideaCardDuplicateScanCore.ts"), {
  namedExports: { scanAmuxCardDuplicates: (input) => { seen = input.cards.map((c) => [c.id, c.title]); return { ok: true, scan: { candidates: [] } }; } },
});
const { loadAmuxCardDuplicateScanner } = await import(mod("lib/amux/ideaCardDuplicateScanService.ts"));

const row = (id, extra = {}) => ({ id, sourceSystem: "admin-idea-v4", sourceSnapshot: { ideaId: "i" }, title: "",
  revision: 1, cardType: "story", storyKind: "general", parentFeatureNodeId: "node-f", archivedAt: null,
  status: "backlog", v4TitleCiphertext: Buffer.from(`c-${id}`), v4TitleKeyId: "k", v4TitleKeyVersion: 1,
  v4TitleDigest: "a".repeat(64), v4TitleDigestKeyId: "k", ...extra });
let txRows = [];
const tx = {
  amuxWorkItem: {
    findMany: async () => txRows,
    findUnique: async ({ where }) => txRows.find((entry) => entry.id === where.id) ?? null,
  },
  $queryRaw: async () => [{ now: new Date("2026-10-15T00:00:00Z") }],
};
const scanInput = { unitId: "unit-x", proposal: { title: "t", cardType: "task", storyKind: null,
  duplicateCandidateRefs: [] }, featureNodeId: "node-f" };

const scanner = await loadAmuxCardDuplicateScanner();
await scanner(tx, scanInput);
txRows = [row("card-story-01")];
await assert.rejects(scanner(tx, scanInput), (error) => error.code === "catalog_incomplete",
  "without admission a new card is an unexpected catalog change");
await scanner.admitCreated(tx, { id: "card-story-01", title: "Story" });
await scanner(tx, scanInput);
assert.deepEqual(seen, [["card-story-01", "Story"]]);
// Anything the plan did not create, or a changed admitted card, is still refused.
txRows = [...txRows, row("card-other-01")];
await assert.rejects(scanner(tx, scanInput), (error) => error.code === "catalog_incomplete");
await assert.rejects(scanner.admitCreated(tx, { id: "card-story-01", title: "again" }),
  (error) => error.code === "catalog_incomplete");
txRows = [row("card-story-01", { revision: 2 })];
await assert.rejects(scanner(tx, scanInput), (error) => error.code === "catalog_incomplete");
// Only a new v4 backlog card can be admitted.
txRows = [row("card-story-01"), row("card-done-0001", { status: "done" })];
await assert.rejects(scanner.admitCreated(tx, { id: "card-done-0001", title: "x" }),
  (error) => error.code === "catalog_incomplete");
