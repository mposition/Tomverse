import assert from "node:assert/strict";
import test from "node:test";

import { openAmuxNodeText, sealAmuxNodeText } from
  "../lib/amux/ideaNodeContentCore.ts";
import { scanAmuxNodeDuplicates } from
  "../lib/amux/ideaNodeDuplicateScanService.ts";

const keys = { masterKeyId: "master_test", masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 7), digestKeyId: "digest_test",
  digestKey: Buffer.alloc(32, 8) };
const row = (id, title, revision = 0) => ({ id, revision,
  ...sealAmuxNodeText(id, { title, description: "Synthetic description" }, keys) });
const tx = (rows) => ({
  $queryRaw: async () => [{ now: new Date("2026-10-03T01:02:03.004Z"),
    isolation: "serializable" }],
  amuxPortfolioNode: { findMany: async ({ take }) => rows.slice(0, take) },
});

test("node text binds both encrypted fields and rejects swaps or changed digest", () => {
  const first = row("node_00000001", "검색 품질");
  const second = row("node_00000002", "검색 품질");
  assert.equal(openAmuxNodeText(first.id, first, keys).title, "검색 품질");
  assert.throws(() => openAmuxNodeText(first.id,
    { ...first, descriptionCiphertext: second.descriptionCiphertext }, keys));
  assert.throws(() => openAmuxNodeText(first.id,
    { ...first, contentDigest: "0".repeat(64) }, keys));
  assert.throws(() => openAmuxNodeText(first.id, first,
    { ...keys, masterKeyId: "rotated_master" }));
  assert.throws(() => sealAmuxNodeText(first.id,
    { title: " 제목", description: "설명" }, keys));
});

test("full scoped scan binds normalized-title candidates and revision changes", async () => {
  const rows = [row("node_00000001", "검색 품질"),
    row("node_00000002", "다른 제목"),
    row("node_00000003", "검색 품질", 2)];
  const input = { level: "initiative", parentId: null, title: "검색 품질" };
  const first = await scanAmuxNodeDuplicates(tx(rows), input, keys);
  assert.equal(first.complete, true);
  assert.equal(first.scanVersion, "node_nfc_lower_title_v1");
  assert.deepEqual(first.candidates.map((candidate) => candidate.id),
    ["node_00000001", "node_00000003"]);
  assert.equal(first.checkedAtIso, "2026-10-03T01:02:03.004Z");
  const changed = await scanAmuxNodeDuplicates(tx([
    rows[0], rows[1], { ...rows[2], revision: 3 }]), input, keys);
  assert.notEqual(changed.result.digest, first.result.digest);
  const unrelated = await scanAmuxNodeDuplicates(tx([
    rows[0], { ...rows[1], revision: 3 }, rows[2]]), input, keys);
  assert.equal(unrelated.result.digest, first.result.digest);
  const collationOrdered = await scanAmuxNodeDuplicates(tx([
    row("node_aaaaaaaa", "검색 품질"), row("node_AAAAAAAA", "검색 품질"),
  ]), input, keys);
  assert.deepEqual(collationOrdered.candidates.map((candidate) => candidate.id),
    ["node_AAAAAAAA", "node_aaaaaaaa"]);
});

test("scan refuses unreadable rows and incomplete candidate or corpus bounds", async () => {
  const input = { level: "initiative", parentId: null, title: "검색 품질" };
  await assert.rejects(scanAmuxNodeDuplicates(tx([
    { ...row("node_00000001", "검색 품질"), contentDigest: "0".repeat(64) }]),
  input, keys), { code: "integrity_unavailable" });
  await assert.rejects(scanAmuxNodeDuplicates(tx(Array.from({ length: 65 }, (_, i) =>
    row(`node_${String(i).padStart(8, "0")}`, "검색 품질"))), input, keys),
  { code: "incomplete" });
  const repeated = row("node_00000001", "검색 품질");
  await assert.rejects(scanAmuxNodeDuplicates(tx(Array(10_001).fill(repeated)),
    input, keys), { code: "incomplete" });
  await assert.rejects(scanAmuxNodeDuplicates(tx([]),
    { ...input, parentId: "node_00000001" }, keys), { code: "invalid_query" });
  await assert.rejects(scanAmuxNodeDuplicates({ ...tx([]),
    $queryRaw: async () => [{ now: new Date(), isolation: "read committed" }] },
  input, keys), { code: "integrity_unavailable" });
});
