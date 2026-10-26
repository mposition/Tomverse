import assert from "node:assert/strict";
import test from "node:test";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { githubOAuthTokenRequest } from "@/lib/mcpConnectorGitHub";
import { mcpServers } from "@/lib/mcpConnectorPolicy";
import { jsonSchema, tool } from "ai";

test("the pinned AI SDK exposes complete tool schemas to the budget serializer", () => {
  const schema = { type: "object", properties: { owner: { type: "string", const: "mposition" }, repo: { type: "string", const: "TomverseCode" } } };
  const definition = tool({ description: "Synthetic connector definition", inputSchema: jsonSchema(schema) });
  const serialized = JSON.parse(JSON.stringify({ synthetic: definition }));
  assert.deepEqual(serialized.synthetic.inputSchema.jsonSchema, schema);
});

test("the pinned SDK exchanges a confidential GitHub App code and refreshes an empty-scope response", async () => {
  const [server] = mcpServers({ NODE_ENV: "test", MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_GITHUB_OAUTH_CLIENT_ID: "synthetic-client",
    MCP_GITHUB_OAUTH_CLIENT_SECRET: "synthetic-client-secret", MCP_GITHUB_REPOSITORY: "mposition/TomverseCode", MCP_GITHUB_REPOSITORY_ID: "1309523852" });
  let tokens: OAuthTokens | undefined;
  const grants: string[] = [];
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:3131/api/mcp/oauth/callback",
    clientMetadata: { redirect_uris: ["http://127.0.0.1:3131/api/mcp/oauth/callback"], token_endpoint_auth_method: "client_secret_post", scope: "offline_access" },
    clientInformation: () => ({ client_id: "synthetic-client", client_secret: "synthetic-client-secret", issuer: "https://github.com" }),
    tokens: () => tokens, saveTokens: value => { tokens = value; }, codeVerifier: () => "synthetic-verifier", saveCodeVerifier: () => {},
    redirectToAuthorization: () => { assert.fail("Code and refresh exchanges must not redirect"); },
    discoveryState: () => ({ authorizationServerUrl: "https://github.com", authorizationServerMetadata: {
      issuer: "https://github.com", authorization_endpoint: server.oauth!.authorizationUrl, token_endpoint: server.oauth!.tokenUrl,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"], code_challenge_methods_supported: ["S256"],
    }, resourceMetadata: { resource: server.url, authorization_servers: ["https://github.com"], scopes_supported: ["offline_access"] } }),
  };
  const fetchFn: typeof fetch = async (url, init) => {
    const request = githubOAuthTokenRequest(server, String(url), init)!;
    const body = new URLSearchParams(request.body as URLSearchParams);
    assert.equal(String(url), "https://github.com/login/oauth/access_token"); assert.equal(body.get("repository_id"), "1309523852");
    assert.equal(body.get("client_id"), "synthetic-client"); assert.equal(body.get("client_secret"), "synthetic-client-secret");
    const grant = body.get("grant_type")!; grants.push(grant);
    if (grant === "authorization_code") assert.equal(body.get("code_verifier"), "synthetic-verifier");
    else assert.equal(body.get("refresh_token"), "synthetic-refresh");
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 28800, scope: "" });
  };
  assert.equal(await auth(provider, { serverUrl: server.url, scope: "offline_access", authorizationCode: "synthetic-code", fetchFn }), "AUTHORIZED");
  assert.equal(tokens?.issuer, "https://github.com"); assert.equal(tokens?.scope, "");
  assert.equal(await auth(provider, { serverUrl: server.url, scope: "offline_access", fetchFn }), "AUTHORIZED");
  assert.deepEqual(grants, ["authorization_code", "refresh_token"]);
});
