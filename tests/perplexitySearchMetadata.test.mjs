import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPerplexitySearchMetadata,
  mergePerplexitySearchPayloads,
  parsePerplexitySearchPayload,
} from "../lib/perplexitySearchMetadataCore.ts";
import {
  combinePerplexityResponseCaptures,
  parsePerplexityResponseCapture,
} from "../lib/perplexityResponseCore.ts";
import {
  consumePerplexityResponseCapture,
  consumePerplexityUsage,
  perplexityUsageFetch,
  perplexityUsageHeaders,
} from "../lib/perplexityUsageCapture.ts";
import { normalizeWebSearchExecution } from "../lib/webSearchExecutionNormalizer.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";

// Fixtures mirror what api.perplexity.ai actually returns for a Sonar chat
// completion: `citations` and `search_results` are TOP-LEVEL response fields,
// not `choices[].message.annotations`. That is exactly why the generic
// OpenAI-compatible adapter this app runs Perplexity through drops them.

const USAGE = {
  prompt_tokens: 1013,
  completion_tokens: 300,
  total_tokens: 1313,
  search_context_size: "medium",
  citation_tokens: 12,
  num_search_queries: 3,
  cost: {
    input_tokens_cost: 0.001013,
    output_tokens_cost: 0.00045,
    request_cost: 0.005,
    citation_tokens_cost: 0.0002,
    search_queries_cost: 0.015,
    total_cost: 0.021763,
  },
};

const CITATION_URLS = [
  "https://ai.google.dev/gemini-api/docs/thinking",
  "https://cloud.google.com/vertex-ai/generative-ai/docs/thinking",
  "https://ai.google.dev/api/generate-content",
  "https://ai.google.dev/gemini-api/docs/tokens",
  "https://discuss.ai.google.dev/t/thought-tokens/12345",
  "https://cloud.google.com/vertex-ai/generative-ai/pricing",
  "https://ai.google.dev/api/rest/v1beta/GenerateContentResponse",
];

const SEARCH_RESULTS = CITATION_URLS.map((url, index) => ({
  title: `Source ${index + 1}`,
  url,
  date: "2026-05-01",
  // Deliberately present in the fixture: a snippet is exactly the field this
  // code must never carry into the client or the database.
  snippet: `Snippet body for source ${index + 1}, which must not be stored.`,
}));

const ANSWER_TEXT =
  "Google documents thought tokens separately[1]. Vertex AI reports them in " +
  "usage metadata[4], and the pricing page confirms billing[7].";

const nonStreamingBody = () =>
  JSON.stringify({
    id: "e0a1b2c3-4d5e-6f70-8192-a3b4c5d6e7f8",
    model: "sonar",
    created: 1_770_000_000,
    object: "chat.completion",
    usage: USAGE,
    citations: CITATION_URLS,
    search_results: SEARCH_RESULTS,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: ANSWER_TEXT },
      },
    ],
  });

// The provider streams plain text deltas and only attaches citations,
// search_results, usage and finish_reason to the very last event.
const streamingBody = ({ finishReason = "stop" } = {}) => {
  const events = [];
  for (const chunk of ["Google documents ", "thought tokens", " separately[1]."]) {
    events.push(
      `data: ${JSON.stringify({
        id: "stream-1",
        model: "sonar",
        object: "chat.completion.chunk",
        choices: [{ index: 0, finish_reason: null, delta: { content: chunk } }],
      })}`
    );
  }
  events.push(
    `data: ${JSON.stringify({
      id: "stream-1",
      model: "sonar",
      object: "chat.completion.chunk",
      usage: USAGE,
      citations: CITATION_URLS,
      search_results: SEARCH_RESULTS,
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          delta: { content: "" },
        },
      ],
    })}`
  );
  events.push("data: [DONE]");
  return `${events.join("\n\n")}\n\n`;
};

test("a non-streaming Sonar response yields url, title and referenceNumber", () => {
  const { search, usage } = parsePerplexityResponseCapture(nonStreamingBody());
  assert.ok(search);
  assert.equal(search.citations.length, 7);
  assert.deepEqual(search.citations[0], {
    url: CITATION_URLS[0],
    title: "Source 1",
    startIndex: undefined,
    endIndex: undefined,
    sourceProvider: "perplexity",
    referenceNumber: 1,
  });
  assert.equal(search.citations[3].referenceNumber, 4);
  assert.equal(search.citations[6].referenceNumber, 7);
  // The same body still yields the billing snapshot -- one capture, both.
  assert.equal(usage.totalCostMicroUsd, 21_763);
});

test("search result snippets and dates never reach the citation list", () => {
  const { search } = parsePerplexityResponseCapture(nonStreamingBody());
  const serialized = JSON.stringify(search);
  assert.equal(serialized.includes("must not be stored"), false);
  assert.equal(serialized.includes("2026-05-01"), false);
  for (const citation of search.citations) {
    assert.deepEqual(Object.keys(citation).sort(), [
      "endIndex",
      "referenceNumber",
      "sourceProvider",
      "startIndex",
      "title",
      "url",
    ]);
  }
});

test("an SSE stream reads citations from its final chunk", () => {
  const { search, usage } = parsePerplexityResponseCapture(streamingBody());
  assert.ok(search);
  assert.equal(search.citations.length, 7);
  assert.equal(search.citations[3].url, CITATION_URLS[3]);
  assert.equal(search.citations[3].referenceNumber, 4);
  assert.equal(usage.searchQueries, 3);
});

test("the numbers in the answer text match the numbers in the source list", () => {
  const { search } = parsePerplexityResponseCapture(nonStreamingBody());
  const inTextNumbers = [...ANSWER_TEXT.matchAll(/\[(\d+)\]/g)].map((match) =>
    Number(match[1])
  );
  assert.deepEqual(inTextNumbers, [1, 4, 7]);
  for (const number of inTextNumbers) {
    const citation = search.citations.find(
      (entry) => entry.referenceNumber === number
    );
    assert.ok(citation, `no citation numbered [${number}]`);
    assert.equal(citation.url, CITATION_URLS[number - 1]);
  }
});

test("malformed data events, unsafe schemes and duplicate URLs are all survivable", () => {
  const body = [
    "data: {not json at all",
    "",
    "event: ping",
    "",
    `data: ${JSON.stringify({
      citations: [
        "javascript:alert(1)",
        "https://example.com/a",
        "data:text/html;base64,PHNjcmlwdD4=",
        "https://example.com/a",
        "https://example.com/b",
      ],
      search_results: [
        { title: "A", url: "https://example.com/a" },
        { title: "B", url: "https://example.com/b" },
      ],
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { search } = parsePerplexityResponseCapture(body);
  assert.deepEqual(
    search.citations.map((citation) => [
      citation.referenceNumber,
      citation.url,
    ]),
    [
      // [1] and [3] were dropped as unsafe schemes and [4] repeated [2]'s
      // URL. Nothing is renumbered: the answer's own "[2]" and "[5]" markers
      // still point at these rows.
      [2, "https://example.com/a"],
      [5, "https://example.com/b"],
    ]
  );
});

test("a response with no sources produces no citation list at all", () => {
  const { search } = parsePerplexityResponseCapture(
    JSON.stringify({ usage: USAGE, choices: [{ message: { content: "hi" } }] })
  );
  assert.equal(search, null);
});

test("search_results alone still numbers sources in provider order", () => {
  const payload = parsePerplexitySearchPayload({
    search_results: [
      { title: "First", url: "https://example.com/1" },
      { title: "Second", url: "https://example.com/2" },
    ],
  });
  const metadata = buildPerplexitySearchMetadata(payload);
  assert.deepEqual(
    metadata.citations.map((citation) => citation.referenceNumber),
    [1, 2]
  );
});

test("a later event without sources never erases an earlier event's sources", () => {
  const merged = mergePerplexitySearchPayloads(
    parsePerplexitySearchPayload({ citations: ["https://example.com/a"] }),
    parsePerplexitySearchPayload({ choices: [{ delta: { content: "x" } }] })
  );
  assert.deepEqual(merged.citations, ["https://example.com/a"]);
});

test("titles only attach on an exact URL match, never by position", () => {
  const metadata = buildPerplexitySearchMetadata({
    citations: ["https://example.com/a", "https://example.com/b"],
    searchResults: [{ title: "Only B", url: "https://example.com/b" }],
  });
  assert.equal(metadata.citations[0].title, undefined);
  assert.equal(metadata.citations[1].title, "Only B");
});

test("combining retried captures adds costs but keeps one citation numbering", () => {
  const first = parsePerplexityResponseCapture(nonStreamingBody());
  const second = parsePerplexityResponseCapture(
    JSON.stringify({
      usage: USAGE,
      citations: ["https://example.com/retry"],
      choices: [{ message: { content: "retry" } }],
    })
  );
  const combined = combinePerplexityResponseCaptures([first, second]);
  assert.equal(combined.usage.totalCostMicroUsd, 43_526);
  assert.equal(combined.search.citations.length, 7);
  assert.equal(combined.search.citations[0].url, CITATION_URLS[0]);
});

// --- the capture path itself -------------------------------------------

const streamOf = (chunks) => {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
};

const captureThrough = async (traceId, chunks) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(streamOf(chunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  try {
    const response = await perplexityUsageFetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: perplexityUsageHeaders(traceId),
    });
    // Drain exactly as the AI SDK would; the capture resolves on stream end.
    await response.text();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test("an SSE line split across network reads is still parsed intact", async () => {
  const body = streamingBody();
  // Cut mid-way through the final event's JSON, which is where citations,
  // search_results and usage all live.
  const cut = body.lastIndexOf("citations") + 4;
  await captureThrough("trace-split", [body.slice(0, cut), body.slice(cut)]);

  const capture = await consumePerplexityResponseCapture("trace-split");
  assert.equal(capture.search.citations.length, 7);
  assert.equal(capture.search.citations[3].referenceNumber, 4);
  assert.equal(capture.usage.totalCostMicroUsd, 21_763);
});

test("the billing-only wrapper still returns exactly the cost snapshot", async () => {
  await captureThrough("trace-billing", [nonStreamingBody()]);
  const usage = await consumePerplexityUsage("trace-billing");
  assert.equal(usage.source, "perplexity_response_usage");
  assert.equal(usage.totalCostMicroUsd, 21_763);
  assert.equal(usage.searchQueriesCostMicroUsd, 15_000);
  // Consuming is destructive for both halves, exactly as before.
  assert.equal(await consumePerplexityUsage("trace-billing"), null);
});

test("an unknown trace yields null rather than an empty capture", async () => {
  assert.equal(await consumePerplexityResponseCapture("trace-missing"), null);
  assert.equal(await consumePerplexityUsage("trace-missing"), null);
});

test("captured Perplexity citations reach the rendered execution metadata", () => {
  const { search } = parsePerplexityResponseCapture(nonStreamingBody());
  const execution = normalizeWebSearchExecution({
    capability: getWebSearchCapability("perplexity/sonar"),
    searchRequested: false,
    provider: "perplexity",
    // The AI SDK content array is where these used to be looked for, and for
    // Perplexity it is empty -- which is the whole bug.
    content: [],
    providerCitations: search.citations,
  });
  assert.equal(execution.executed, true);
  assert.equal(execution.citations.length, 7);
  assert.equal(execution.citations[3].referenceNumber, 4);
  assert.equal(execution.citations[3].url, CITATION_URLS[3]);
});
