import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { createGithubPreviewSetup, githubPreviewAppConfig, githubPreviewManifest } from "../scripts/mcp-github-app-setup";
const app = { client_id: "Iv1.synthetic", client_secret: "synthetic-client-secret-123", slug: "tomverse-local-synthetic", owner: { login: "mposition" },
  permissions: { issues: "write", metadata: "read" }, pem: "synthetic-pem", webhook_secret: "synthetic-webhook" };
function getLocal(origin: string, path: string, cookie = "", host = "127.0.0.1:3132") {
  return new Promise<Response>((resolve, reject) => {
    const req = request(`${origin}${path}`, { headers: { Host: host, Cookie: cookie } }, res => {
      const parts: Buffer[] = []; res.on("data", part => parts.push(part));
      res.on("end", () => {
        const headers = new Headers(); for (const [name, value] of Object.entries(res.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(",") : value);
        resolve(new Response(new Uint8Array(Buffer.concat(parts)), { status: res.statusCode, headers }));
      }); res.on("error", reject);
    }); req.on("error", reject); req.end();
  });
}

test("manifest requests only issue access with no active webhook, and discards unused secrets", () => {
  const manifest = githubPreviewManifest("synthetic");
  assert.equal(manifest.public, false); assert.equal(manifest.hook_attributes.active, false);
  assert.deepEqual(manifest.default_permissions, { issues: "write", metadata: "read" });
  const config = githubPreviewAppConfig(app), saved = JSON.stringify(config);
  for (const secret of [app.pem, app.webhook_secret]) assert.equal(saved.includes(secret), false);
  assert.equal(config.repositoryId, 1309523852);
  assert.throws(() => githubPreviewAppConfig({ ...app, permissions: { ...app.permissions, contents: "write" } }));
  assert.throws(() => githubPreviewAppConfig({ ...app, owner: { login: "another-user" } }));
});

test("local setup requires an owner cookie and one-use state, refuses rebinding, and never returns credentials", async () => {
  let exchanges = 0, saves = 0;
  const setup = createGithubPreviewSetup({ exchange: async () => { exchanges++; return app; }, persist: async () => { saves++; } });
  await new Promise<void>(resolve => setup.server.listen(0, "127.0.0.1", resolve));
  const address = setup.server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const get = (path: string, cookie = "", host = "127.0.0.1:3132") => getLocal(origin, path, cookie, host);
  try {
    assert.equal((await get("/")).status, 403);
    const boot = await get(new URL(setup.bootstrapUrl).pathname);
    assert.equal(boot.status, 303); const cookie = boot.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await get(new URL(setup.bootstrapUrl).pathname)).status, 403);
    assert.equal((await get("/", cookie, "evil.example:3132")).status, 403);
    const page = await (await get("/", cookie)).text(), state = page.match(/\?state=([A-Za-z0-9_-]+)/)![1];
    assert.equal((await get("/callback?code=synthetic&state=forged", cookie)).status, 403);
    const outcomes = await Promise.all([get(`/callback?code=synthetic&state=${state}`, cookie), get(`/callback?code=synthetic&state=${state}`, cookie)]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [303, 403]);
    assert.equal(exchanges, 1); assert.equal(saves, 1);
    const complete = await (await get("/", cookie)).text();
    assert.ok(complete.includes("Install on TomverseCode only"));
    for (const secret of [app.client_secret, app.pem, app.webhook_secret]) assert.equal(complete.includes(secret), false);
  } finally { setup.server.closeAllConnections(); await new Promise<void>(resolve => setup.server.close(() => resolve())); }
});

test("unknown manifest exchange outcomes cannot be replayed, and setup expires", async () => {
  let now = 0, calls = 0;
  const setup = createGithubPreviewSetup({ exchange: async () => { calls++; throw new Error("synthetic uncertain outcome"); }, persist: async () => {}, now: () => now });
  await new Promise<void>(resolve => setup.server.listen(0, "127.0.0.1", resolve));
  const address = setup.server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const get = (path: string, cookie = "") => getLocal(origin, path, cookie);
  try {
    const boot = await get(new URL(setup.bootstrapUrl).pathname), cookie = boot.headers.get("set-cookie")!.split(";")[0];
    const page = await (await get("/", cookie)).text(), state = page.match(/\?state=([A-Za-z0-9_-]+)/)![1];
    assert.equal((await get(`/callback?code=synthetic&state=${state}`, cookie)).status, 303);
    assert.equal((await get(`/callback?code=synthetic&state=${state}`, cookie)).status, 403); assert.equal(calls, 1);
    now = 15 * 60_000;
    assert.equal((await get("/", cookie)).status, 403);
  } finally { setup.server.closeAllConnections(); await new Promise<void>(resolve => setup.server.close(() => resolve())); }
});
