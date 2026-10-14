import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AMUX_CARD_DISPLAY_SOURCE_SYSTEM_PATH,
  amuxCardDisplayKeyBackfillBinding,
  deriveAmuxFeatureDisplayPrefix,
  planAmuxCardDisplayKeyBackfill,
} from "../lib/amux/cardDisplayKeyBackfillCore.ts";

// docs/policy/amux-card-display-key.md §4 and §5 (operator decisions 2026-10-14).

const card = (id, extra = {}) => ({ id, displayKey: null, sourceSystem: null,
  parentFeatureNodeId: null, createdAt: "2026-10-01T00:00:00.000Z", ...extra });
const feature = (id, title, extra = {}) => ({ id, title, displayPrefix: null,
  createdAt: "2026-10-01T00:00:00.000Z", ...extra });
const plan = (input) => planAmuxCardDisplayKeyBackfill({ features: [], cards: [],
  counters: {}, takenPrefixes: [], ...input });

test("a title gives its first usable ASCII word, uppercased and cut to 16", () => {
  assert.equal(deriveAmuxFeatureDisplayPrefix("GitHub integration"), "GITHUB");
  assert.equal(deriveAmuxFeatureDisplayPrefix("v4 card numbers"), "V4");
  assert.equal(deriveAmuxFeatureDisplayPrefix("Supercalifragilisticexpialidocious"), "SUPERCALIFRAGILI");
  // A one-letter word and a reserved prefix are skipped, not used.
  assert.equal(deriveAmuxFeatureDisplayPrefix("A Eng tooling"), "TOOLING");
  assert.equal(deriveAmuxFeatureDisplayPrefix("카드 번호 GitHub 연계"), "GITHUB");
  assert.equal(deriveAmuxFeatureDisplayPrefix("카드 번호 표시"), null);
  assert.equal(deriveAmuxFeatureDisplayPrefix(null), null);
});

test("prefix-less Features get a title prefix, a numbered variant, or FEATn, in creation order", () => {
  const result = plan({
    features: [
      feature("f-old", "GitHub sync", { createdAt: "2026-09-01T00:00:00.000Z" }),
      feature("f-held", "Anything", { displayPrefix: "HELD" }),
      feature("f-dup", "GitHub app", { createdAt: "2026-09-02T00:00:00.000Z" }),
      feature("f-ko", "한국어 제목", { createdAt: "2026-09-03T00:00:00.000Z" }),
      feature("f-gone", null, { createdAt: "2026-09-04T00:00:00.000Z" }),
    ],
    takenPrefixes: ["HELD", "FEAT1"],
  });
  assert.deepEqual(result.features.map(({ id, prefix, from }) => ({ id, prefix, from })), [
    { id: "f-old", prefix: "GITHUB", from: "title" },
    { id: "f-dup", prefix: "GITHUB2", from: "title" },
    { id: "f-ko", prefix: "FEAT2", from: "fallback" },
    { id: "f-gone", prefix: "FEAT3", from: "fallback" },
  ]);
});

test("each unnumbered card gets its Feature's or its path's prefix, numbered after the counter", () => {
  const result = plan({
    features: [feature("f-1", "GitHub sync"), feature("f-2", "Held", { displayPrefix: "HELD" })],
    cards: [
      card("c-legacy-2", { createdAt: "2026-10-02T00:00:00.000Z" }),
      card("c-legacy-1"),
      card("c-intake", { sourceSystem: "codex-conversation" }),
      card("c-eng", { sourceSystem: "engineering-develop-ci" }),
      card("c-board", { sourceSystem: "tomverse_private_workboard" }),
      card("c-feature", { sourceSystem: "admin-idea-v4", parentFeatureNodeId: "f-1" }),
      card("c-held", { sourceSystem: "admin-idea-v4", parentFeatureNodeId: "f-2" }),
      card("c-idea", { sourceSystem: "admin-idea-v4" }),
      card("c-numbered", { displayKey: "AMUX-LEGACY-001" }),
      card("c-unknown", { sourceSystem: "somewhere-else" }),
      card("c-orphan", { parentFeatureNodeId: "f-missing" }),
    ],
    counters: { LEGACY: 1, HELD: 41 },
    takenPrefixes: ["HELD"],
  });
  assert.deepEqual(Object.fromEntries(result.cards.map((item) => [item.id, item.displayKey])), {
    "c-legacy-1": "AMUX-LEGACY-002",
    "c-legacy-2": "AMUX-LEGACY-003",
    "c-intake": "AMUX-INTAKE-001",
    "c-eng": "AMUX-ENG-001",
    "c-board": "AMUX-WORKBOARD-001",
    "c-feature": "AMUX-GITHUB-001",
    "c-held": "AMUX-HELD-042",
    "c-idea": "AMUX-IDEA-001",
  });
  assert.deepEqual(result.unresolved, [
    { id: "c-orphan", reason: "feature_missing" },
    { id: "c-unknown", reason: "unknown_source" },
  ]);
});

test("the binding is everything written or refused, never the titles", () => {
  const result = plan({ features: [feature("f-1", "Secret project title")], cards: [card("c-1")] });
  const binding = amuxCardDisplayKeyBackfillBinding(result);
  assert.deepEqual(binding.features, [{ id: "f-1", prefix: "SECRET" }]);
  assert.deepEqual(binding.cards, [{ id: "c-1", displayKey: "AMUX-LEGACY-001" }]);
  assert.equal(JSON.stringify(binding).includes("project title"), false);
});

test("the source-system map names every card writer's source system", () => {
  const read = (path) => readFileSync(path, "utf8");
  for (const [constant, path] of [
    ["BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM", "lib/amux/boardImportCore.ts"],
    ["AMUX_INTAKE_SOURCE_SYSTEM", "lib/amux/intakeCore.ts"],
    ["LOCAL_INTAKE_SOURCE_SYSTEM", "lib/amux/localIntakeCore.ts"],
    ["AMUX_V4_IDEA_SOURCE_SYSTEM", "lib/amux/ideaIdentityCore.ts"],
  ]) {
    const value = read(path).match(new RegExp(`export const ${constant} = "([^"]+)"`))?.[1];
    assert.ok(value && Object.hasOwn(AMUX_CARD_DISPLAY_SOURCE_SYSTEM_PATH, value), `${constant} = ${value}`);
  }
  const agentSources = read("lib/amux/agentIntake.ts").match(/"engineering-agent": \[([^\]]*)\]/)?.[1] ?? "";
  for (const [, source] of agentSources.matchAll(/"([^"]+)"/g)) {
    assert.equal(AMUX_CARD_DISPLAY_SOURCE_SYSTEM_PATH[source], "engineeringAgent", source);
  }
});
