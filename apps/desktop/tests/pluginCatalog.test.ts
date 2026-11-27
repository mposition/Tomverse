import assert from "node:assert/strict";
import test from "node:test";
import { DesktopSessionRefused } from "../src/host/browser-login";
import { desktopChatApi } from "../src/host/chat-api";
import { createPluginCatalog, type CatalogRead } from "../src/host/plugin-catalog";
import { catalogMaxAge, pluginCatalogBody, pluginLogoUrl, PLUGIN_LOGO_ROUTE, type PluginCatalog } from "../src/plugin-catalog-contract";

const provider = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), category: "development", logo: `/plugins/providers/${id}.png`, docs: "https://example.org/" + id,
  sources: ["claude"], profiles: [id], kind: "remote", aliases: [id], logoOwner: "Owner", origins: ["https://mcp.example.org"], ...extra,
});
const catalog = (observedAt: string, ids: string[]): PluginCatalog => pluginCatalogBody.parse({ observedAt, providers: ids.map((id) => provider(id)) });

test("the catalogue is read with the web's fields, and what this app does not know is dropped or made neutral, never fatal", () => {
  const parsed = pluginCatalogBody.parse({ observedAt: "2026-11-27", providers: [
    provider("github"),
    provider("future-kind", { kind: "quantum", category: "robotics" }),
    provider("bad-logo", { logo: "https://evil.example/logo.png" }),
    provider("traversal", { logo: "/plugins/providers/../../secret.png" }),
    { id: "Not An Id", name: "x" },
    { nothing: true },
    provider("no-logo", { logo: null }),
  ] });
  assert.deepEqual(parsed.providers.map((entry) => entry.id), ["github", "future-kind", "bad-logo", "traversal", "no-logo"]);
  assert.equal(parsed.providers[0]?.logo, "/plugins/providers/github.png");
  assert.equal("logoOwner" in parsed.providers[0]!, false);
  assert.deepEqual([parsed.providers[1]?.kind, parsed.providers[1]?.category], ["adapter", "other"]);
  assert.equal(parsed.providers[2]?.logo, null, "a logo is only ever a file of the account's own providers folder");
  assert.equal(parsed.providers[3]?.logo, null);
  assert.equal(parsed.providers[4]?.logo, null);
  assert.equal(parsed.observedAt, "2026-11-27");
  assert.throws(() => pluginCatalogBody.parse({ providers: [] }));
});

test("a response's lifetime comes from its Cache-Control header", () => {
  assert.equal(catalogMaxAge("private, max-age=600, must-revalidate"), 600);
  assert.equal(catalogMaxAge("max-age=0"), 0);
  assert.equal(catalogMaxAge("no-store"), 0);
  assert.equal(catalogMaxAge(null), 0);
  assert.equal(catalogMaxAge("max-age=99999999"), 86_400);
  assert.equal(catalogMaxAge("s-maxage=500"), 0);
});

test("a logo is addressed by the app's own origin, and only a platform id fits that address", () => {
  assert.equal(pluginLogoUrl("github", 3), "tomverse://desktop/plugin-logo/3/github");
  assert.notEqual(pluginLogoUrl("github", 3), pluginLogoUrl("github", 4), "a new list gives the images a new address");
  assert.deepEqual(PLUGIN_LOGO_ROUTE.exec("/plugin-logo/3/github")?.slice(1), ["3", "github"]);
  for (const route of ["/plugin-logo/", "/plugin-logo/github", "/plugin-logo/3/GitHub", "/plugin-logo/x/github", "/plugin-logo/3/a/b", "/plugin-logo/3/../assets/x.js", "/plugin-logo/3/a%2Fb", "/plugin-logos/3/a", "/plugin-logo/1234567890/a"]) {
    assert.equal(PLUGIN_LOGO_ROUTE.test(route), false, route);
  }
});

test("the list is held for the lifetime the server named, then revalidated with its ETag, and a refresh asks at once", async () => {
  let clock = 1_000_000;
  const reads: Array<string | undefined> = [];
  let next: CatalogRead = { status: "ok", catalog: catalog("2026-11-27", ["a", "b", "c"]), etag: "\"v1\"", maxAge: 600 };
  const host = createPluginCatalog({ now: () => clock, fetchLogo: async () => new Response(null, { status: 404 }),
    read: async (known) => { reads.push(known); return next; } });
  assert.deepEqual((await host.read()).providers.map((entry) => entry.id), ["a", "b", "c"]);
  clock += 599_000;
  await host.read();
  assert.deepEqual(reads, [undefined], "still fresh: no request");
  // A refresh asks even though the copy is fresh; the server says nothing changed, so the copy stays and its clock restarts.
  next = { status: "not-modified", maxAge: 600 };
  assert.equal((await host.read(true)).providers.length, 3);
  assert.deepEqual(reads, [undefined, "\"v1\""]);
  clock += 599_000;
  await host.read();
  assert.equal(reads.length, 2, "the 304 restarted the lifetime");
  // A fourth platform on the server appears on the next refresh without a new app.
  next = { status: "ok", catalog: catalog("2026-11-28", ["a", "b", "c", "d"]), etag: "\"v2\"", maxAge: 600 };
  assert.deepEqual((await host.read(true)).providers.map((entry) => entry.id), ["a", "b", "c", "d"]);
  clock += 601_000;
  next = { status: "not-modified", maxAge: 600 };
  assert.equal((await host.read()).providers.length, 4);
  assert.deepEqual(reads.slice(2), ["\"v1\"", "\"v2\""]);
});

test("a read that fails leaves the copy held, and a lifetime of zero means every open asks", async () => {
  const clock = 5_000;
  let fail = false;
  let reads = 0;
  const host = createPluginCatalog({ now: () => clock, fetchLogo: async () => new Response(null, { status: 404 }),
    read: async () => { reads += 1; if (fail) throw new Error("offline"); return { status: "ok", catalog: catalog("2026-11-27", ["a"]), etag: null, maxAge: 0 }; } });
  await host.read();
  await host.read();
  assert.equal(reads, 2, "no lifetime, no reuse");
  fail = true;
  await assert.rejects(host.read(true));
  fail = false;
  assert.equal((await host.read()).providers.length, 1, "the next read works again");
  // Two screens opening together make one request.
  const slow = createPluginCatalog({ now: () => clock, fetchLogo: async () => new Response(null, { status: 404 }),
    read: async () => { reads += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { status: "ok", catalog: catalog("x", ["a"]), etag: null, maxAge: 60 }; } });
  const before = reads;
  await Promise.all([slow.read(), slow.read(true), slow.read()]);
  assert.equal(reads - before, 1);
  // A "not modified" for a list this process never received is not believed.
  const lost = createPluginCatalog({ now: () => clock, fetchLogo: async () => new Response(null, { status: 404 }), read: async () => ({ status: "not-modified", maxAge: 60 }) });
  await assert.rejects(lost.read());
});

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test("a logo is fetched from the path the server named, only as an image of a sensible size, and only for a listed platform", async () => {
  const fetched: string[] = [];
  let response = () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.byteLength) } });
  const host = createPluginCatalog({ fetchLogo: async (path) => { fetched.push(path); return response(); },
    read: async () => ({ status: "ok", etag: null, maxAge: 600, catalog: pluginCatalogBody.parse({ observedAt: "d", providers: [
      provider("github"), provider("plain", { logo: null }), provider("evil", { logo: "//evil.example/x.png" })] }) }) });
  // Nothing is served before a list was read: an address cannot name a file the server never listed.
  assert.equal(await host.logo("github"), null);
  await host.read();
  const first = await host.logo("github");
  assert.deepEqual([first?.type, first?.bytes.byteLength], ["image/png", png.byteLength]);
  assert.deepEqual(fetched, ["/plugins/providers/github.png"]);
  await host.logo("github");
  assert.equal(fetched.length, 1, "a logo that was read is kept");
  for (const id of ["plain", "evil", "unknown", "../etc"]) assert.equal(await host.logo(id), null, id);
  assert.equal(fetched.length, 1, "no request for a platform without a valid logo path");
  // Not an image, too large, or not found: the person sees the platform's placeholder, and the next ask tries again.
  const host2 = createPluginCatalog({ fetchLogo: async (path) => { fetched.push(path); return response(); },
    read: async () => ({ status: "ok", etag: null, maxAge: 600, catalog: catalog("d", ["html", "big", "gone", "ok"]) }) });
  await host2.read();
  fetched.length = 0;
  response = () => new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } });
  assert.equal(await host2.logo("html"), null);
  response = () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(600 * 1024) } });
  assert.equal(await host2.logo("big"), null);
  response = () => new Response(new Uint8Array(600 * 1024), { headers: { "content-type": "image/png" } });
  assert.equal(await host2.logo("big"), null, "a body past the limit is refused even without a length");
  response = () => new Response(null, { status: 404 });
  assert.equal(await host2.logo("gone"), null);
  response = () => { throw new Error("offline"); };
  assert.equal(await host2.logo("gone"), null);
  response = () => new Response(png, { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
  assert.equal((await host2.logo("ok"))?.type, "image/svg+xml");
});

test("a logo kept for one list is dropped when the server publishes a new one", async () => {
  let version = "1";
  let served = 0;
  const host = createPluginCatalog({ fetchLogo: async () => { served += 1; return new Response(png, { headers: { "content-type": "image/png" } }); },
    read: async () => ({ status: "ok", etag: null, maxAge: 0, catalog: catalog(version, ["a"]) }) });
  await host.read();
  await host.logo("a");
  await host.logo("a");
  assert.equal(served, 1);
  version = "2";
  await host.read();
  await host.logo("a");
  assert.equal(served, 2);
});

test("the server read uses the Desktop bearer, revalidates with the ETag, and tells a refused sign-in from an unchanged list", async (t) => {
  const calls: Array<{ url: string; headers: Headers; options: RequestInit | undefined }> = [];
  let reply = () => new Response(JSON.stringify({ observedAt: "2026-11-27", providers: [provider("a")] }), {
    headers: { etag: "\"e1\"", "cache-control": "private, max-age=600, must-revalidate", "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (input: URL | string, options?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(options?.headers), options });
    return reply();
  });
  const api = desktopChatApi("fixture-access", new AbortController().signal, "https://account.example");
  const fresh = await api.pluginCatalog();
  assert.deepEqual([fresh.status, fresh.status === "ok" && fresh.etag, fresh.status === "ok" && fresh.maxAge], ["ok", "\"e1\"", 600]);
  assert.equal(calls[0]?.url, "https://account.example/api/mcp/providers");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer fixture-access");
  assert.equal(calls[0]?.headers.get("origin"), "tomverse://desktop");
  assert.equal(calls[0]?.headers.has("if-none-match"), false);
  assert.equal(calls[0]?.headers.has("cookie"), false);
  assert.equal(calls[0]?.options?.method, "GET");
  assert.equal(calls[0]?.options?.redirect, "error");
  assert.equal(calls[0]?.options?.credentials, "omit");
  reply = () => new Response(null, { status: 304, headers: { "cache-control": "private, max-age=300" } });
  assert.deepEqual(await api.pluginCatalog("\"e1\""), { status: "not-modified", maxAge: 300 });
  assert.equal(calls[1]?.headers.get("if-none-match"), "\"e1\"");
  reply = () => new Response("{}", { status: 401 });
  await assert.rejects(api.pluginCatalog(), DesktopSessionRefused);
  reply = () => new Response("{}", { status: 503 });
  await assert.rejects(api.pluginCatalog());
  reply = () => new Response(JSON.stringify({ providers: "nope" }), { headers: { "content-type": "application/json" } });
  await assert.rejects(api.pluginCatalog());
});

test("a logo body is read only up to the limit, however the response is declared, and the stream is dropped when it goes past", async () => {
  let pulled = 0;
  let cancelled = false;
  const endless = () => new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(100 * 1024)); },
    cancel() { cancelled = true; },
  });
  const host = createPluginCatalog({
    // No length is declared, or a false small one: neither lets the body through unread.
    fetchLogo: async () => new Response(endless(), { headers: { "content-type": "image/png", "content-length": "10" } }),
    read: async () => ({ status: "ok", etag: null, maxAge: 600, catalog: catalog("d", ["a"]) }),
  });
  await host.read();
  assert.equal(await host.logo("a"), null);
  assert.ok(cancelled, "the stream was cancelled");
  assert.ok(pulled <= 8, `read ${pulled} chunks of an endless stream`);
});

test("a logo is read again when the server sends a new list, or names another file for the platform", async () => {
  let path = "/plugins/providers/a.png";
  let etag = "\"v1\"";
  const served: string[] = [];
  const host = createPluginCatalog({
    fetchLogo: async (requested) => { served.push(requested); return new Response(png, { headers: { "content-type": "image/png" } }); },
    read: async () => ({ status: "ok", etag, maxAge: 0, catalog: pluginCatalogBody.parse({ observedAt: "same-day", providers: [provider("a", { logo: path })] }) }),
  });
  await host.read();
  await host.logo("a");
  await host.logo("a");
  assert.equal(served.length, 1);
  // The same date and the same path, but a different ETag: the server has a new list, so its pictures may be new too.
  etag = "\"v2\"";
  await host.read();
  await host.logo("a");
  assert.equal(served.length, 2);
  path = "/plugins/providers/a-new.png";
  await host.read();
  await host.logo("a");
  assert.deepEqual(served, ["/plugins/providers/a.png", "/plugins/providers/a.png", "/plugins/providers/a-new.png"]);
});

test("the revision moves with each list the server sends and not with an unchanged answer, and a late logo of a replaced list is not kept", async () => {
  let next: CatalogRead = { status: "ok", catalog: catalog("d", ["a"]), etag: "\"v1\"", maxAge: 0 };
  let release: () => void = () => {};
  const gate = () => new Promise<void>((resolve) => { release = resolve; });
  let hold: Promise<void> | undefined;
  let served = 0;
  const host = createPluginCatalog({
    read: async () => next,
    fetchLogo: async () => { served += 1; await hold; return new Response(png, { headers: { "content-type": "image/png" } }); },
  });
  const first = await host.read();
  assert.equal(first.revision, 1);
  next = { status: "not-modified", maxAge: 0 };
  assert.equal((await host.read()).revision, 1, "an unchanged answer is the same copy");
  next = { status: "ok", catalog: catalog("d", ["a"]), etag: "\"v2\"", maxAge: 0 };
  assert.equal((await host.read()).revision, 2);
  // A picture still on its way when the server's new list arrives belongs to the old list: it is shown once, and read again next time.
  hold = gate();
  const late = host.logo("a");
  next = { status: "ok", catalog: catalog("d", ["a"]), etag: "\"v3\"", maxAge: 0 };
  assert.equal((await host.read()).revision, 3);
  release();
  assert.ok(await late);
  assert.equal(served, 1);
  hold = undefined;
  await host.logo("a");
  await host.logo("a");
  assert.equal(served, 2, "read again for the new list, then kept");
});
