import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const endpoint = "http://127.0.0.1:3100/api/chat/prompt-refiner/proposal";
const cookieValues = new Map<string, string>();
let cookieReads = 0;

mock.module("next/headers", {
  namedExports: {
    cookies: async () => {
      cookieReads += 1;
      return { get: (name: string) => {
        const value = cookieValues.get(name);
        return value === undefined ? undefined : { value };
      } };
    },
  },
});

const loadRoute = () => import(mod("app/api/chat/prompt-refiner/proposal/route.ts"));
const loadHandler = () => import(mod("lib/promptRefinerProposalApi.ts"));
const fixtureEnv = {
  NEXTAUTH_URL: "http://127.0.0.1:3100",
  E2E_AUTH_BYPASS: "true",
  E2E_DISABLE_DATABASE: "true",
  PROMPT_REFINER_KILL_SWITCH: "",
};
const withFixtureEnvironment = async (run: () => Promise<void>) => {
  const previous = new Map(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, fixtureEnv);
  cookieValues.clear();
  cookieReads = 0;
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cookieValues.clear();
  }
};

const post = (body: unknown) =>
  new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const valid = () => ({ requestId: "synthetic_request_1", prompt: "합성 문장" });
const assertNoStore = (response: Response) =>
  assert.equal(response.headers.get("Cache-Control"), "no-store");
const unreadable = {
  get body() {
    throw new Error("body read before availability or authentication");
  },
} as unknown as Request;

test("product and unapproved fixture requests refuse before reading a draft", async () => {
  const route = await loadRoute();
  await withFixtureEnvironment(async () => {
    cookieValues.set("__tomverse_e2e_prompt_refiner", "1");
    cookieValues.set("__tomverse_e2e_auth", "1");
    for (const [key, value] of [
      ["NEXTAUTH_URL", "https://synthetic.example"],
      ["NEXTAUTH_URL", "not-a-url"],
      ["E2E_AUTH_BYPASS", "false"],
      ["E2E_DISABLE_DATABASE", "false"],
      ["PROMPT_REFINER_KILL_SWITCH", "stop"],
    ]) {
      Object.assign(process.env, fixtureEnv, { [key]: value });
      const response = await route.POST(unreadable);
      assert.equal(response.status, 503);
      assertNoStore(response);
      assert.equal(cookieReads, 0);
    }
    Object.assign(process.env, fixtureEnv);
    cookieValues.delete("__tomverse_e2e_prompt_refiner");
    assert.equal((await route.POST(unreadable)).status, 503);
  });
});

test("isolated fixture authenticates before parsing and binds a strict suggestion", async () => {
  const route = await loadRoute();
  await withFixtureEnvironment(async () => {
    cookieValues.set("__tomverse_e2e_prompt_refiner", "1");
    const denied = await route.POST(unreadable);
    assert.equal(denied.status, 401);
    assertNoStore(denied);
    cookieValues.set("__tomverse_e2e_auth", "claimed");
    assert.equal((await route.POST(unreadable)).status, 401);

    cookieValues.set("__tomverse_e2e_auth", "1");
    const extra = await route.POST(post({ ...valid(), approved: true }));
    assert.equal(extra.status, 400);
    assertNoStore(extra);
    assert.equal((await route.POST(post({ ...valid(), requestId: "bad id" }))).status, 400);
    assert.equal((await route.POST(post({ ...valid(), prompt: "x".repeat(130 * 1024) }))).status, 413);

    const response = await route.POST(post(valid()));
    assert.equal(response.status, 200);
    assertNoStore(response);
    const body = await response.json();
    assert.equal(body.requestId, valid().requestId);
    assert.match(body.suggestionId, /^fixture_[a-f0-9]{32}$/);
    assert.equal(body.inputScope, "current_user_turn_text_only");
    assert.equal(body.refinerVersion, "suggest-v1");
    assert.notEqual(body.refinedPrompt, valid().prompt);
    assert.deepEqual(Object.keys(body).sort(), [
      "inputScope", "refinedPrompt", "refinerVersion", "requestId", "suggestionId",
    ]);
    assert.equal(route.GET, undefined);
  });
});

test("API rejects an adapter response for another request or unchanged draft", async () => {
  const { handlePromptRefinerProposal } = await loadHandler();
  const base = {
    requestId: valid().requestId,
    suggestionId: "synthetic_suggestion",
    refinedPrompt: "다르게 작성한 합성 문장",
    refinerVersion: "suggest-v1",
    inputScope: "current_user_turn_text_only",
  };
  const seen: unknown[] = [];
  for (const suggestion of [
    { ...base, requestId: "another_request" },
    { ...base, refinedPrompt: valid().prompt },
    { ...base, provider: "forbidden" },
  ]) {
    const response = await handlePromptRefinerProposal(post(valid()), {
      authenticatedUserId: async () => "synthetic-user",
      suggest: async (input: unknown) => {
        seen.push(input);
        return suggestion;
      },
    });
    assert.equal(response.status, 502);
    assertNoStore(response);
    assert.deepEqual(await response.json(), {
      code: "PROMPT_REFINER_INVALID_PROPOSAL",
    });
  }
  assert.deepEqual(seen, [valid(), valid(), valid()]);
});
