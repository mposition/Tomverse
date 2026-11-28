import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import catalog from "@/config/mcp/provider-catalog.json";
import { MCP_PROVIDER_CATALOG_MAX_AGE_SECONDS, MCP_PROVIDER_CATALOG_PATH, catalogEtagMatches, mcpProviderCatalogResponse } from "@/lib/mcpProviderCatalogResponse";
import { DESKTOP_PLUGIN_CATALOG, desktopPluginsEnabled, desktopReadApiRoute, desktopWriteApiRoute } from "@/lib/nativeBearerGate";

const switches = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED", "TOMVERSE_DESKTOP_PLUGINS_ENABLED"] as const;
function withSwitches(on: boolean, run: () => void) {
  const previous = switches.map(key => process.env[key]);
  try {
    for (const key of switches) { if (on) process.env[key] = "true"; else delete process.env[key]; }
    run();
  } finally {
    switches.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
}

test("the catalogue read is the web's catalogue file: same providers, same order, same fields, versioned by observedAt", async () => {
  const response = mcpProviderCatalogResponse(null);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  const body = await response.json();
  const file = JSON.parse(readFileSync(new URL("../config/mcp/provider-catalog.json", import.meta.url), "utf8"));
  assert.deepEqual(body, file);
  assert.equal(body.observedAt, catalog.observedAt);
  assert.ok(body.providers.length >= 100);
  assert.deepEqual(body.providers.map((provider: { id: string }) => provider.id), file.providers.map((provider: { id: string }) => provider.id));
});

test("the catalogue read carries a revalidating cache header and an ETag that a repeat read can use", async () => {
  const first = mcpProviderCatalogResponse(null);
  const etag = first.headers.get("etag");
  assert.match(etag ?? "", /^"\d{4}-\d{2}-\d{2}-[0-9a-f]{16}"$/);
  assert.ok((etag ?? "").includes(catalog.observedAt));
  const cache = first.headers.get("cache-control") ?? "";
  assert.ok(cache.includes("private"), "an authenticated read is never kept by a shared cache");
  assert.ok(cache.includes(`max-age=${MCP_PROVIDER_CATALOG_MAX_AGE_SECONDS}`));
  assert.ok(cache.includes("must-revalidate"));
  assert.match(first.headers.get("vary") ?? "", /Authorization/i);
  for (const header of [etag!, "W/" + etag!, `"other", ${etag}`, "*"]) {
    const repeat = mcpProviderCatalogResponse(header);
    assert.equal(repeat.status, 304, header);
    assert.equal(repeat.headers.get("etag"), etag);
    assert.equal(await repeat.text(), "");
  }
  for (const header of ["\"other\"", "", "W/\"nope\""]) assert.equal(mcpProviderCatalogResponse(header).status, 200, header);
  assert.equal(catalogEtagMatches(null), false);
});

test("exactly one more path is open to the Desktop bearer, only for GET, and only while the Desktop plugins switch is on", () => {
  assert.equal(DESKTOP_PLUGIN_CATALOG, MCP_PROVIDER_CATALOG_PATH);
  withSwitches(false, () => {
    assert.equal(desktopPluginsEnabled(), false);
    assert.equal(desktopReadApiRoute(DESKTOP_PLUGIN_CATALOG, "GET"), false);
  });
  withSwitches(true, () => {
    assert.equal(desktopPluginsEnabled(), true);
    assert.equal(desktopReadApiRoute(DESKTOP_PLUGIN_CATALOG, "GET"), true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(desktopReadApiRoute(DESKTOP_PLUGIN_CATALOG, method), false, method);
      assert.equal(desktopWriteApiRoute(DESKTOP_PLUGIN_CATALOG, method), false, method);
    }
    assert.equal(desktopWriteApiRoute(DESKTOP_PLUGIN_CATALOG, "GET"), false);
    // Nothing near it is opened: not a child, not the connection routes the settings session carries, not another MCP read.
    for (const path of [DESKTOP_PLUGIN_CATALOG + "/", DESKTOP_PLUGIN_CATALOG + "/github", DESKTOP_PLUGIN_CATALOG + "?x=1", "/api/mcp/provider", "/api/mcp/connections",
      "/api/mcp/connections/abc", "/api/mcp/invocations/abc", "/api/mcp/oauth/start", "/api/mcp/desktop-code", "/api/mcp", "/api/plugins/providers"]) {
      assert.equal(desktopReadApiRoute(path, "GET"), false, path);
      assert.equal(desktopWriteApiRoute(path, "GET") || desktopWriteApiRoute(path, "POST"), false, path);
    }
  });
});

test("the route answers only a signed-in caller through the shared session check, with a rate limit, and reads no body", () => {
  const source = readFileSync(new URL("../app/api/mcp/providers/route.ts", import.meta.url), "utf8");
  assert.match(source, /resolveChatRouteSession\(request\)/);
  assert.match(source, /sign_in_required/);
  assert.match(source, /consumeApiRateLimit\(request, auth\.session\.user\.id, "mcp-provider-catalog"/);
  assert.match(source, /mcpProviderCatalogResponse\(request\.headers\.get\("if-none-match"\)\)/);
  assert.equal(/export (async )?function (POST|PUT|PATCH|DELETE)/.test(source), false);
  assert.equal(/request\.(json|text|formData)\(/.test(source), false);
  // The session check refuses a Desktop bearer on a path the gate has not enrolled, so the route needs no switch of its own.
  const session = readFileSync(new URL("../lib/chatRouteSession.ts", import.meta.url), "utf8");
  assert.match(session, /desktopReadApiRoute\(path, request\.method\)/);
});

test("the capability the Desktop app reads is named next to the plugins one, behind the same switches", () => {
  const source = readFileSync(new URL("../app/api/products/chat/capabilities/route.ts", import.meta.url), "utf8");
  assert.match(source, /desktopPluginCatalog: desktopPluginsEnabled\(\) && mcpPreviewEnabled\(\)/);
});
