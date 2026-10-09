import assert from "node:assert/strict";
import test from "node:test";

import { pollAmuxV4AnalysisCandidateIds,
  AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from "../lib/amux/ideaLocalQueuePoll.mjs";

const secret = "local_queue_only_012345678901234567890123456789";
const candidate = (index) => ({
  previewId: `preview_${index}`, ideaId: `idea_${index}`, chunkIndex: index,
  attempt: 1, modelId: "frontier-model", expiresAt: "2026-10-04T00:00:00.000Z",
});
const page = { candidates: Array.from({ length: 32 }, (_, index) => candidate(index)),
  hasMore: true, nextCursor: "next_page_1" };
const json = (body) => Response.json(body);

process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = "https://staging.tomverse.example/";

test("local AMUX v4 supervisor polls only candidate metadata with its own identity", async () => {
  let observed;
  const result = await pollAmuxV4AnalysisCandidateIds({
    origin: "https://staging.tomverse.example/", agentSecret: secret,
    after: "previous_page_1", fetchImpl: async (url, options) => {
      observed = { url, options };
      return json(page);
    },
  });
  assert.deepEqual(result, { kind: "candidates", ...page });
  assert.equal(observed.url,
    "https://staging.tomverse.example/api/internal/amux/v4/analysis-queue");
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.redirect, "manual");
  assert.equal(observed.options.cache, "no-store");
  assert.equal(observed.options.headers["x-amux-agent-id"], "amux-intake");
  assert.equal(observed.options.headers.authorization, `Bearer ${secret}`);
  assert.equal(observed.options.body, JSON.stringify({ after: "previous_page_1" }));
  assert.equal(observed.options.signal.aborted, false);
});

test("local AMUX v4 poll refuses invalid origin or secret before network", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json(page); };
  for (const origin of ["http://tomverse.example/", "https://tomverse.example/path",
    "https://user:pass@tomverse.example/", "https://tomverse.example/?x=1"] ) {
    assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({ origin, agentSecret: secret,
      fetchImpl }), { kind: "refused" });
  }
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({
    origin: "https://tomverse.example/", agentSecret: "short", fetchImpl,
  }), { kind: "refused" });
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({
    origin: "https://tomverse.example/", agentSecret: secret,
    after: "bad/cursor", fetchImpl,
  }), { kind: "refused" });
  assert.equal(calls, 0);
});

test("local AMUX v4 poll pins the app origin before sending its bearer credential", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json(page); };
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({
    origin: "https://tomverse.example/", agentSecret: secret, fetchImpl,
  }), { kind: "refused" });
  const previous = process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  delete process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV];
  try {
    assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({
      origin: "https://staging.tomverse.example/", agentSecret: secret, fetchImpl,
    }), { kind: "refused" });
  } finally { process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] = previous; }
  assert.equal(calls, 0);
});

test("local AMUX v4 poll fails closed on redirect, disabled route and unknown result", async () => {
  const basis = { origin: "https://staging.tomverse.example/", agentSecret: secret };
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({ ...basis,
    fetchImpl: async () => new Response(null, { status: 302,
      headers: { location: "https://evil.example/" } }),
  }), { kind: "unavailable" });
  const redirected = json(page);
  Object.defineProperty(redirected, "url", { value: "https://evil.example/" });
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({ ...basis,
    fetchImpl: async () => redirected,
  }), { kind: "unavailable" });
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({ ...basis,
    fetchImpl: async () => new Response(null, { status: 409 }),
  }), { kind: "disabled" });
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({ ...basis,
    fetchImpl: async () => { throw new Error("transport with sensitive text"); },
  }), { kind: "unavailable" });
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({ ...basis,
    fetchImpl: async () => json({ ...page, payloadCiphertext: "should_not_arrive" }),
  }), { kind: "unavailable" });
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({ ...basis,
    fetchImpl: async () => json({ ...page,
      candidates: [{ ...candidate(0), prompt: "bad" }, ...page.candidates.slice(1)] }),
  }), { kind: "unavailable" });
  assert.deepEqual(await pollAmuxV4AnalysisCandidateIds({ ...basis,
    fetchImpl: async () => json({ ...page, oversized: "x".repeat(65_536) }),
  }), { kind: "unavailable" });
});
