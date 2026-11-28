import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MCP_PROVIDERS } from "@/lib/mcpProviderCatalog";
import { MCP_PROVIDER_PRESETS, providerEnvironmentPrefix } from "@/lib/mcpProviderPresets";
import { mcpAuthorizationRedirect, mcpServerSchema, mcpServers } from "@/lib/mcpConnectorPolicy";
import { validateMcpEndpoint } from "@/lib/mcpConnectorClient";
import { mcpPolicyDigest } from "@/lib/mcpConnectorStore";

const PREVIEW = { MCP_CONNECTOR_PREVIEW_ENABLED: "true" };
// The catalog is the only selection source, so a test looks at the servers it cares about in the full result.
const servers = (extra: Record<string, string> = {}) => mcpServers({ ...PREVIEW, ...extra });
const only = (ids: string, extra: Record<string, string> = {}) => servers(extra).filter(server => ids.split(",").includes(server.id));
const ids = (extra: Record<string, string> = {}) => servers(extra).map(server => server.id);

test("catalog entries never grant connections and disabled preview ignores preset configuration", () => {
  assert.ok(MCP_PROVIDERS.length > 100);
  assert.deepEqual(mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "false", MCP_PROVIDER_LINEAR_SCOPE: "read" }), []);
  assert.deepEqual(mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "false", MCP_CONNECTOR_PROVIDERS_DISABLED: "notion" }), []);
});

test("without any list variable the catalog makes dynamic-registration and no-auth presets connectable", () => {
  const connectable = servers();
  const dynamic = MCP_PROVIDER_PRESETS.filter(p => p.auth === "oauth" && "oauth" in p && p.oauth && "registrationUrl" in p.oauth && (p.oauth.scope || p.oauth.allowedScopes.length));
  assert.ok(connectable.length > 50);
  assert.equal(new Set(connectable.map(s => s.id)).size, connectable.length);
  for (const id of ["linear", "notion", "railway", "figma", "supabase", "microsoft-learn"]) assert.ok(connectable.some(s => s.id === id), id);
  // No-auth presets and dynamic-registration presets need no operator secret.
  for (const preset of MCP_PROVIDER_PRESETS.filter(p => p.auth === "none")) assert.ok(connectable.some(s => s.id === preset.id), preset.id);
  for (const preset of dynamic) assert.ok(connectable.some(s => s.id === preset.id), preset.id);
  // Everything connectable comes from the catalog, never from outside it, and carries no secret.
  const catalogIds = new Set(MCP_PROVIDER_PRESETS.map(p => p.id));
  for (const server of connectable) { assert.ok(catalogIds.has(server.id), server.id); assert.equal(server.oauth?.clientId, undefined, server.id); }
  // Presets that need a registered app or are configured elsewhere stay absent until configured.
  for (const id of ["github", "slack", "zoom", "asana", "gmail", "google-calendar", "google-drive", "hubspot", "shopify"]) assert.ok(!connectable.some(s => s.id === id), id);
  for (const preset of MCP_PROVIDER_PRESETS.filter(p => p.auth === "configure")) assert.ok(!connectable.some(s => s.id === preset.id), preset.id);
});

test("the provider list variable is ignored; servers listed before keep their exact policy", () => {
  const base = ids();
  assert.deepEqual(ids({ MCP_CONNECTOR_PROVIDERS: "notion" }), base);
  assert.deepEqual(ids({ MCP_CONNECTOR_PROVIDERS: "notion,notion" }), base);
  assert.deepEqual(ids({ MCP_CONNECTOR_PROVIDERS: "unregistered" }), base);
  // A server an operator listed before stays, with the policy it was connected under (its stored digest still matches).
  const listed = { id: "operator-added", name: "Operator added", url: "https://mcp.example.com/mcp" };
  const withListed = servers({ MCP_CONNECTOR_SERVERS: JSON.stringify([listed]) });
  assert.deepEqual(withListed.map(s => s.id).sort(), [...base, "operator-added"].sort());
  // An entry with a catalog id wins over the preset, so a connection made under the operator's policy keeps it.
  const linear = { id: "linear", name: "Linear (operator)", url: "https://mcp.example.com/linear" };
  const overridden = servers({ MCP_CONNECTOR_SERVERS: JSON.stringify([linear]) }).filter(s => s.id === "linear");
  assert.equal(overridden.length, 1);
  assert.equal(overridden[0]!.url, linear.url);
  assert.equal(mcpPolicyDigest(overridden[0]!), mcpPolicyDigest(mcpServerSchema.parse(linear)));
  // The kill switch covers listed servers too; a malformed list still fails loudly rather than silently dropping them.
  assert.ok(!servers({ MCP_CONNECTOR_SERVERS: JSON.stringify([listed]), MCP_CONNECTOR_PROVIDERS_DISABLED: "operator-added" }).some(s => s.id === "operator-added"));
  assert.throws(() => servers({ MCP_CONNECTOR_SERVERS: "not even parsed" }));
});

test("the disabled list switches off only the named providers", () => {
  const base = ids();
  assert.ok(base.includes("linear") && base.includes("notion"));
  assert.deepEqual(ids({ MCP_CONNECTOR_PROVIDERS_DISABLED: "" }), base);
  assert.deepEqual(ids({ MCP_CONNECTOR_PROVIDERS_DISABLED: " , " }), base);
  assert.deepEqual(ids({ MCP_CONNECTOR_PROVIDERS_DISABLED: "unregistered,github" }), base);
  assert.deepEqual(ids({ MCP_CONNECTOR_PROVIDERS_DISABLED: "linear" }), base.filter(id => id !== "linear"));
  assert.deepEqual(ids({ MCP_CONNECTOR_PROVIDERS_DISABLED: " linear , notion,linear " }), base.filter(id => id !== "linear" && id !== "notion"));
  // A provider with an operator-registered app is switched off too.
  const zoom = { MCP_PROVIDER_ZOOM_CLIENT_ID: "synthetic-client", MCP_PROVIDER_ZOOM_CLIENT_SECRET: "synthetic-client-secret", MCP_PROVIDER_ZOOM_TOKEN_SCOPE: "user:read" };
  assert.ok(ids(zoom).includes("zoom"));
  assert.ok(!ids({ ...zoom, MCP_CONNECTOR_PROVIDERS_DISABLED: "zoom" }).includes("zoom"));
  // The master switch still wins over the list.
  assert.deepEqual(mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "false" }), []);
  assert.deepEqual(mcpServers({}), []);
});

test("stored connection policy digests do not depend on how presets are selected", () => {
  // Pinned from the policies the former selection-list code produced; a change here disconnects stored connections.
  const pinned: Record<string, string> = {
    linear: "dd45804c0afb89b48d10a112e97ca5517205300053b7e141de55d91f91869234",
    notion: "447ed33e93d0f9497543cef9559ebc9153f8e976592b8182e8a3411d352aa01c",
    dropbox: "3072b05dd41e34377727ee84e2f4451033254e2da60633c3d613748f25a6f8fb",
    supabase: "d1f6a953766ceac871fcde7e5505e2f415a026b871920e0510e95d70560c238e",
    "microsoft-learn": "b96fb0b759373ac723e43deb6dfe9252c157b78b9ff621723b755efe1187eab2",
  };
  const all = servers();
  for (const [id, digest] of Object.entries(pinned)) assert.equal(mcpPolicyDigest(all.find(s => s.id === id)!), digest, id);
  const zoom = only("zoom", { MCP_PROVIDER_ZOOM_CLIENT_ID: "c", MCP_PROVIDER_ZOOM_CLIENT_SECRET: "s", MCP_PROVIDER_ZOOM_TOKEN_SCOPE: "user:read" })[0];
  assert.equal(mcpPolicyDigest(zoom), "0370e414719a250f6b5c800045a435a61fa912b9206969baf2be3d8cc084dd83");
  // Switching other providers off, or setting the removed variables, leaves each remaining policy byte for byte.
  const narrowed = servers({ MCP_CONNECTOR_PROVIDERS_DISABLED: all.filter(s => s.id !== "linear").map(s => s.id).join(","), MCP_CONNECTOR_PROVIDERS: "notion" });
  assert.deepEqual(narrowed.map(s => s.id), ["linear"]);
  assert.equal(JSON.stringify(narrowed[0]), JSON.stringify(all.find(s => s.id === "linear")));
});

test("catalog assets stay local, provenance stays public, and unavailable brands use a fallback", () => {
  const provenance = JSON.parse(readFileSync("public/plugins/providers/sources.json", "utf8")) as { assets: Array<{ provider: string; path: string; source: string }> };
  for (const provider of MCP_PROVIDERS) {
    assert.equal(new URL(provider.docs).protocol, "https:");
    if (!provider.logo) continue;
    assert.match(provider.logo, /^\/plugins\/providers\/[a-z0-9-]+\.(png|svg|jpg|webp)$/);
    assert.ok(readFileSync(`public${provider.logo}`).length);
    const asset = provenance.assets.find(asset => asset.provider === provider.id);
    assert.equal(asset?.path, provider.logo);
    assert.ok(["raw.githubusercontent.com", "avatars.githubusercontent.com"].includes(new URL(asset!.source).hostname));
  }
});

test("known OAuth providers use pinned endpoints, explicit scopes and confirmation-only tools", () => {
  const known = only("notion,linear,railway,figma");
  assert.equal(known.length, 4);
  for (const server of known) {
    assert.equal(server.auth, "oauth"); assert.ok(server.oauth?.registrationUrl); assert.deepEqual(server.readTools, []);
    assert.doesNotThrow(() => validateMcpEndpoint(server));
  }
  assert.equal(known.find(s => s.id === "notion")!.oauth!.scope, "default");
  assert.equal(known.find(s => s.id === "figma")!.oauth!.scope, "mcp:connect");
});

test("Google Gmail, Calendar and Drive stay closed until the operator registers a Google OAuth client", () => {
  const google = "gmail,google-calendar,google-drive";
  // Without a client nothing is callable (Google has no dynamic client registration).
  assert.deepEqual(only(google), []);
  // A client id without its secret is refused too.
  assert.deepEqual(only("gmail", { MCP_PROVIDER_GMAIL_CLIENT_ID: "synthetic-client" }), []);
  const env: Record<string, string> = { ...PREVIEW };
  for (const id of google.split(",")) {
    const prefix = providerEnvironmentPrefix(id);
    env[`${prefix}_CLIENT_ID`] = "synthetic-client";
    env[`${prefix}_CLIENT_SECRET`] = "synthetic-client-secret";
  }
  const googleServers = only(google, env);
  assert.deepEqual(googleServers.map(s => s.id).sort(), ["gmail", "google-calendar", "google-drive"]);
  const hosts = { gmail: "gmailmcp.googleapis.com", "google-calendar": "calendarmcp.googleapis.com", "google-drive": "drivemcp.googleapis.com" };
  for (const server of googleServers) {
    assert.equal(new URL(server.url).hostname, hosts[server.id as keyof typeof hosts]);
    assert.equal(server.oauth?.issuer, "https://accounts.google.com");
    assert.equal(server.oauth?.authorizationUrl, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(server.oauth?.tokenUrl, "https://oauth2.googleapis.com/token");
    assert.equal(server.oauth?.registrationUrl, undefined);
    assert.equal(server.oauth?.clientSecretEnv, `${providerEnvironmentPrefix(server.id)}_CLIENT_SECRET`);
    // The default asks only for read access. Offline access is Google's
    // access_type=offline request parameter, not a scope: Google's OAuth
    // endpoints document no `offline_access` scope.
    assert.ok(server.oauth?.scope.split(" ").every(scope => /^https:\/\/www\.googleapis\.com\/auth\/[a-z.]+readonly$/.test(scope)), server.id);
    assert.equal(server.oauth?.selectableScopes?.includes("offline_access"), false, server.id);
    assert.deepEqual(server.oauth?.authorizationParams, { access_type: "offline", prompt: "consent" });
    assert.deepEqual(server.readTools, []);
    assert.equal(JSON.stringify(server).includes("synthetic-client-secret"), false);
  }
  // An operator scope outside Google's published list closes the provider rather than widening it.
  assert.deepEqual(only("gmail", { ...env, MCP_PROVIDER_GMAIL_SCOPE: "https://mail.google.com/" }), []);
  assert.deepEqual(only("gmail", { ...env, MCP_PROVIDER_GMAIL_SCOPE: "offline_access" }), []);
});

test("only the Google profiles carry extra authorization parameters; every other request is the SDK's URL byte for byte", () => {
  const withParams = MCP_PROVIDER_PRESETS.filter(profile => "oauth" in profile && profile.oauth && "authorizationParams" in profile.oauth);
  assert.deepEqual(withParams.map(profile => profile.id).sort(), ["gmail", "google-calendar", "google-drive"]);
  for (const profile of MCP_PROVIDER_PRESETS.filter(p => p.auth === "oauth" && !["gmail", "google-calendar", "google-drive"].includes(p.id))) {
    const prefix = providerEnvironmentPrefix(profile.id);
    const env: Record<string, string> = { ...PREVIEW,
      [`${prefix}_CLIENT_ID`]: "synthetic-client", [`${prefix}_CLIENT_SECRET`]: "synthetic-client-secret" };
    if ("oauth" in profile && profile.oauth?.scopeRequired) env[`${prefix}_SCOPE`] = profile.oauth.allowedScopes[0];
    if ("oauth" in profile && !profile.oauth?.scope && !env[`${prefix}_SCOPE`]) env[`${prefix}_TOKEN_SCOPE`] = profile.oauth?.allowedScopes[0] ?? "x";
    for (const server of only(profile.id, env)) {
      // Absent, not undefined-valued: the connection policy digest is a JSON hash.
      assert.equal("authorizationParams" in (server.oauth ?? {}), false, profile.id);
    }
  }
  const sdkUrl = new URL("https://mcp.linear.app/authorize?response_type=code&client_id=a%20b&code_challenge=x-_~&code_challenge_method=S256&redirect_uri=https%3A%2F%2Ftomverse.app%2Fapi%2Fmcp%2Foauth%2Fcallback&state=s&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp");
  assert.equal(mcpAuthorizationRedirect(sdkUrl, undefined), sdkUrl.href);
  const google = new URL(mcpAuthorizationRedirect(
    new URL("https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=c&state=s&prompt=consent"),
    { access_type: "offline", prompt: "consent" }
  ));
  assert.equal(google.searchParams.get("access_type"), "offline");
  assert.deepEqual(google.searchParams.getAll("prompt"), ["consent"]);
  assert.equal(google.searchParams.get("client_id"), "c");
});

test("static app setup and unspecified scope requirements remain closed", () => {
  assert.deepEqual(only("asana,slack,zoom"), []);
  const zoomEnv = { MCP_PROVIDER_ZOOM_CLIENT_ID: "synthetic-client", MCP_PROVIDER_ZOOM_CLIENT_SECRET: "synthetic-client-secret", MCP_PROVIDER_ZOOM_TOKEN_SCOPE: "user:read" };
  const configured = only("zoom", zoomEnv);
  assert.equal(configured.length, 1); assert.equal(configured[0].oauth?.tokenAuthMethod, "client_secret_basic");
  assert.equal(JSON.stringify(servers(zoomEnv)).includes("synthetic-client-secret"), false);
  assert.deepEqual(only("notion,linear", { MCP_PROVIDER_NOTION_SCOPE: "admin" }).map(s => s.id), ["linear"]);
  assert.deepEqual(only("github"), []);
  // A client id without its secret, or a secret without a client id, closes a registered-app preset.
  assert.deepEqual(only("zoom", { MCP_PROVIDER_ZOOM_CLIENT_ID: "synthetic-client", MCP_PROVIDER_ZOOM_TOKEN_SCOPE: "user:read" }), []);
  assert.deepEqual(only("zoom", { MCP_PROVIDER_ZOOM_CLIENT_SECRET: "synthetic-client-secret", MCP_PROVIDER_ZOOM_TOKEN_SCOPE: "user:read" }), []);
});

test("every prepared profile validates as fixed HTTPS destinations using synthetic operator settings", () => {
  for (const profile of MCP_PROVIDER_PRESETS.filter(p => p.auth === "oauth" || p.auth === "none")) {
    const prefix = providerEnvironmentPrefix(profile.id);
    const env: Record<string, string> = { ...PREVIEW,
      [`${prefix}_CLIENT_ID`]: "synthetic-client", [`${prefix}_CLIENT_SECRET`]: "synthetic-client-secret" };
    if ("oauth" in profile && profile.oauth?.scopeRequired) env[`${prefix}_SCOPE`] = profile.oauth.allowedScopes[0];
    if ("oauth" in profile && !profile.oauth?.scope && !env[`${prefix}_SCOPE`]) env[`${prefix}_TOKEN_SCOPE`] = profile.oauth?.allowedScopes[0] ?? "synthetic-provider-scope";
    const [server] = only(profile.id, env);
    assert.ok(server, profile.id);
    assert.doesNotThrow(() => validateMcpEndpoint(server), profile.id);
    if (server.oauth) for (const url of [server.oauth.issuer, server.oauth.authorizationUrl, server.oauth.tokenUrl, ...(server.oauth.registrationUrl ? [server.oauth.registrationUrl] : [])])
      assert.doesNotThrow(() => validateMcpEndpoint({ ...server, url }, true), profile.id);
  }
});

test("providers without a published scope list require an explicit token scope bound without guessing broad consent", () => {
  const pair = (extra: Record<string, string> = {}) => only("monday,dropbox", extra);
  // Dropbox publishes its scopes, so the user chooses within them at connect time.
  assert.deepEqual(pair().map(s => [s.id, s.oauth?.scope, s.oauth?.selectableScopes?.includes("files.metadata.read")]), [["dropbox", "", true]]);
  const [server] = pair({ MCP_PROVIDER_MONDAY_TOKEN_SCOPE: "documents:read" }).filter(s => s.id === "monday");
  assert.equal(server.id, "monday"); assert.equal(server.oauth?.scope, "");
  assert.equal(server.oauth?.tokenScope, "documents:read");
  assert.deepEqual(pair({ MCP_PROVIDER_DROPBOX_TOKEN_SCOPE: "unadvertised:admin" }), []);
  assert.deepEqual(pair({ MCP_PROVIDER_MONDAY_TOKEN_SCOPE: "" }).map(s => s.id).sort(), ["dropbox", "monday"]);
});
