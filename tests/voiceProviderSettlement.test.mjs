import assert from "node:assert/strict";
import test from "node:test";

import {
  dispositionFor,
  readTranscriptionUsage,
  transcribeWithOpenAi,
} from "../lib/voiceTranscriptionPortCore.ts";
import {
  voiceSettlementRelease,
  VOICE_GUARDRAIL_DEFAULTS,
} from "../lib/voiceInputGuardrails.ts";

/**
 * What the provider actually reports, and what a reservation may be closed on:
 * docs/policy/voice-input.md §7.2 and §7.3.
 *
 * ## The defect these were written for
 *
 * The adapter asked for `response_format: "json"` and read a top-level
 * `duration`. Per the official API reference (OpenAI, `POST
 * /v1/audio/transcriptions`, read 2026-08-31) `duration` belongs to
 * `TranscriptionVerbose` — the `verbose_json` response — and not to the `json`
 * one. So `durationSeconds` was `null` on every successful call, and the
 * settlement that claimed to move a reservation to "what the provider billed"
 * never moved anything.
 *
 * The same reference gives the `usage` object two shapes: `{type: "duration",
 * seconds}` and `{type: "tokens", input_tokens, output_tokens, total_tokens}`.
 * The configured default model, `gpt-4o-mini-transcribe`, is token-billed — so
 * for this deployment there are no provider-reported seconds at all, and the
 * budget must say so rather than invent them.
 */

const call = (body, init = { status: 200 }) =>
  transcribeWithOpenAi(
    {
      audio: new Uint8Array([1, 2, 3]),
      mediaType: "audio/webm",
      extension: "webm",
      languageHint: null,
    },
    {
      apiKey: "k",
      model: "gpt-4o-mini-transcribe",
      fetchImpl: async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), init),
    }
  );

// ---------------------------------------------------------------------------
// Reading usage
// ---------------------------------------------------------------------------

test("a duration-billed model's usage is read as seconds", () => {
  assert.deepEqual(
    readTranscriptionUsage({ text: "x", usage: { type: "duration", seconds: 12.5 } }),
    { kind: "duration", seconds: 12.5 }
  );
});

test("a token-billed model's usage is read as tokens and never as seconds", () => {
  const usage = readTranscriptionUsage({
    text: "x",
    usage: {
      type: "tokens",
      input_tokens: 40,
      output_tokens: 8,
      total_tokens: 48,
    },
  });

  assert.equal(usage.kind, "tokens");
  assert.equal(usage.inputTokens, 40);
  assert.equal(usage.outputTokens, 8);
  assert.ok(
    !("seconds" in usage),
    "tokens must never acquire a seconds field; converting one to the other invents a rate"
  );
});

test("a verbose_json top-level duration is still read", () => {
  // This port asks for `json`, so it is normally absent — read anyway, so a
  // deployment that changes response_format does not silently lose it.
  assert.deepEqual(readTranscriptionUsage({ text: "x", duration: 3.25 }), {
    kind: "duration",
    seconds: 3.25,
  });
});

test("a response that reports nothing is absent, not zero", () => {
  assert.deepEqual(readTranscriptionUsage({ text: "x" }), { kind: "absent" });
  assert.deepEqual(readTranscriptionUsage(null), { kind: "absent" });
});

test("a malformed usage is absent rather than a measurement", () => {
  for (const usage of [
    { type: "duration", seconds: -4 },
    { type: "duration", seconds: "12" },
    { type: "duration", seconds: Number.NaN },
    { type: "duration" },
    { type: "something-new", seconds: 5 },
  ]) {
    assert.deepEqual(
      readTranscriptionUsage({ text: "x", usage }),
      { kind: "absent" },
      JSON.stringify(usage)
    );
  }
});

test("a malformed top-level duration is absent", () => {
  for (const duration of [-5, Number.NaN, "3", null]) {
    assert.deepEqual(readTranscriptionUsage({ text: "x", duration }), {
      kind: "absent",
    });
  }
});

test("token counts that are not counts become null rather than zero", () => {
  const usage = readTranscriptionUsage({
    text: "x",
    usage: { type: "tokens", input_tokens: -1, output_tokens: "8" },
  });
  assert.deepEqual(usage, { kind: "tokens", inputTokens: null, outputTokens: null });
});

test("the realistic response of the configured model yields token usage", async () => {
  const result = await call({
    text: "안녕하세요",
    usage: { type: "tokens", input_tokens: 40, output_tokens: 8, total_tokens: 48 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "안녕하세요");
  assert.equal(result.usage.kind, "tokens");
});

// ---------------------------------------------------------------------------
// Disposition: what a failure proves about the bill
// ---------------------------------------------------------------------------

test("only an unsent request is certainly free", () => {
  assert.equal(dispositionFor("provider_not_configured"), "not_sent");
});

test("a provider that answered with a refusal did no billable work", () => {
  assert.equal(dispositionFor("provider_rejected_credentials"), "refused");
  assert.equal(dispositionFor("provider_rejected_audio"), "refused");
  assert.equal(dispositionFor("provider_rate_limited"), "refused");
});

test("a call whose answer never came back proves nothing", () => {
  // The defect: these three used to release the whole reservation, on the
  // assumption that a failure means no bill. A timeout is not that evidence,
  // and a 2xx we could not parse was almost certainly transcribed.
  assert.equal(dispositionFor("provider_unreachable"), "indeterminate");
  assert.equal(dispositionFor("provider_response_unreadable"), "indeterminate");
  assert.equal(dispositionFor("provider_unavailable"), "indeterminate");
});

test("a rate limit and a server error are classified apart", async () => {
  const rateLimited = await call("{}", { status: 429 });
  const serverError = await call("{}", { status: 503 });

  assert.equal(rateLimited.code, "provider_rate_limited");
  assert.equal(rateLimited.disposition, "refused");
  assert.equal(serverError.code, "provider_unavailable");
  assert.equal(
    serverError.disposition,
    "indeterminate",
    "a 5xx may be a transcription that failed on the way back"
  );
});

test("every failure carries a disposition", async () => {
  const cases = [
    await call("{}", { status: 400 }),
    await call("{}", { status: 401 }),
    await call("{}", { status: 429 }),
    await call("{}", { status: 500 }),
    await call("not json", { status: 200 }),
    await call({ text: 42 }, { status: 200 }),
  ];
  for (const result of cases) {
    assert.equal(result.ok, false);
    assert.ok(
      ["not_sent", "refused", "indeterminate"].includes(result.disposition),
      JSON.stringify(result)
    );
  }
});

test("a transport failure is indeterminate, not free", async () => {
  const result = await transcribeWithOpenAi(
    {
      audio: new Uint8Array([1]),
      mediaType: "audio/webm",
      extension: "webm",
      languageHint: null,
    },
    {
      apiKey: "k",
      model: "m",
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    }
  );

  assert.deepEqual(result, {
    ok: false,
    code: "provider_unreachable",
    status: null,
    disposition: "indeterminate",
  });
});

// ---------------------------------------------------------------------------
// Settlement arithmetic
// ---------------------------------------------------------------------------

test("a known-unbilled call gives everything back", () => {
  assert.equal(
    voiceSettlementRelease({ reservedSeconds: 120, basis: { kind: "not_billed" } }),
    120
  );
});

test("an indeterminate call keeps its reservation", () => {
  // The behaviour change §7.2 records: an outcome nobody can account for is
  // not evidence of a free call, so the conservative booking stands.
  assert.equal(
    voiceSettlementRelease({ reservedSeconds: 120, basis: { kind: "reservation" } }),
    0
  );
});

test("provider-reported seconds settle the reservation down to them", () => {
  assert.equal(
    voiceSettlementRelease({
      reservedSeconds: 120,
      basis: { kind: "provider_seconds", seconds: 12.2 },
    }),
    107,
    "12.2s rounds up to 13 billed, so 107 of 120 comes back"
  );
});

test("a clip we measured ourselves settles the same way", () => {
  assert.equal(
    voiceSettlementRelease({
      reservedSeconds: 120,
      basis: { kind: "measured_clip", seconds: 30 },
    }),
    90
  );
});

test("a reported duration larger than the reservation releases nothing", () => {
  // A provider cannot use an impossible number to book more than this request
  // ever held, nor to reach anybody else's budget.
  assert.equal(
    voiceSettlementRelease({
      reservedSeconds: 20,
      basis: { kind: "provider_seconds", seconds: 9_999 },
    }),
    0
  );
});

test("a negative or malformed duration is not treated as a free call", () => {
  // The old arithmetic turned a negative into zero billed seconds and released
  // the whole reservation, making a broken response the cheapest outcome.
  for (const seconds of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      voiceSettlementRelease({
        reservedSeconds: 120,
        basis: { kind: "provider_seconds", seconds },
      }),
      0,
      String(seconds)
    );
  }
});

test("a zero-second report releases everything but never more", () => {
  assert.equal(
    voiceSettlementRelease({
      reservedSeconds: 120,
      basis: { kind: "provider_seconds", seconds: 0 },
    }),
    120
  );
  assert.equal(
    voiceSettlementRelease({ reservedSeconds: 0, basis: { kind: "not_billed" } }),
    0
  );
});

test("the guardrail is still denominated in seconds and names no credit", () => {
  // AGENTS.md, "Credit entitlement vs operational guardrail": this layer must
  // not acquire a user-facing price while §6 is open.
  assert.equal(typeof VOICE_GUARDRAIL_DEFAULTS.secondsPerDay, "number");
  assert.ok(!("creditsPerDay" in VOICE_GUARDRAIL_DEFAULTS));
  assert.ok(!("costMicroUsd" in VOICE_GUARDRAIL_DEFAULTS));
});
