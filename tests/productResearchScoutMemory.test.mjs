import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";
import {
  memoryProbe,
  assessMemory,
  memoryReading,
  dailyMemoryMode,
  parseMemoryReading,
  memoryLatestKey,
  MEMORY_MODES,
} from "../lib/productResearchScoutMemoryCore.ts";
import { verifiedMemoryIdeas } from "../lib/productResearchScoutMemoryIdeas.ts";
import { walkMemoryProbes } from "../lib/productResearchScoutMemoryWalk.mjs";

const day = "2026-11-12";
const record = (probe, answer) =>
  memoryReading(probe, assessMemory(probe, JSON.stringify(answer)), "fixture");
test("the qualified exception, counterfactual and user-selected tail are scored separately in every interface language", () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    const probe = (mode) => memoryProbe(day, lang, mode);
    const base = probe("recent"),
      swap = probe("counterfactual"),
      picked = probe("picked"),
      auto = probe("long-auto"),
      empty = probe("empty");
    for (const p of [base, swap, picked, auto]) {
      assert.ok(p.visible);
      assert.equal(record(p, p.gold).outcome, "pass");
      assert.deepEqual(
        p.messages.map((m) => m.role),
        ["system", "user", "user"],
      );
      assert.ok(
        !p.messages[0].content.includes(p.gold.A),
        "the grader's route code is not a system instruction",
      );
    }
    assert.deepEqual(swap.gold, {
      ...base.gold,
      B: base.gold.D,
      D: base.gold.B,
    });
    assert.equal(record(swap, base.gold).outcome, "decision");
    const omitted = { ...empty, mode: "long-auto" };
    assert.equal(record(omitted, omitted.expected).outcome, "omission");
    assert.equal(record(omitted, base.gold).outcome, "unsupported");
    assert.equal(empty.messages.length, 1);
    assert.equal(record(empty, empty.expected).outcome, "pass");
    assert.equal(
      record(base, { ...base.gold, A: "unscorable" }).outcome,
      "format",
    );
    assert.equal(
      new Set(
        Array.from({ length: 5 }, (_, i) =>
          dailyMemoryMode("2026-11-" + (11 + i), lang),
        ),
      ).size,
      MEMORY_MODES.length,
    );
  }
});
test("unmeasured or malformed settings never appear as successes or actionable measurements", () => {
  const p = memoryProbe(day, "zh-Hant", "recent"),
    reading = record(p, p.gold),
    key = memoryLatestKey(p.locale);
  assert.deepEqual(parseMemoryReading(key, JSON.stringify(reading)), reading);
  for (const value of [
    null,
    {},
    { ...reading, expected: null },
    { ...reading, answers: { A: "UNKNOWN" } },
    { ...reading, version: "old" },
  ])
    assert.equal(parseMemoryReading(key, JSON.stringify(value)), null);
  assert.equal(
    parseMemoryReading(memoryLatestKey("zh"), JSON.stringify(reading)),
    null,
  );
});
test("ideas must name a measured failing language and carry its actual observed evidence", () => {
  const de = memoryProbe(day, "de", "long-auto"),
    en = memoryProbe(day, "en", "recent");
  const rows = [record(de, { ...de.expected, B: "UNKNOWN" }), record(en, en.expected)];
  const proposal = (title) => ({
    title,
    evidence: "Inspect the excerpt.",
    suggestion: "Verify the final sentence.",
    area: "other",
    severity: "medium",
  });
  const kept = verifiedMemoryIdeas(
    rows,
    [
      "[de] Tail",
      "[de] Tail",
      "[de] Already open",
      "[en] Tail",
      "[fr] Tail",
      "Tail",
    ].map(proposal),
    ["[de] Already open"],
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].subject, "memory.continuation.de");
  assert.match(kept[0].suggestion.evidence, /decision.*observed=.*UNKNOWN/);
});
test("a disabled route stops immediately; the enabled walker rotates, diagnoses last and never retries an unknown POST", async () => {
  const calls = [],
    full = [],
    next = [];
  await walkMemoryProbes(day, async (t) => {
    calls.push(t);
    return { disabled: true };
  });
  assert.equal(calls.length, 1);
  await walkMemoryProbes(day, async (t) => {
    full.push(t);
    if (t === "ko") throw Error("network");
    return { judged: true };
  });
  await walkMemoryProbes("2026-11-13", async (t) => {
    next.push(t);
    return { judged: false, reason: "daily_cap_reached" };
  });
  assert.deepEqual(new Set(full), new Set([...SUPPORTED_LANGUAGES, "ideas"]));
  assert.equal(full.length, SUPPORTED_LANGUAGES.length + 1);
  assert.equal(full.at(-1), "ideas");
  assert.equal(next.length, 1);
  assert.notEqual(next[0], full[0]);
});
