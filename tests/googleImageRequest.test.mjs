import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleImageRequest,
  googleBillableOutputTokens,
  GOOGLE_API_KEY_HEADER,
  GOOGLE_INTERACTIONS_URL,
  parseGoogleImageResponse,
  readGoogleImageInteraction,
} from "../lib/googleImageRequest.ts";

// Contract tests for the Google image path. The adapter itself is server-only
// and needs a network; everything that decides what is sent and what is
// believed lives here, where it can be pinned without either.
//
// The models this serves are all disabled (`worst_case_cost_unbounded`), and
// generateImageWithProvider refuses a disabled model before it dispatches --
// so none of this can execute today. It is pinned now because the staging
// measurement that would lift the hold runs through exactly this code, and a
// measurement taken through a wrong request proves nothing.

const request = (overrides = {}) =>
  buildGoogleImageRequest({
    apiModelId: "gemini-3.1-flash-image",
    prompt: "a single red apple",
    size: "1024x1024",
    maxOutputTokens: 32_768,
    thinkingLevel: null,
    deliveryMimeType: "image/png",
    ...overrides,
  });

test("a 1K square request speaks the Interactions API, not GenerateContent", () => {
  // The two express the same request with different names. A body that mixes
  // them is valid-looking and wrong, so the whole shape is pinned rather than
  // a field or two.
  assert.deepEqual(request(), {
    model: "gemini-3.1-flash-image",
    input: "a single red apple",
    response_format: {
      type: "image",
      delivery: "inline",
      mime_type: "image/png",
      aspect_ratio: "1:1",
      image_size: "1K",
    },
    generation_config: { max_output_tokens: 32_768 },
  });
});

test("none of GenerateContent's field names appear anywhere in a request", () => {
  const serialized = JSON.stringify(request({ thinkingLevel: "high" }));
  for (const camel of [
    "generationConfig",
    "maxOutputTokens",
    "imageConfig",
    "inlineData",
    "candidates",
    "usageMetadata",
    "thoughtsTokenCount",
  ]) {
    assert.ok(!serialized.includes(camel), `leaked ${camel}`);
  }
});

test("thinking_level is sent only when the profile declares one", () => {
  // Support is not uniform across the three models. Sending the field to a
  // model whose acceptance of it was never verified fails in a way that reads
  // like a provider outage rather than a request we got wrong.
  assert.deepEqual(request().generation_config, { max_output_tokens: 32_768 });
  assert.deepEqual(request({ thinkingLevel: "high" }).generation_config, {
    max_output_tokens: 32_768,
    thinking_level: "high",
  });
});

test("a request without an output limit is refused, not sent open-ended", () => {
  // Policy §12 condition 2: the server must not allow a request parameter
  // outside the maximum it priced. An absent limit is not a smaller ask, it is
  // no ask at all.
  for (const maxOutputTokens of [null, 0, -1]) {
    assert.equal(request({ maxOutputTokens }), null, String(maxOutputTokens));
  }
});

test("a size with no mapping is refused rather than guessed", () => {
  // Same rule as xAI: the launch scope is 1K square, and sending a landscape
  // as though it were the same request would charge one resolution's price for
  // another's image.
  for (const size of ["1536x1024", "1024x1536"]) {
    assert.equal(request({ size }), null, size);
  }
});

test("an unknown delivery MIME is refused", () => {
  assert.equal(request({ deliveryMimeType: "image/gif" }), null);
  assert.equal(request({ deliveryMimeType: "" }), null);
});

test("authentication is Google's own header, not a bearer token", () => {
  assert.equal(GOOGLE_API_KEY_HEADER, "x-goog-api-key");
  assert.equal(
    GOOGLE_INTERACTIONS_URL,
    "https://generativelanguage.googleapis.com/v1beta/interactions"
  );
});

// ---------------------------------------------------------------------------
// Response reading.

const imageStep = (data, mime = "image/png") => ({
  type: "model_output",
  content: [{ type: "image", data, mime_type: mime }],
});

const usage = {
  total_input_tokens: 12,
  total_output_tokens: 1_290,
  total_thought_tokens: 456,
  total_tokens: 1_758,
};

test("the delivered image and both usage counters are read", () => {
  assert.deepEqual(
    parseGoogleImageResponse({ steps: [imageStep("AAAA", "image/jpeg")], usage }),
    {
      imageBase64: "AAAA",
      mimeType: "image/jpeg",
      usage: { inputTokens: 12, outputTokens: 1_290, thinkingTokens: 456 },
    }
  );
});

test("an image produced while thinking is never mistaken for the answer", () => {
  // A thinking model can emit images as part of its reasoning. Both are
  // plausible pictures, so billing the user for the finished image while
  // storing a working sketch is the failure nobody would notice.
  const payload = {
    steps: [
      { type: "thought", content: [{ type: "image", data: "SKETCH" }] },
      imageStep("ANSWER"),
    ],
    usage,
  };
  assert.equal(parseGoogleImageResponse(payload).imageBase64, "ANSWER");

  // ...and a response whose only image is a thought is not an answer at all.
  assert.equal(
    parseGoogleImageResponse({
      steps: [{ type: "thought", content: [{ type: "image", data: "SKETCH" }] }],
      usage,
    }),
    null
  );
});

test("more than one delivered image fails closed instead of picking one", () => {
  // The fixed price buys one image. Several means the contract is not the one
  // that was priced, and choosing among them would hide exactly that.
  assert.equal(
    parseGoogleImageResponse({
      steps: [
        {
          type: "model_output",
          content: [
            { type: "image", data: "A", mime_type: "image/png" },
            { type: "image", data: "B", mime_type: "image/png" },
          ],
        },
      ],
      usage,
    }),
    null
  );
});

test("non-image content in the model output is ignored, not read as bytes", () => {
  assert.equal(
    parseGoogleImageResponse({
      steps: [
        {
          type: "model_output",
          content: [
            { type: "text", text: "here you go" },
            { type: "image", data: "AAAA", mime_type: "image/png" },
          ],
        },
      ],
      usage,
    }).imageBase64,
    "AAAA"
  );
});

test("a missing or unexpected MIME fails the response instead of defaulting", () => {
  for (const mime of [undefined, "", "image/gif", 7]) {
    assert.equal(
      parseGoogleImageResponse({
        steps: [{ type: "model_output", content: [{ type: "image", data: "AAAA", mime_type: mime }] }],
        usage,
      }),
      null,
      String(mime)
    );
  }
});

test("an empty or malformed payload is refused, never half-read", () => {
  for (const payload of [null, undefined, {}, "nope", { steps: [] }, { steps: "x" }]) {
    assert.equal(
      parseGoogleImageResponse(payload),
      null,
      JSON.stringify(payload ?? null)
    );
  }
});

test("absent usage reads as zero rather than throwing", () => {
  // A response that omits usage is not a reason to lose the image. Zero is
  // honest here in a way it is not for a price: nothing was reported.
  assert.deepEqual(
    parseGoogleImageResponse({ steps: [imageStep("AAAA")] }).usage,
    { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 }
  );
});

test("the billable output sum excludes input tokens", () => {
  // total_tokens includes the input, so comparing it with max_output_tokens
  // would be comparing the wrong quantity -- and would make an unbounded
  // model look bounded, or the reverse, depending on prompt length.
  assert.equal(
    googleBillableOutputTokens({
      inputTokens: 12,
      outputTokens: 1_290,
      thinkingTokens: 456,
    }),
    1_746
  );
});

test("the audit snapshot of a request excludes the prompt", () => {
  // Google carries the prompt in `input`, not `prompt`. The adapter's filter
  // has to know that: a body whose prompt field is named differently would
  // otherwise copy user text into the stored request snapshot, which is a
  // second place every deletion path would have to reach (policy §10).
  const body = request();
  const audited = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "prompt" && key !== "input")
  );
  assert.ok(!JSON.stringify(audited).includes("a single red apple"));
  // Everything that decides what was asked for survives.
  assert.deepEqual(Object.keys(audited).sort(), [
    "generation_config",
    "model",
    "response_format",
  ]);
});

test("the delivery MIME is a request preference, not the storage allowlist's head", () => {
  // Every Google request went out asking for PNG because the adapter read
  // `outputMimeTypes[0]`, which is the list of types it may *store* -- and the
  // API refuses PNG outright:
  //
  //   "The value 'image/png' is not supported for
  //    'response_format.mime_type'. Supported values: 'image/jpeg'."
  //
  // So every one of them 400'd. The two ideas are separate fields now, and
  // this pins that the request carries what it is given rather than a guess.
  const body = request({ deliveryMimeType: "image/jpeg" });
  assert.equal(body.response_format.mime_type, "image/jpeg");
  assert.notEqual(body.response_format.mime_type, "image/png");
});

// Reading the same response for evidence rather than for an image.

test("a response that ran out of room keeps its usage, having no image", () => {
  // The sample the measurement most wants to buy is the one where the limit
  // actually bit: thinking consumed the budget and no image was finished.
  // parseGoogleImageResponse fails closed on it -- correctly, there is nothing
  // to bill for -- and routing the measurement through that parser alone threw
  // the usage away with it, filing the most informative sample as unreadable.
  const payload = {
    status: "incomplete",
    steps: [{ type: "thinking", content: [] }],
    usage: {
      total_input_tokens: 12,
      total_output_tokens: 400,
      total_thought_tokens: 200,
    },
  };
  assert.equal(parseGoogleImageResponse(payload), null);

  const interaction = readGoogleImageInteraction(payload);
  assert.deepEqual(interaction.usage, {
    inputTokens: 12,
    outputTokens: 400,
    thinkingTokens: 200,
  });
  assert.equal(interaction.status, "incomplete");
  assert.equal(interaction.modelOutputImageCount, 0);
  assert.deepEqual(interaction.stepTypes, ["thinking"]);
  // 600 against a limit of 512 is the counterexample the whole run is for.
  assert.equal(googleBillableOutputTokens(interaction.usage), 600);
});

test("the evidence reader counts images without ever accepting one", () => {
  const interaction = readGoogleImageInteraction({
    steps: [imageStep("AAAA", "image/jpeg"), imageStep("BBBB", "image/jpeg")],
    usage,
  });
  // Two images fail the strict parser. Here the count is reported so the
  // anomaly is visible in the evidence rather than swallowed.
  assert.equal(parseGoogleImageResponse({ steps: [imageStep("AAAA"), imageStep("BBBB")], usage }), null);
  assert.equal(interaction.modelOutputImageCount, 2);
  // No image, no MIME, no bytes: this reader never yields something storable,
  // so it cannot become a back door around the strict parser.
  assert.deepEqual(Object.keys(interaction).sort(), [
    "modelOutputImageCount",
    "status",
    "stepTypes",
    "usage",
  ]);
});

test("only model output counts as a delivered image, in both readers", () => {
  const thinkingOnly = {
    steps: [{ type: "thinking", content: [{ type: "image", data: "AAAA", mime_type: "image/jpeg" }] }],
    usage,
  };
  assert.equal(parseGoogleImageResponse(thinkingOnly), null);
  assert.equal(readGoogleImageInteraction(thinkingOnly).modelOutputImageCount, 0);
});

test("a response with no usage is distinguishable from one billing zero", () => {
  // Both read as zero counters, and the measurement treats zero as "nothing
  // was measured" rather than as a very low sample -- paying for more of them
  // is how a run spends its budget on nothing.
  const interaction = readGoogleImageInteraction({ steps: [] });
  assert.deepEqual(interaction.usage, {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
  });
  assert.equal(interaction.status, null);
  assert.deepEqual(interaction.stepTypes, []);
  assert.equal(readGoogleImageInteraction(null), null);
  assert.equal(readGoogleImageInteraction("{}"), null);
});
