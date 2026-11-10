import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createChatLocationSession } from "../packages/chat-core/src/location.ts";
import { buildAppManagedWebSearchTool } from "../lib/appManagedWebSearchTool.ts";
import { prepareRouterSearch } from "../lib/chatRouterPresearch.ts";
import { latencyDistribution } from "../lib/responseLatencyCore.ts";

// Offline orchestration experiment, not an LLM quality or production benchmark.
// Every fetch is replaced. Same evidence, search budget and final text per pair.
const rounds = 40;
const rows = { before: [], after: [] };
const originalFetch = globalThis.fetch;
const originalKey = process.env.BRAVE_SEARCH_API_KEY;
const originalFake = process.env.WEB_SEARCH_FAKE_BACKEND;
process.env.BRAVE_SEARCH_API_KEY = "offline-fixture-never-sent";
delete process.env.WEB_SEARCH_FAKE_BACKEND;
const run = async (parallel, round) => {
  const started = performance.now();
  const calls = { refiner: 0, location: 0, router: 0, modelPasses: 0, queries: [] };
  const session = createChatLocationSession(async () => assert.fail("No fixture needs GPS"));
  session.setIdentity("account:fixture");
  const location = async () => { calls.location++; await delay(30 + round % 3); return false; };
  const refiner = async () => { calls.refiner++; await delay(40 + round % 5); return "same execution prompt"; };
  const preparation = parallel ? session.prepareIntent("account:fixture", "question", location) : null;
  assert.equal(await refiner(), "same execution prompt");
  const prepared = await preparation;
  await delay(10); // Same durable message save.
  await session.readForTurn("account:fixture", undefined, { turnId: "saved",
    requiresLocation: prepared ? async () => prepared.read("account:fixture", "question") : location });
  calls.router++;
  await delay(parallel ? 30 : 25); // Charge the candidate 5ms for longer Router output.
  globalThis.fetch = async url => {
    const query = new URL(url).searchParams.get("q");
    calls.queries.push(query);
    await delay(20 + round % 3);
    return Response.json({ web: { results: [{ title: query, url: `https://example.com/${query}`, description: `Evidence for ${query}` }] } });
  };
  const tool = buildAppManagedWebSearchTool({ backend: "brave", maxQueries: 5 });
  let evidence;
  if (parallel) {
    const messages = await prepareRouterSearch({ queries: ["one", "two"], tool,
      signal: new AbortController().signal, inputHeadroomTokens: 6000, toolCallId: "fixture" });
    evidence = JSON.parse(messages[1].content[0].output.value);
  } else {
    calls.modelPasses++; await delay(45); // Model asks for the initial batched search.
    evidence = await tool.search({ query: ["one", "two"] });
  }
  assert.deepEqual(evidence.searches.map(item => item.results[0].snippet), ["Evidence for one", "Evidence for two"]);
  // Both variants still need the SAME dependent search and final generation.
  calls.modelPasses++; await delay(35);
  await tool.search({ query: "dependent" });
  calls.modelPasses++; await delay(40);
  const firstContentMs = performance.now() - started;
  await delay(20);
  assert.deepEqual(calls.queries, ["one", "two", "dependent"]);
  assert.equal(tool.session.snapshot().succeededRequestCount, 3);
  assert.equal(tool.session.snapshot().sources.length, 3);
  assert.equal(tool.session.remaining(), 2);
  assert.deepEqual([calls.refiner, calls.location, calls.router], [1, 1, 1]);
  assert.equal(calls.modelPasses, parallel ? 2 : 3);
  return { firstContentMs, completionMs: performance.now() - started };
};
try {
  for (let round = 0; round < rounds; round++) {
    for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) {
      rows[variant].push(await run(variant === "after", round));
    }
  }
  console.log(JSON.stringify({ kind: "offline-controlled-delays-not-production-or-model-quality", rounds,
    fixtureMs: { refiner: "40..44", location: "30..32", save: 10, routerBefore: 25, routerAfter: 30,
      removedModelPass: 45, search: "20..22", dependentModelPass: 35, finalModelPass: 40, stream: 20 },
    invariant: "same authored/execution text, three searches, three sources, one Refiner/location/Router call; dependent searches retained",
    results: Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, {
      firstContent: latencyDistribution(values.map(value => value.firstContentMs)),
      completion: latencyDistribution(values.map(value => value.completionMs)),
    }])),
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (originalFake === undefined) delete process.env.WEB_SEARCH_FAKE_BACKEND;
  else process.env.WEB_SEARCH_FAKE_BACKEND = originalFake;
  if (originalKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalKey;
}
