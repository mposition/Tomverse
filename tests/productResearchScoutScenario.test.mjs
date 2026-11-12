import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOUT_FIXTURES } from "../lib/productResearchScoutBrowserPolicy.mjs";
import { SCOUT_SYSTEM_PROMPT } from "../lib/productResearchScoutCore.ts";
import {
  SCENARIO_OUTPUT_SCHEMA,
  SCENARIO_SUBJECT,
  SCENARIO_SYSTEM_PROMPT,
  parseScenarioAnswer,
  runScenario,
  scenarioPromptText,
} from "../lib/productResearchScoutScenarioCore.ts";

const scenario = { prompt: "첨부한 표를 엑셀로 바꿔 주세요", attachments: ["sales.csv"], expectation: "xlsx 파일 한 개" };

function deps(overrides = {}) {
  const calls = { reserved: [], settled: [], planned: 0 };
  const value = {
    now: new Date("2026-11-12T18:00:00Z"),
    recentTitles: async () => ["첨부 이미지를 PDF로 만들지 못함"],
    model: async () => ({
      modelId: "model-a",
      planScenario: async (titles, today) => {
        calls.planned += 1;
        calls.titles = titles;
        calls.today = today;
        return { scenario, inputTokens: 300, outputTokens: 60 };
      },
    }),
    reserve: async (modelId) => {
      calls.reserved.push(modelId);
      return { id: "call-1" };
    },
    settle: async (id, result) => {
      calls.settled.push({ id, ...result });
    },
    ...overrides,
  };
  return { value, calls };
}

test("the judge treats a 'cannot do that' answer as a finding", () => {
  assert.match(SCOUT_SYSTEM_PROMPT, /says Tomverse cannot do what was asked[^]*is a finding too/);
});

test("the scenario prompt offers only the walker's fixtures and fences earlier findings", () => {
  for (const name of Object.keys(SCOUT_FIXTURES)) assert.ok(SCENARIO_SYSTEM_PROMPT.includes(`- ${name}:`), name);
  assert.deepEqual(SCENARIO_OUTPUT_SCHEMA.properties.attachments.items.enum, Object.keys(SCOUT_FIXTURES));
  const text = scenarioPromptText(["하나", "둘"], new Date("2026-11-12T18:00:00Z"));
  assert.match(text, /Today is 2026-11-12\./);
  assert.match(text, /<recent>\n- 하나\n- 둘\n<\/recent>/);
  assert.match(scenarioPromptText([], new Date()), /<recent>\nnone\n<\/recent>/);
});

test("a model answer is kept only as a runnable scenario", () => {
  assert.deepEqual(parseScenarioAnswer(scenario), scenario);
  assert.equal(parseScenarioAnswer({ ...scenario, attachments: ["passport.jpg"] }), null);
  assert.equal(parseScenarioAnswer({ ...scenario, prompt: "x".repeat(600) }), null);
  assert.equal(parseScenarioAnswer("ask for a PDF"), null);
});

test("today's scenario reserves one call, plans once with the earlier findings, and settles", async () => {
  const { value, calls } = deps();
  assert.deepEqual(await runScenario(value), { scenario });
  assert.deepEqual(calls.reserved, ["model-a"]);
  assert.equal(calls.planned, 1);
  assert.deepEqual(calls.titles, ["첨부 이미지를 PDF로 만들지 못함"]);
  assert.deepEqual(calls.settled, [{ id: "call-1", ok: true, inputTokens: 300, outputTokens: 60, kept: 1 }]);
  assert.equal(SCENARIO_SUBJECT, "scenario.explore");
});

test("no model, or a refused reservation, spends nothing; an unusable answer is settled failed", async () => {
  const off = deps({ model: async () => null });
  assert.deepEqual(await runScenario(off.value), { judged: false, reason: "model_off" });
  assert.deepEqual(off.calls.reserved, []);

  const capped = deps({ reserve: async () => ({ refused: "daily_cap_reached" }) });
  assert.deepEqual(await runScenario(capped.value), { judged: false, reason: "daily_cap_reached" });
  assert.equal(capped.calls.planned, 0);

  const failed = deps({
    model: async () => ({ modelId: "model-a", planScenario: async () => ({ scenario: null, inputTokens: 200, outputTokens: null }) }),
  });
  assert.deepEqual(await runScenario(failed.value), { judged: false, reason: "model_failed" });
  assert.deepEqual(failed.calls.settled, [{ id: "call-1", ok: false, inputTokens: 200, outputTokens: null, kept: 0 }]);
});

test("the scenario route keeps one call free for judging the turn it plans", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync(new URL("../app/api/internal/product-research/scout/scenario/route.ts", import.meta.url), "utf8");
  assert.match(route, /startScoutCall\(\{ subject: SCENARIO_SUBJECT, modelId, keepFree: SCENARIO_JUDGE_CALLS \}\)/);
  const { SCENARIO_JUDGE_CALLS } = await import("../lib/productResearchScoutScenarioCore.ts");
  assert.equal(SCENARIO_JUDGE_CALLS, 1);
});

test("the scenario route does not exist until both switches are on, and never answers without the secret", async () => {
  const saved = { ...process.env };
  try {
    const { POST } = await import("../app/api/internal/product-research/scout/scenario/route.ts");
    const request = (authorization) =>
      new Request("https://tomverse.app/api/internal/product-research/scout/scenario", {
        method: "POST",
        headers: authorization ? { authorization } : {},
      });
    const secret = "s".repeat(32);
    process.env.PRODUCT_RESEARCH_SCOUT_INGEST_SECRET = secret;

    delete process.env.PRODUCT_RESEARCH_SCOUT_ENABLED;
    delete process.env.PRODUCT_RESEARCH_SCOUT_EXPLORE_TASK_ENABLED;
    assert.equal((await POST(request(`Bearer ${secret}`))).status, 404, "Scout off");

    process.env.PRODUCT_RESEARCH_SCOUT_ENABLED = "1";
    assert.equal((await POST(request(`Bearer ${secret}`))).status, 404, "scenario switch off");

    process.env.PRODUCT_RESEARCH_SCOUT_EXPLORE_TASK_ENABLED = "1";
    assert.equal((await POST(request(null))).status, 401, "no secret");
    assert.equal((await POST(request("Bearer wrong"))).status, 401, "wrong secret");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
