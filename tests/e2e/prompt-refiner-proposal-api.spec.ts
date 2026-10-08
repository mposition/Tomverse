import { expect, test, type APIResponse } from "@playwright/test";

const endpoint = "/api/chat/prompt-refiner/proposal";
const input = { requestId: "synthetic_http_request", prompt: "합성 원문 질문" };
const fixtureCookie = "__tomverse_e2e_prompt_refiner=1";
const authenticatedCookies = `${fixtureCookie}; __tomverse_e2e_auth=1`;
const mutationHeaders = (cookie: string, baseURL: string | undefined) => {
  if (!baseURL) throw new Error("E2E baseURL is required");
  return { cookie, origin: new URL(baseURL).origin };
};
const assertNoStore = (response: APIResponse) =>
  expect(response.headers()["cache-control"].split(",").map((value) => value.trim()))
    .toContain("no-store");

test("C01 proposal API requires fixture opt-in and synthetic authentication", async ({ request, baseURL }) => {
  for (const cookie of ["", "__tomverse_e2e_auth=1"]) {
    const response = await request.post(endpoint, { headers: mutationHeaders(cookie, baseURL), data: input });
    expect(response.status()).toBe(503);
    assertNoStore(response);
    expect(await response.json()).toEqual({ code: "PROMPT_REFINER_UNAVAILABLE" });
  }
  for (const cookie of [fixtureCookie, `${fixtureCookie}; __tomverse_e2e_auth=claimed`]) {
    const response = await request.post(endpoint, { headers: mutationHeaders(cookie, baseURL), data: input });
    expect(response.status()).toBe(401);
    assertNoStore(response);
    expect(await response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
  }
});

test("C01 proposal API binds an unmocked HTTP fixture response to strict input", async ({ request, baseURL }) => {
  const headers = mutationHeaders(authenticatedCookies, baseURL);
  const invalid = await request.post(endpoint, { headers, data: { ...input, approved: true } });
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toEqual({ code: "PROMPT_REFINER_INVALID_REQUEST" });

  const oversized = await request.post(endpoint, {
    headers, data: { ...input, prompt: "x".repeat(130 * 1024) },
  });
  expect(oversized.status()).toBe(413);

  const response = await request.post(endpoint, { headers, data: input });
  expect(response.status()).toBe(200);
  assertNoStore(response);
  const body = await response.json();
  expect(body).toEqual({
    requestId: input.requestId,
    suggestionId: expect.stringMatching(/^fixture_[a-f0-9]{32}$/),
    refinedPrompt: expect.any(String),
    refinerVersion: "suggest-v1",
    inputScope: "current_user_turn_text_only",
  });
  expect(body.refinedPrompt.trim()).not.toBe(input.prompt.trim());
  const next = await request.post(endpoint, {
    headers, data: { requestId: "synthetic_second_request", prompt: body.refinedPrompt },
  });
  expect(next.status()).toBe(200);
  const second = await next.json();
  expect(second.requestId).toBe("synthetic_second_request");
  expect(second.suggestionId).not.toBe(body.suggestionId);
  expect(second.refinedPrompt.trim()).not.toBe(body.refinedPrompt.trim());
});
