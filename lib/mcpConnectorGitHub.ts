import { McpConnectorError, type McpServerPolicy } from "@/lib/mcpConnectorPolicy";
import type { McpReadSource } from "@/lib/mcpConnectorSchema";
export const GITHUB_ISSUE_TOOLS = new Set(["search_issues", "issue_read", "issue_write"]);

// GitHub App user tokens can be narrowed at exchange/refresh. This parameter
// never comes from a browser, model or provider discovery response.
export function githubOAuthTokenRequest(server: McpServerPolicy, url: string, init?: RequestInit): RequestInit | undefined {
  if (!server.githubRepository) return init;
  if (server.auth !== "oauth" || !server.githubRepositoryId || url !== "https://github.com/login/oauth/access_token" ||
    init?.method !== "POST" || !(typeof init.body === "string" || init.body instanceof URLSearchParams))
    throw new McpConnectorError("oauth_token_endpoint_refused");
  const body = new URLSearchParams(init.body);
  if (!["authorization_code", "refresh_token"].includes(body.get("grant_type") || "")) throw new McpConnectorError("oauth_grant_refused");
  body.set("repository_id", String(server.githubRepositoryId));
  return { ...init, body };
}

export function validateGithubRepositoryScope(server: McpServerPolicy, tool: string, args: Record<string, unknown>) {
  if (!server.githubRepository) return;
  const [owner, repo] = server.githubRepository.split("/");
  if (!GITHUB_ISSUE_TOOLS.has(tool) || typeof args.owner !== "string" || typeof args.repo !== "string" ||
    args.owner.toLowerCase() !== owner.toLowerCase() || args.repo.toLowerCase() !== repo.toLowerCase() ||
    (tool === "issue_read" && args.method !== "get") || (tool === "issue_write" && args.method !== "create") ||
    (tool === "search_issues" && (typeof args.query !== "string" || !args.query.trim() || args.query.length > 300 || /[:()"]|\b(?:OR|NOT)\b/i.test(args.query))))
    throw new McpConnectorError("resource_scope_refused", 403);
}

// These constants come from the host's reviewed profile, not remote metadata.
export function githubScopedModelSchema(server: McpServerPolicy, tool: string, schema: Record<string, unknown>) {
  if (!server.githubRepository) return schema;
  const [owner, repo] = server.githubRepository.split("/");
  return { ...schema, properties: { ...(schema.properties as Record<string, unknown>),
    owner: { type: "string", const: owner }, repo: { type: "string", const: repo },
    ...(tool === "issue_read" || tool === "issue_write" ? { method: { type: "string", const: tool === "issue_read" ? "get" : "create" } } : {}) },
    required: [...new Set([...(Array.isArray(schema.required) ? schema.required : []), "owner", "repo"])] };
}

// Explicit source mapping for GitHub's documented issue_read/get response.
// Search hits, comments, body links and write responses never create citations.
export function githubIssueReadSources(server: McpServerPolicy, tool: string, args: Record<string, unknown>, raw: unknown): McpReadSource[] {
  if (server.sourceAdapter !== "github-issues" || !server.readTools.includes(tool) || tool !== "issue_read" || args.method !== "get") return [];
  const endpoint = new URL(server.url);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.githubcopilot.com" || !endpoint.pathname.startsWith("/mcp/")) return [];
  if (typeof args.owner !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(args.owner) || typeof args.repo !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(args.repo) || [".", ".."].includes(args.repo) || !Number.isSafeInteger(args.issue_number) || Number(args.issue_number) <= 0) return [];
  const result = raw as { isError?: boolean; structuredContent?: { method?: unknown; issue?: unknown }; content?: Array<{ type?: unknown; text?: unknown }> };
  if (!result || result.isError) return [];
  const candidates: unknown[] = [];
  if (result.structuredContent?.method === "get") candidates.push(result.structuredContent.issue);
  for (const part of result.content || []) if (part.type === "text" && typeof part.text === "string") {
    try { candidates.push(JSON.parse(part.text)); } catch { /* Plain prose is not a verified issue record. */ }
  }
  const expectedPath = `/${args.owner}/${args.repo}/issues/${args.issue_number}`.toLowerCase();
  for (const value of candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const issue = value as Record<string, unknown>;
    if (issue.number !== args.issue_number || typeof issue.title !== "string" || !issue.title.trim() || !(typeof issue.body === "string" || issue.body === null)) continue;
    const uri = issue.html_url ?? issue.url;
    if (typeof uri !== "string") continue;
    try {
      const url = new URL(uri);
      if (url.origin === "https://github.com" && !url.username && !url.password && !url.search && !url.hash && url.pathname.toLowerCase() === expectedPath)
        return [{ url: url.href, title: issue.title.slice(0, 120), sourceProvider: "mcp" }];
    } catch { /* Refuse malformed or unbound source identifiers. */ }
  }
  return [];
}
