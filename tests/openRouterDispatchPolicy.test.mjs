import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getActiveAiModel } from "../lib/activeAiModel.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  DEPLOYMENT_ONLY_PROVIDERS,
  OpenRouterDispatchError,
  catalogueHostRefusalCode,
  decideOpenRouterDispatch,
  openRouterPinnedFetch,
  pinOpenRouterChatBody,
  readOpenRouterRecipientAllowlist,
} from "../lib/modelRegistryShared.ts";

const allowlist = ["deepinfra", "together", "deepinfra/turbo", "google-vertex/us-east5"];
const admitted = {
  recipient: "deepinfra",
  failedProviders: [],
};

const withAllowlist = (value, run) => {
  const key = "OPENROUTER_RECIPIENT_ALLOWLIST";
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
};

test("no admission is a refusal, not an open route", () => {
  assert.deepEqual(decideOpenRouterDispatch(undefined, allowlist), {
    ok: false,
    code: "OPENROUTER_ADMISSION_REQUIRED",
  });
});

test("an empty allowlist refuses every recipient", () => {
  assert.equal(
    decideOpenRouterDispatch(admitted, []).code,
    "OPENROUTER_RECIPIENT_ALLOWLIST_REQUIRED"
  );
});

test("a recipient off the allowlist is refused", () => {
  assert.equal(decideOpenRouterDispatch(admitted, allowlist).ok, true);
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, recipient: "deepseek" }, allowlist).code,
    "OPENROUTER_RECIPIENT_NOT_ALLOWED"
  );
});

test("slugs are the documented lowercase form, not a folded guess", () => {
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, recipient: "DeepInfra" }, allowlist).code,
    "OPENROUTER_RECIPIENT_INVALID"
  );
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, failedProviders: ["DeepSeek"] }, allowlist).code,
    "OPENROUTER_FAILED_PROVIDER_INVALID"
  );
});

test("a variant slug is a recipient, and a failed variant can be ignored", () => {
  const decision = decideOpenRouterDispatch(
    { recipient: "deepinfra/turbo", failedProviders: ["google-vertex/us-east5"] },
    allowlist
  );
  assert.deepEqual(decision.pin, {
    only: ["deepinfra/turbo"],
    allow_fallbacks: false,
    ignore: ["google-vertex/us-east5"],
  });
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, recipient: "deepinfra/turbo/extra" }, allowlist).code,
    "OPENROUTER_RECIPIENT_INVALID"
  );
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, recipient: "/deepinfra" }, allowlist).code,
    "OPENROUTER_RECIPIENT_INVALID"
  );
});

test("a host that already failed this response cannot be the recipient", () => {
  assert.equal(
    decideOpenRouterDispatch({ ...admitted, failedProviders: ["deepinfra"] }, allowlist).code,
    "OPENROUTER_FAILED_PROVIDER_EXCLUDED"
  );
  assert.equal(
    decideOpenRouterDispatch(
      { recipient: "deepinfra/turbo", failedProviders: ["deepinfra/turbo"] },
      allowlist
    ).code,
    "OPENROUTER_FAILED_PROVIDER_EXCLUDED"
  );
});

test("an admitted pin is one slug and fallbacks off", () => {
  const decision = decideOpenRouterDispatch(
    { ...admitted, failedProviders: ["deepseek"] },
    allowlist
  );
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.pin, {
    only: ["deepinfra"],
    allow_fallbacks: false,
    ignore: ["deepseek"],
  });
});

test("the wire body replaces a wider provider object instead of merging it", () => {
  const decision = decideOpenRouterDispatch(admitted, allowlist);
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
  const decision = decideOpenRouterDispatch(admitted, allowlist);
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
  const decision = decideOpenRouterDispatch(admitted, allowlist);
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
  const decision = decideOpenRouterDispatch(
    { ...admitted, failedProviders: ["novita"] },
    allowlist
  );
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

test("the operator allowlist is the environment variable, and a bad slug refuses it", () => {
  assert.equal(readOpenRouterRecipientAllowlist({}).code, "OPENROUTER_RECIPIENT_ALLOWLIST_REQUIRED");
  assert.equal(
    readOpenRouterRecipientAllowlist({ OPENROUTER_RECIPIENT_ALLOWLIST: "  " }).code,
    "OPENROUTER_RECIPIENT_ALLOWLIST_REQUIRED"
  );
  assert.equal(
    readOpenRouterRecipientAllowlist({ OPENROUTER_RECIPIENT_ALLOWLIST: "deepinfra, DeepInfra" }).code,
    "OPENROUTER_RECIPIENT_ALLOWLIST_INVALID"
  );
  assert.deepEqual(
    readOpenRouterRecipientAllowlist({
      OPENROUTER_RECIPIENT_ALLOWLIST: " deepinfra , google-vertex/us-east5 ",
    }).allowlist,
    ["deepinfra", "google-vertex/us-east5"]
  );
});

test("the chat adapter refuses OpenRouter before building a client", () => {
  withAllowlist(undefined, () => {
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
});

test("an admission cannot bring its own allowlist", () => {
  withAllowlist(undefined, () => {
    assert.throws(
      () =>
        getActiveAiModel(
          { provider: "openrouter", apiModel: "moonshotai/kimi-k3" },
          { recipient: "deepinfra", failedProviders: [], allowlist: ["deepinfra"] }
        ),
      (error) => error.code === "OPENROUTER_RECIPIENT_ALLOWLIST_REQUIRED"
    );
  });
});

test("the chat adapter uses the operator allowlist and not the request", () => {
  withAllowlist("together", () => {
    assert.throws(
      () =>
        getActiveAiModel(
          { provider: "openrouter", apiModel: "moonshotai/kimi-k3" },
          { recipient: "deepinfra", failedProviders: [] }
        ),
      (error) => error.code === "OPENROUTER_RECIPIENT_NOT_ALLOWED"
    );
  });
  const model = withAllowlist("deepinfra", () =>
    getActiveAiModel(
      { provider: "openrouter", apiModel: "moonshotai/kimi-k3" },
      { recipient: "deepinfra", failedProviders: [] }
    )
  );
  assert.equal(typeof model, "object");
});

test("deployment hosts other than OpenRouter are not catalogue adapters", () => {
  for (const provider of DEPLOYMENT_ONLY_PROVIDERS) {
    if (provider === "openrouter") continue;
    assert.throws(
      () => getActiveAiModel({ provider, apiModel: "deepseek-ai/DeepSeek-V4-Pro" }),
      (error) =>
        error.name === "DeploymentHostRefusal" &&
        catalogueHostRefusalCode(error) === "DEPLOYMENT_HOST_NOT_A_CATALOGUE_PROVIDER"
    );
  }
});

test("the static catalogue does not route to a deployment-only host", () => {
  const routed = AVAILABLE_MODELS.filter((model) =>
    DEPLOYMENT_ONLY_PROVIDERS.includes(model.provider)
  ).map((model) => model.id);
  assert.deepEqual(routed, []);
});

test("the gate's comment states that a base slug matches every endpoint", () => {
  const source = readFileSync(new URL("../lib/modelRegistryShared.ts", import.meta.url), "utf8");
  assert.match(source, /matches every endpoint of that provider/);
  assert.match(source, /a base slug does not match them/);
});
