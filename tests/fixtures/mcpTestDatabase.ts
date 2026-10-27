import assert from "node:assert/strict";

export function assertMcpTestDatabase(env: Record<string, string | undefined> = process.env): void {
  let url: URL;
  try { url = new URL(env.DATABASE_URL || ""); }
  catch { throw new Error("disposable MCP test database only"); }
  const local = url.hostname === "127.0.0.1" && url.port === "56439" &&
    url.searchParams.get("schema") === "mcp_preview_test";
  const ci = env.CI === "true" && env.DATABASE_URL === env.TEST_DATABASE_URL &&
    url.hostname === "127.0.0.1" && url.port === "5432" && url.pathname === "/tomverse_test" &&
    [null, "public"].includes(url.searchParams.get("schema"));
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol) && (local || ci), "disposable MCP test database only");
}
