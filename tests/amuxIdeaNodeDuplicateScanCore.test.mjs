import assert from "node:assert/strict";
import test from "node:test";

import { scanAmuxNodeDuplicates } from
  "../lib/amux/ideaNodeDuplicateScanCore.ts";

const key = { digestKeyId: "test-digest", digestKey: Buffer.alloc(32, 19) };
const node = (id, title, archived = false) => ({ id, title,
  level: "feature", parentId: "epic_0001", revision: 0,
  content: { digest: "a".repeat(64), keyId: "test-digest" }, archived });
const input = (changes = {}) => ({ unitId: "draft_0001", title: "한국어 검색",
  level: "feature", parentId: "epic_0001",
  nodes: [node("node_0001", " 한국어 검색 "),
    node("node_0002", "다른 기능", true)],
  catalogComplete: true, checkedAt: new Date("2026-10-05T00:00:00.000Z"),
  key, ...changes });

test("node scan binds exact Korean title and active approved candidate", () => {
  const result = scanAmuxNodeDuplicates(input());
  assert.equal(result.ok, true);
  assert.deepEqual(result.scan.candidates.map((entry) => entry.id), ["node_0001"]);
  assert.equal(result.scan.scanVersion, "node-title-v1");
  assert.notEqual(scanAmuxNodeDuplicates(input({ parentId: "epic_0002" }))
    .scan.query.digest, result.scan.query.digest);
});

test("node scan refuses incomplete and oversized catalogs", () => {
  assert.deepEqual(scanAmuxNodeDuplicates(input({ catalogComplete: false })),
    { ok: false, code: "catalog_incomplete" });
  assert.deepEqual(scanAmuxNodeDuplicates(input({ nodes: Array.from(
    { length: 1001 }, (_, index) => node(`node_${index}`, "same")) })),
  { ok: false, code: "catalog_incomplete" });
});
