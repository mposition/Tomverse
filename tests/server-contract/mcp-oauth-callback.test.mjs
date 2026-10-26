import assert from "node:assert/strict";
import { mock, test } from "node:test";
let failure, completed = 0;
mock.module("../../lib/mcpConnectorApi.ts", { namedExports: { mcpApi: async (_request, run) => {
  if (failure) return Response.json({ code: failure }, { status: 400 });
  try { return Response.json(await run("synthetic-owner")); } catch { return Response.json({ code: "invalid_request" }, { status: 400 }); }
} } });
mock.module("../../lib/mcpConnectorOAuth.ts", { namedExports: { completeMcpOAuth: async () => { completed++; } } });
mock.module("../../lib/publicUrl.ts", { namedExports: { getPublicAppOrigin: () => "http://127.0.0.1:3131" } });
const { GET } = await import("../../app/api/mcp/oauth/callback/route.ts");
const url = `http://127.0.0.1:3131/api/mcp/oauth/callback?state=${"a".repeat(43)}&code=synthetic-code&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth`;
test("callback scrubs credentials and returns only registered failure categories", async () => {
  failure = undefined;
  const good = await GET(new Request(url)); assert.equal(completed, 1);
  assert.equal(good.headers.get("location"), "http://127.0.0.1:3131/plugins?oauth=connected");
  assert.equal(good.headers.get("referrer-policy"), "no-referrer");
  for (const [input, expected] of [["oauth_issuer_mismatch", "oauth_issuer_mismatch"], ["sign_in_required", "sign_in_required"],
    ["oauth_flow_expired", "oauth_flow_expired"], ["connector_disabled", "connector_disabled"], ["API_RATE_LIMITED", "API_RATE_LIMITED"],
    ["oauth_authorization_failed", "oauth_authorization_failed"], ["synthetic-secret-from-provider", "connector_request_failed"]]) {
    failure = input;
    const response = await GET(new Request(url)), destination = response.headers.get("location");
    assert.equal(destination, `http://127.0.0.1:3131/plugins?oauth=failed&reason=${expected}`);
    assert.equal(destination.includes("synthetic-code"), false); assert.equal(destination.includes("synthetic-secret"), false);
  }
  assert.equal(completed, 1);
  failure = undefined;
  const invalid = await GET(new Request(url.replace("state=", "other=")));
  assert.ok(invalid.headers.get("location").endsWith("reason=invalid_request")); assert.equal(completed, 1);
});
