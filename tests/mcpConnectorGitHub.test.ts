import assert from "node:assert/strict";
import test from "node:test";
import { githubIssueReadSources, githubOAuthTokenRequest, githubScopedModelSchema, validateGithubRepositoryScope } from "@/lib/mcpConnectorGitHub";
import { mcpServerSchema, mcpServers, type McpServerPolicy } from "@/lib/mcpConnectorPolicy";
const server: McpServerPolicy = { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/x/issues", auth: "bearer", readTools: ["issue_read"], sourceAdapter: "github-issues" };
const args = { method: "get", owner: "mposition", repo: "TomverseCode", issue_number: 123 };
const issue = { number: 123, title: "Synthetic issue", body: "Synthetic body with https://evil.example/unread", html_url: "https://github.com/mposition/TomverseCode/issues/123" };
test("only bound GitHub issue bodies read by issue_read/get produce source cards", () => {
  for (const result of [{ content: [{ type: "text", text: JSON.stringify(issue) }] }, { structuredContent: { method: "get", issue } }]) {
    assert.deepEqual(githubIssueReadSources(server, "issue_read", args, result), [{ url: issue.html_url, title: issue.title, sourceProvider: "mcp" }]);
  }
});
test("search hits, write responses, denied calls and mismatched resources never produce read citations", () => {
  const result = { content: [{ type: "text", text: JSON.stringify(issue) }] };
  for (const [tool, input, output, policy] of [
    ["search_issues", args, result, server], ["issue_write", args, result, server],
    ["issue_read", { ...args, method: "get_comments" }, result, server],
    ["issue_read", { ...args, repo: "OtherRepo" }, result, server],
    ["issue_read", args, { ...result, isError: true }, server],
    ["issue_read", args, result, { ...server, url: "https://evil.example/mcp/" }],
  ] as const) assert.deepEqual(githubIssueReadSources(policy, tool, input, output), []);
  assert.deepEqual(githubIssueReadSources(server, "issue_read", args, { content: [{ type: "text", text: JSON.stringify({ ...issue, body: undefined }) }] }), []);
});
test("a repository-scoped profile refuses another repository, unknown tools and unapproved issue methods", () => {
  const scoped = { ...server, githubRepository: "mposition/TomverseCode" };
  validateGithubRepositoryScope(scoped, "issue_read", args);
  validateGithubRepositoryScope(scoped, "issue_write", { ...args, method: "create" });
  for (const [tool, input] of [["issue_read", { ...args, repo: "OtherRepo" }], ["issue_write", { ...args, method: "update" }], ["delete_file", args], ["search_issues", { query: "all" }]] as const)
    assert.throws(() => validateGithubRepositoryScope(scoped, tool, input), { code: "resource_scope_refused" });
  for (const query of ["repo:another/project", "auth OR repo:another/project", "(login)", ""]) assert.throws(() =>
    validateGithubRepositoryScope(scoped, "search_issues", { ...args, query }), { code: "resource_scope_refused" });
  const modelSchema = githubScopedModelSchema(scoped, "issue_read", { type: "object", properties: {}, required: ["method"] });
  const properties = modelSchema.properties as Record<string, unknown>;
  assert.deepEqual(properties.method, { type: "string", const: "get" });
  assert.deepEqual(properties.repo, { type: "string", const: "TomverseCode" });
});

test("the GitHub OAuth profile is default-off, fixed-destination and cannot classify a write as read", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MCP_GITHUB_OAUTH_CLIENT_ID: "synthetic-client", MCP_GITHUB_OAUTH_CLIENT_SECRET: "synthetic-secret",
    MCP_GITHUB_REPOSITORY: "mposition/TomverseCode", MCP_GITHUB_REPOSITORY_ID: "1309523852" };
  assert.deepEqual(mcpServers(env), []);
  const [profile] = mcpServers({ ...env, MCP_CONNECTOR_PREVIEW_ENABLED: "true" });
  assert.equal(profile.auth, "oauth"); assert.equal(profile.oauth?.scope, "offline_access");
  assert.equal(profile.oauth?.issuer, "https://github.com/login/oauth");
  assert.equal(JSON.stringify(profile).includes("synthetic-secret"), false);
  for (const invalid of [{ ...profile, readTools: ["issue_write"] }, { ...profile, githubRepositoryId: undefined },
    { ...profile, oauth: { ...profile.oauth, tokenUrl: "https://evil.example/token" } },
    { ...profile, oauth: { ...profile.oauth, issuer: "https://github.com" } }])
    assert.equal(mcpServerSchema.safeParse(invalid).success, false);
});

test("OAuth code and refresh exchanges bind the registered repository without altering client authentication", () => {
  const profile = { ...server, auth: "oauth" as const, githubRepository: "mposition/TomverseCode", githubRepositoryId: 1309523852 };
  for (const grant of ["authorization_code", "refresh_token"]) {
    const original = new URLSearchParams({ grant_type: grant, client_secret: "synthetic-secret", repository_id: "999" });
    const request = githubOAuthTokenRequest(profile, "https://github.com/login/oauth/access_token", { method: "POST", body: original })!;
    const body = new URLSearchParams(request.body as URLSearchParams);
    assert.equal(body.get("repository_id"), "1309523852"); assert.equal(body.get("client_secret"), "synthetic-secret");
    assert.equal(original.get("repository_id"), "999");
  }
  assert.throws(() => githubOAuthTokenRequest(profile, "https://evil.example/token", { method: "POST", body: "grant_type=authorization_code" }));
  assert.throws(() => githubOAuthTokenRequest(profile, "https://github.com/login/oauth/access_token", { method: "POST", body: "grant_type=client_credentials" }));
});
