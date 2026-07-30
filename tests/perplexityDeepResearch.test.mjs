import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEP_RESEARCH_DEPTH_PARAMS,
  describeDeepResearchMessages,
  PerplexityDeepResearchError,
  PerplexityDeepResearchMessageError,
  pollDeepResearchJob,
  submitDeepResearchJob,
  toPlainDeepResearchMessages,
} from "../lib/perplexityDeepResearch.ts";

test("DEEP_RESEARCH_DEPTH_PARAMS: standard matches the flat values this integration already ran successfully with", () => {
  assert.deepEqual(DEEP_RESEARCH_DEPTH_PARAMS.standard, {
    maxOutputTokens: 24_000,
    reasoningEffort: "high",
  });
});

test("DEEP_RESEARCH_DEPTH_PARAMS: each tier has a genuinely different, increasing token cap", () => {
  const { quick, standard, deep } = DEEP_RESEARCH_DEPTH_PARAMS;
  assert.ok(quick.maxOutputTokens < standard.maxOutputTokens);
  assert.ok(standard.maxOutputTokens < deep.maxOutputTokens);
  // "quick" deliberately doesn't force high reasoning effort -- distinct
  // real behavior, not just a relabeled copy of "standard".
  assert.equal(quick.reasoningEffort, undefined);
  assert.equal(deep.reasoningEffort, "high");
});

const withMockFetch = async (impl, run) => {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await run();
  } finally {
    global.fetch = original;
  }
};

const withApiKey = async (run) => {
  const original = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = "test-key";
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = original;
  }
};

test("toPlainDeepResearchMessages drops non-text parts and tool/other roles", () => {
  const result = toPlainDeepResearchMessages([
    { role: "system", content: "Be concise." },
    {
      role: "user",
      content: [
        { type: "text", text: "What happened in " },
        { type: "text", text: "the news today?" },
        { type: "image", image: "data:..." },
      ],
    },
    { role: "assistant", content: "" },
    { role: "tool", content: "tool output" },
  ]);

  assert.deepEqual(result, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "What happened in \nthe news today?" },
  ]);
});

test("toPlainDeepResearchMessages merges consecutive same-role turns for Perplexity's strict alternation rule", () => {
  // Perplexity's async endpoint (unlike the OpenAI-compatible sync path every
  // other model uses) 400s on two consecutive same-role messages -- e.g. a
  // dropped empty assistant turn or a filtered-out tool message can leave two
  // user turns adjacent in this app's stored history.
  const result = toPlainDeepResearchMessages([
    { role: "system", content: "Be concise." },
    { role: "system", content: "Cite sources." },
    { role: "user", content: "First question." },
    { role: "user", content: "Actually, also consider this." },
    { role: "assistant", content: "" },
    { role: "tool", content: "tool output" },
    { role: "user", content: "Follow-up question." },
  ]);

  assert.deepEqual(result, [
    { role: "system", content: "Be concise.\n\nCite sources." },
    {
      role: "user",
      content: "First question.\n\nActually, also consider this.\n\nFollow-up question.",
    },
  ]);
});

// The staging regression: components/chat/ChatApp.tsx keeps a UI-only
// greeting bubble in an empty conversation, and the send path used to post it
// alongside the first real question. Perplexity's async endpoint answered
// every such submit with 400 invalid_message -- "after the (optional) system
// message(s), user or tool message(s) should alternate with assistant
// message(s)" -- which app/api/chat/route.ts turned into a 502. The client no
// longer sends it; these pin the server-side guarantee independently of that.
test("toPlainDeepResearchMessages drops a leading assistant placeholder so the conversation starts with the user", () => {
  assert.deepEqual(
    toPlainDeepResearchMessages([
      { role: "assistant", content: "Welcome! Ask me anything." },
      { role: "user", content: "Research the 2026 solid-state battery market." },
    ]),
    [{ role: "user", content: "Research the 2026 solid-state battery market." }]
  );
});

test("toPlainDeepResearchMessages keeps a leading system message but drops the assistant placeholder after it", () => {
  assert.deepEqual(
    toPlainDeepResearchMessages([
      { role: "system", content: "Be concise." },
      { role: "assistant", content: "Welcome! Ask me anything." },
      { role: "user", content: "Research X." },
    ]),
    [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Research X." },
    ]
  );
});

test("toPlainDeepResearchMessages drops every leading assistant turn, not just the first", () => {
  assert.deepEqual(
    toPlainDeepResearchMessages([
      { role: "assistant", content: "Welcome!" },
      { role: "assistant", content: "Pick a model to begin." },
      { role: "user", content: "Research X." },
      { role: "assistant", content: "Here is what I found." },
      { role: "user", content: "Go deeper on the supply chain." },
    ]),
    [
      { role: "user", content: "Research X." },
      { role: "assistant", content: "Here is what I found." },
      { role: "user", content: "Go deeper on the supply chain." },
    ]
  );
});

test("toPlainDeepResearchMessages leaves a well-formed conversation untouched", () => {
  const conversation = [
    { role: "user", content: "Research X." },
    { role: "assistant", content: "Here is what I found." },
    { role: "user", content: "Go deeper on the supply chain." },
  ];

  assert.deepEqual(toPlainDeepResearchMessages(conversation), conversation);
});

test("toPlainDeepResearchMessages merges the user turns that dropping empty and tool messages leaves adjacent", () => {
  assert.deepEqual(
    toPlainDeepResearchMessages([
      { role: "user", content: "Research X." },
      { role: "assistant", content: "" },
      { role: "tool", content: "tool output" },
      { role: "user", content: "Also cover Y." },
    ]),
    [{ role: "user", content: "Research X.\n\nAlso cover Y." }]
  );
});

test("toPlainDeepResearchMessages ends on a user turn, never on a trailing assistant reply", () => {
  assert.deepEqual(
    toPlainDeepResearchMessages([
      { role: "user", content: "Research X." },
      { role: "assistant", content: "Here is what I found." },
    ]),
    [{ role: "user", content: "Research X." }]
  );
});

test("toPlainDeepResearchMessages rejects a conversation with no user turn", () => {
  assert.throws(
    () =>
      toPlainDeepResearchMessages([
        { role: "system", content: "Be concise." },
        { role: "assistant", content: "Welcome! Ask me anything." },
      ]),
    PerplexityDeepResearchMessageError
  );
});

test("describeDeepResearchMessages reports the request shape without any message content", () => {
  const metadata = describeDeepResearchMessages([
    { role: "assistant", content: "Welcome! Ask me anything." },
    { role: "user", content: "A secret question nobody may log." },
  ]);

  assert.equal(metadata.hasLeadingAssistant, true);
  assert.equal(metadata.droppedLeadingAssistantCount, 1);
  assert.equal(metadata.inputMessageCount, 2);
  assert.equal(metadata.inputRoleSequence, "au");
  assert.equal(metadata.normalizedMessageCount, 1);
  assert.equal(metadata.normalizedRoleSequence, "u");
  assert.ok(
    !JSON.stringify(metadata).includes("secret"),
    "message content leaked into the loggable metadata"
  );
});

test("submitDeepResearchJob sends Perplexity a conversation that starts with a user turn and strictly alternates", async () => {
  await withApiKey(() =>
    withMockFetch(
      async (url, init) => {
        const { messages } = JSON.parse(init.body).request;
        const conversation = messages.filter(
          (message) => message.role !== "system"
        );

        assert.deepEqual(
          messages.filter((message) => message.role === "system"),
          [{ role: "system", content: "Be concise." }],
          "system messages must stay ahead of the conversation"
        );
        assert.equal(conversation[0].role, "user");
        assert.equal(conversation[conversation.length - 1].role, "user");
        for (const [index, message] of conversation.entries()) {
          assert.equal(
            message.role,
            index % 2 === 0 ? "user" : "assistant",
            `message ${index} broke the user/assistant alternation`
          );
        }

        return { ok: true, json: async () => ({ id: "job-123" }) };
      },
      async () => {
        await submitDeepResearchJob({
          messages: [
            { role: "system", content: "Be concise." },
            { role: "assistant", content: "Welcome! Ask me anything." },
            { role: "user", content: "Research X." },
            { role: "assistant", content: "Here is what I found." },
            { role: "tool", content: "tool output" },
            { role: "user", content: "Go deeper." },
            { role: "user", content: "Cover pricing too." },
          ],
          maxOutputTokens: 24_000,
        });
      }
    )
  );
});

test("submitDeepResearchJob fails locally, without calling fetch, when no user turn survives", async () => {
  let fetchCalls = 0;

  await withApiKey(() =>
    withMockFetch(
      async () => {
        fetchCalls += 1;
        return { ok: true, json: async () => ({ id: "job-123" }) };
      },
      async () => {
        await assert.rejects(
          () =>
            submitDeepResearchJob({
              messages: [
                { role: "assistant", content: "Welcome! Ask me anything." },
                { role: "user", content: "   " },
              ],
              maxOutputTokens: 24_000,
            }),
          PerplexityDeepResearchMessageError
        );
      }
    )
  );

  assert.equal(fetchCalls, 0, "a malformed request reached Perplexity");
});

test("submitDeepResearchJob posts the async endpoint and returns the job id", async () => {
  await withApiKey(() =>
    withMockFetch(
      async (url, init) => {
        assert.equal(url, "https://api.perplexity.ai/v1/async/sonar");
        const body = JSON.parse(init.body);
        assert.equal(body.request.model, "sonar-deep-research");
        assert.equal(body.request.max_tokens, 24_000);
        assert.equal(body.request.reasoning_effort, "high");
        return {
          ok: true,
          json: async () => ({ id: "job-123", status: "CREATED" }),
        };
      },
      async () => {
        const result = await submitDeepResearchJob({
          messages: [{ role: "user", content: "Research X" }],
          maxOutputTokens: 24_000,
          reasoningEffort: "high",
        });
        assert.deepEqual(result, { perplexityJobId: "job-123" });
      }
    )
  );
});

test("submitDeepResearchJob throws on a non-2xx response", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => ({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      }),
      async () => {
        await assert.rejects(
          () =>
            submitDeepResearchJob({
              messages: [{ role: "user", content: "hi" }],
              maxOutputTokens: 1_000,
            }),
          PerplexityDeepResearchError
        );
      }
    )
  );
});

test("submitDeepResearchJob throws when the response has no job id", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => ({ ok: true, json: async () => ({}) }),
      async () => {
        await assert.rejects(
          () =>
            submitDeepResearchJob({
              messages: [{ role: "user", content: "hi" }],
              maxOutputTokens: 1_000,
            }),
          PerplexityDeepResearchError
        );
      }
    )
  );
});

test("pollDeepResearchJob reports in-progress states without content", async () => {
  await withApiKey(() =>
    withMockFetch(
      async (url) => {
        assert.equal(url, "https://api.perplexity.ai/v1/async/sonar/job-123");
        return { ok: true, json: async () => ({ status: "IN_PROGRESS" }) };
      },
      async () => {
        const result = await pollDeepResearchJob("job-123");
        assert.deepEqual(result, { status: "IN_PROGRESS" });
      }
    )
  );
});

test("pollDeepResearchJob defaults an unrecognized status to IN_PROGRESS", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => ({ ok: true, json: async () => ({ status: "WEIRD_FUTURE_STATUS" }) }),
      async () => {
        const result = await pollDeepResearchJob("job-123");
        assert.equal(result.status, "IN_PROGRESS");
      }
    )
  );
});

test("pollDeepResearchJob parses a completed job's content and usage cost", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => ({
        ok: true,
        json: async () => ({
          status: "COMPLETED",
          response: {
            choices: [{ message: { content: "Final report text." } }],
            usage: {
              prompt_tokens: 500,
              completion_tokens: 1_200,
              cost: { total_cost: 0.045 },
            },
          },
        }),
      }),
      async () => {
        const result = await pollDeepResearchJob("job-123");
        assert.equal(result.status, "COMPLETED");
        assert.equal(result.content, "Final report text.");
        assert.equal(result.inputTokens, 500);
        assert.equal(result.outputTokens, 1_200);
        assert.equal(result.usageSnapshot?.totalCostMicroUsd, 45_000);
      }
    )
  );
});

test("pollDeepResearchJob treats a completed job with no message as an empty result", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => ({
        ok: true,
        json: async () => ({ status: "COMPLETED", response: { choices: [] } }),
      }),
      async () => {
        const result = await pollDeepResearchJob("job-123");
        assert.equal(result.status, "COMPLETED");
        assert.equal(result.content, "");
      }
    )
  );
});

test("pollDeepResearchJob surfaces the provider's failure message", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => ({
        ok: true,
        json: async () => ({
          status: "FAILED",
          error_message: "The model could not complete this request.",
        }),
      }),
      async () => {
        const result = await pollDeepResearchJob("job-123");
        assert.deepEqual(result, {
          status: "FAILED",
          errorMessage: "The model could not complete this request.",
        });
      }
    )
  );
});

test("pollDeepResearchJob throws on a non-2xx response", async () => {
  await withApiKey(() =>
    withMockFetch(
      async () => ({ ok: false, status: 500, text: async () => "boom" }),
      async () => {
        await assert.rejects(
          () => pollDeepResearchJob("job-123"),
          PerplexityDeepResearchError
        );
      }
    )
  );
});
