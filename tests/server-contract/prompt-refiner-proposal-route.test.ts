import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const endpoint = "http://127.0.0.1:3100/api/chat/prompt-refiner/proposal";
const world: {
  fixture: boolean;
  session: { user: { id: string } } | null;
} = { fixture: false, session: null };

mock.module(mod("lib/e2eTestMode.ts"), {
  namedExports: { isE2EFixtureMode: () => world.fixture },
});
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => world.session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });

const loadRoute = () => import(mod("app/api/chat/prompt-refiner/proposal/route.ts"));
const loadHandler = () => import(mod("lib/promptRefinerProposalApi.ts"));

const post = (body: unknown) =>
  new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const valid = () => ({ requestId: "synthetic_request_1", prompt: "합성 문장" });
const assertNoStore = (response: Response) =>
  assert.equal(response.headers.get("Cache-Control"), "no-store");

test("product and unapproved fixture requests refuse before reading a draft", async () => {
  const route = await loadRoute();
  const previous = process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED;
  const previousKillSwitch = process.env.PROMPT_REFINER_KILL_SWITCH;
  try {
    const unreadable = {
      get body() {
        throw new Error("body read before availability");
      },
    } as unknown as Request;
    world.fixture = false;
    process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED = "true";
    const product = await route.POST(unreadable);
    assert.equal(product.status, 503);
    assertNoStore(product);

    world.fixture = true;
    delete process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED;
    assert.equal((await route.POST(unreadable)).status, 503);

    process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED = "true";
    process.env.PROMPT_REFINER_KILL_SWITCH = "stop";
    assert.equal((await route.POST(unreadable)).status, 503);
  } finally {
    if (previous === undefined) delete process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED;
    else process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED = previous;
    if (previousKillSwitch === undefined) delete process.env.PROMPT_REFINER_KILL_SWITCH;
    else process.env.PROMPT_REFINER_KILL_SWITCH = previousKillSwitch;
    world.fixture = false;
  }
});

test("isolated fixture authenticates before parsing and binds a strict suggestion", async () => {
  const route = await loadRoute();
  const previous = process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED;
  try {
    process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED = "true";
    world.fixture = true;
    world.session = null;
    const unreadable = {
      get body() {
        throw new Error("body read before authentication");
      },
    } as unknown as Request;
    const denied = await route.POST(unreadable);
    assert.equal(denied.status, 401);
    assertNoStore(denied);

    world.session = { user: { id: "synthetic-user" } };
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
  } finally {
    if (previous === undefined) delete process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED;
    else process.env.E2E_PROMPT_REFINER_PROPOSAL_ENABLED = previous;
    world.fixture = false;
    world.session = null;
  }
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
