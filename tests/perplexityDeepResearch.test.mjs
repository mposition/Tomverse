import assert from "node:assert/strict";
import test from "node:test";
import {
  PerplexityDeepResearchError,
  pollDeepResearchJob,
  submitDeepResearchJob,
  toPlainDeepResearchMessages,
} from "../lib/perplexityDeepResearch.ts";

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
