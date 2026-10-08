import assert from "node:assert/strict";
import test from "node:test";

import { scanAmuxCardDuplicates } from "../lib/amux/ideaCardDuplicateScanCore.ts";

const key = { digestKeyId: "scan_v1", digestKey: Buffer.alloc(32, 13) };
const card = (id, title, cardType = "story") => ({ id, title,
  revision: 1, content: { digest: "a".repeat(64), keyId: "scan_v1" },
  cardType, storyKind: cardType === "story" ? "general" : null,
  featureNodeId: "feature_00001", archived: false });
const input = () => ({ unitId: "draft_0000001", title: "한국어 Story",
  cardType: "story", storyKind: "general", featureNodeId: "feature_00001",
  explicitRefs: [], cards: [card("story_0000001", "한국어 story")],
  catalogComplete: true, checkedAt: new Date("2026-10-01T01:00:00.000Z"), key });

test("complete scan binds Korean case-normalized title and candidate metadata", () => {
  const result = scanAmuxCardDuplicates(input());
  assert.equal(result.ok, true);
  assert.deepEqual(result.scan.candidates.map((candidate) => candidate.id),
    ["story_0000001"]);
  assert.equal(result.scan.complete, true);
  assert.match(result.scan.result.digest, /^[a-f0-9]{64}$/);
  const changed = input();
  changed.cards[0].revision = 2;
  assert.notEqual(scanAmuxCardDuplicates(changed).scan.result.digest,
    result.scan.result.digest);
});

test("truncated catalog, unresolved reference and archived suggested card fail closed", () => {
  const truncated = input();
  truncated.catalogComplete = false;
  assert.equal(scanAmuxCardDuplicates(truncated).code, "catalog_incomplete");
  const missing = input();
  missing.explicitRefs = ["missing_00001"];
  assert.equal(scanAmuxCardDuplicates(missing).code, "unresolved_reference");
  const archived = input();
  archived.explicitRefs = ["story_0000001"];
  archived.cards[0].archived = true;
  assert.equal(scanAmuxCardDuplicates(archived).code, "unresolved_reference");
});

test("candidate cap refuses rather than silently trimming overlaps", () => {
  const many = input();
  many.cards = Array.from({ length: 65 }, (_, index) =>
    card(`story_${String(index).padStart(8, "0")}`, "한국어 story"));
  assert.equal(scanAmuxCardDuplicates(many).code, "too_many_candidates");
});
