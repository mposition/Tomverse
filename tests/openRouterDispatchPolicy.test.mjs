import assert from "node:assert/strict";
import test from "node:test";

import { getActiveAiModel } from "../lib/activeAiModel.ts";
import {
  OpenRouterDispatchError,
  decideOpenRouterDispatch,
  openRouterPinnedFetch,
  pinOpenRouterChatBody,
} from "../lib/modelRegistryShared.ts";

const admitted = {
  recipient: "deepinfra",
  allowlist: ["deepinfra", "together"],
  failedProviders: [],
};

test("no admission is a refusal, not an open route", () => {
  assert.deepEqual(decideOpenRouterDispatch(undefined), {
    ok: false,
    code: "OPENROUTER_ADMISSION_REQUIRED",
  });
});

test("an empty allowlist refuses every recipient", () => {
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, allowlist: [] }).code,
    "OPENROUTER_RECIPIENT_ALLOWLIST_REQUIRED"
  );
});

test("a recipient off the allowlist is refused", () => {
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, recipient: "together" }).ok,
    true
  );
  assert.equal(
    decideOpenRouterDispatch({
      ...admitted,
      recipient: "deepseek",
    }).code,
    "OPENROUTER_RECIPIENT_NOT_ALLOWED"
  );
});

test("slugs are the documented lowercase form, not a folded guess", () => {
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, recipient: "DeepInfra" }).code,
    "OPENROUTER_RECIPIENT_INVALID"
  );
  assert.equal(
    decideOpenRouterDispatch({
      ...admitted,
      failedProviders: ["DeepSeek"],
    }).code,
    "OPENROUTER_FAILED_PROVIDER_INVALID"
  );
});

test("a host that already failed this response cannot be the recipient", () => {
  assert.equal(
    decideOpenRouterDispatch({
      ...admitted,
      failedProviders: ["deepinfra"],
    }).code,
    "OPENROUTER_FAILED_PROVIDER_EXCLUDED"
  );
});

test("an admitted pin is one host and fallbacks off", () => {
  const decision = decideOpenRouterDispatch({
    ...admitted,
    failedProviders: ["deepseek"],
  });
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.pin, {
    only: ["deepinfra"],
    allow_fallbacks: false,
    ignore: ["deepseek"],
  });
});

test("the wire body replaces a wider provider object instead of merging it", () => {
  const decision = decideOpenRouterDispatch(admitted);
  const pinned = pinOpenRouterChatBody(
    JSON.stringify({
      model: "moonshotai/kimi-k3",
      messages: [{ role: "user", content: "hello" }],
      provider: { only: ["deepseek", "deepinfra"], allow_fallbacks: true },
    }),
    decision.pin
  );
  assert.equal(pinned.ok, true);
  const body = JSON.parse(pinned.body);
  assert.deepEqual(body.provider, {
    only: ["deepinfra"],
    allow_fallbacks: false,
  });
  assert.equal(body.messages[0].content, "hello");
});

test("a body that is not a JSON object is not sent", () => {
  const decision = decideOpenRouterDispatch(admitted);
  assert.equal(
    pinOpenRouterChatBody("not-json", decision.pin).code,
    "OPENROUTER_BODY_NOT_PINNABLE"
  );
  assert.equal(
    pinOpenRouterChatBody("[]", decision.pin).code,
    "OPENROUTER_BODY_NOT_PINNABLE"
  );
});

test("the fetch wrapper does not call the network when the body cannot be pinned", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("no");
  };
  const decision = decideOpenRouterDispatch(admitted);
  const pinnedFetch = openRouterPinnedFetch(decision.pin, fetchImpl);
  await assert.rejects(
    () => pinnedFetch("https://openrouter.ai/api/v1/chat/completions", { body: new Uint8Array() }),
    (error) =>
      error instanceof OpenRouterDispatchError &&
      error.code === "OPENROUTER_BODY_NOT_PINNABLE" &&
      error.message === "OPENROUTER_BODY_NOT_PINNABLE"
  );
  assert.equal(called, false);
});

test("the fetch wrapper sends the pin and nothing from a previous provider object", async () => {
  let seen = "";
  const fetchImpl = async (_input, init) => {
    seen = init.body;
    return new Response("{}");
  };
  const decision = decideOpenRouterDispatch({
    ...admitted,
    failedProviders: ["novita"],
  });
  const pinnedFetch = openRouterPinnedFetch(decision.pin, fetchImpl);
  await pinnedFetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "moonshotai/kimi-k3",
      messages: [{ role: "user", content: "hello" }],
      provider: { order: ["deepseek"], allow_fallbacks: true },
    }),
  });
  assert.deepEqual(JSON.parse(seen).provider, {
    only: ["deepinfra"],
    allow_fallbacks: false,
    ignore: ["novita"],
  });
});

test("the chat adapter refuses OpenRouter before building a client", () => {
  assert.throws(
    () =>
      getActiveAiModel({
        provider: "openrouter",
        apiModel: "moonshotai/kimi-k3",
      }),
    (error) =>
      error instanceof Error &&
      error.name === "OpenRouterDispatchError" &&
      error.code === "OPENROUTER_ADMISSION_REQUIRED"
  );
});

test("an admitted OpenRouter model is a client and has not been called", () => {
  const model = getActiveAiModel(
    {
      provider: "openrouter",
      apiModel: "moonshotai/kimi-k3",
    },
    {
      recipient: "deepinfra",
      allowlist: ["deepinfra"],
      failedProviders: [],
    }
  );
  assert.equal(typeof model, "object");
  assert.ok(model);
});
