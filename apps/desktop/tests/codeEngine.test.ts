import assert from "node:assert/strict";
import test from "node:test";
import { journalContext, journalEngine } from "../src/host/journal-view";
import { estimateTokens } from "../../tomverse-cli/src/runtime";
import { startInput } from "../src/contract";
import { effortLabel, effortOptions } from "../src/renderer/CodeEngine";
import { desktopCodeEngineCopy } from "../../../locales/desktopCodeEngine";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";

type Saved = Parameters<typeof journalEngine>[0];
const at = "2026-11-25T00:00:00Z";
const saved = (extra: Partial<Saved> = {}, task: Partial<Saved["tasks"][number]> = {}): Saved => ({
  limits: { maxRequests: 20, timeoutMs: 900_000, commandTimeoutMs: 120_000 },
  model: { requested: "m", pinned: "m", pinnedFrom: "user", contextWindowTokens: 1_000, maxOutputTokens: 100 },
  messages: [{ role: "user", content: "x".repeat(350) }],
  tasks: [{ prompt: "Do it", startedAt: at, requests: 1, activeMs: 1, allowance: 20, timeAllowanceMs: 900_000, ...task }],
  ...extra,
} as Saved);

test("start input accepts a limit profile and goal mode, and nothing else", () => {
  const base = { prompt: "Fix it", mode: "agent", model: "m", effort: "default" } as const;
  assert.equal(startInput.parse({ ...base }).limits, undefined);
  assert.equal(startInput.parse({ ...base, limits: "unlimited", goal: true }).limits, "unlimited");
  assert.throws(() => startInput.parse({ ...base, limits: "forever" }));
  assert.throws(() => startInput.parse({ ...base, goal: "yes" }));
});

test("a saved task shows a non-standard limit profile, goal progress and held messages", () => {
  const plain = journalEngine(saved());
  assert.deepEqual([plain.limits, plain.goal, plain.queued], [undefined, undefined, undefined]);
  assert.equal(journalEngine(saved({ limits: { maxRequests: 20, timeoutMs: 1, commandTimeoutMs: 1, profile: "standard" } })).limits, undefined);
  const engine = journalEngine(saved({ limits: { maxRequests: 200, timeoutMs: 1, commandTimeoutMs: 1, profile: "extended" }, goal: { maxContinuations: 10 } }, {
    goalContinuations: 2,
    goalChecks: [{ at, met: false, summary: "No test ran. tvk_abcdefghijklmnop", next: "Run the tests.", continuation: 1 }],
    queued: [{ id: "q-00000001", text: "then update the docs" }],
  }));
  assert.equal(engine.limits, "extended");
  assert.equal(engine.goal?.continuations, 2);
  assert.equal(engine.goal?.maxContinuations, 10);
  assert.equal(engine.goal?.last?.next, "Run the tests.");
  assert.equal(engine.goal?.last?.summary, "No test ran. [credential removed]", "a saved summary never shows a key");
  assert.deepEqual(engine.queued, [{ id: "q-00000001", text: "then update the docs" }]);
});

test("context usage is an estimate of the saved messages against the model window", () => {
  const usage = journalContext(saved());
  assert.equal(usage?.window, 1_000);
  assert.equal(usage?.tokens, estimateTokens(saved().messages));
  assert.ok(usage!.tokens > 100 && usage!.tokens < 130);
  assert.equal(journalContext(saved({ model: { requested: "m", pinned: null, pinnedFrom: null, contextWindowTokens: 0, maxOutputTokens: 0 } }))?.window, 128_000);
});

test("every supported language has the engine strings, with their placeholders", () => {
  const english = desktopCodeEngineCopy.en;
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = desktopCodeEngineCopy[language];
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(english).sort(), language);
    for (const key of Object.keys(english) as Array<keyof typeof english>) {
      const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort();
      assert.deepEqual(placeholders(copy[key]), placeholders(english[key]), `${language}.${key}`);
      assert.ok(copy[key].trim().length > 0, `${language}.${key}`);
    }
  }
});

test("start input takes any level id the catalog could name, and rejects what is not one", () => {
  const base = { prompt: "Fix it", mode: "agent", model: "m" } as const;
  for (const effort of ["default", "low", "medium", "high", "xhigh"]) assert.equal(startInput.parse({ ...base, effort }).effort, effort);
  for (const effort of ["", "Extra High", "high ", "1high", "x".repeat(40)]) assert.throws(() => startInput.parse({ ...base, effort }), effort);
});

test("the effort picker offers default and the model's own levels, keeping a level already chosen", () => {
  assert.deepEqual(effortOptions(undefined, "default"), ["default"]);
  assert.deepEqual(effortOptions([], "default"), ["default"]);
  assert.deepEqual(effortOptions(["low", "medium", "high"], "default"), ["default", "low", "medium", "high"]);
  assert.deepEqual(effortOptions(["low", "high"], "xhigh"), ["default", "low", "high", "xhigh"]);
  assert.equal(effortLabel("en", "low"), "Low");
  assert.equal(effortLabel("en", "medium"), "Medium");
  assert.equal(effortLabel("ko", "xhigh"), "매우 높음");
  assert.equal(effortLabel("en", "turbo"), "turbo", "an id with no translation is shown as the catalog gives it");
});
