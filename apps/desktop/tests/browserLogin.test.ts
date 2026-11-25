import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { signInThroughBrowser } from "../src/host/browser-login";

test("browser sign-in binds a loopback request and exchanges only a matching callback", { timeout: 10_000 }, async (context) => {
  const account = { id: "account", name: "Desktop Test", email: "desktop@example.test" };
  let exchangeCount = 0;
  let confirmCount = 0;
  let authorization: URL;
  let exchange: Record<string, string> | undefined;
  let browserNavigation: Promise<void> | undefined;
  const api = createServer(async (request, response) => {
    const path = request.url;
    response.setHeader("Content-Type", "application/json");
    if (path === "/api/auth/desktop/exchange") {
      exchangeCount++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      exchange = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.end(JSON.stringify({ ok: true, accessToken: "test-access", refreshToken: "test-refresh", expiresIn: 120 }));
    } else if (path === "/api/auth/desktop/session" && request.headers.authorization === "Bearer test-access") {
      confirmCount++;
      response.end(JSON.stringify({ ok: true, account }));
    } else {
      response.writeHead(404).end("{}");
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  context.after(() => { api.close(); api.closeAllConnections(); });
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const signal = new AbortController();
  const result = await signInThroughBrowser({
    origin: `http://127.0.0.1:${address.port}`, signal: signal.signal, version: "0.1.0",
    openExternal: (url) => browserNavigation = (async () => {
      authorization = new URL(url);
      const redirect = authorization.searchParams.get("redirect_uri");
      const state = authorization.searchParams.get("state");
      assert.ok(redirect && state);
      assert.equal(authorization.pathname, "/auth/desktop");
      assert.equal(authorization.searchParams.get("client_id"), "tomverse-desktop");
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorization.searchParams.has("code_verifier"), false);
      const callback = new URL(redirect);
      callback.search = new URLSearchParams({ grant: "A".repeat(43), state: "B".repeat(43) }).toString();
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.append("state", state);
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("state", state);
      const wrongPath = new URL(callback);
      wrongPath.pathname = "/different";
      assert.equal((await fetch(wrongPath)).status, 404);
      assert.equal(exchangeCount, 0);
      const accepted = await fetch(callback);
      assert.equal(accepted.status, 200);
      assert.match(await accepted.text(), /connected/);
      assert.equal(accepted.headers.get("referrer-policy"), "no-referrer");
    })(),
  });
  await browserNavigation;
  assert.deepEqual(result.account, account);
  assert.equal(exchangeCount, 1);
  assert.equal(confirmCount, 1);
  assert.equal(exchange?.clientId, "tomverse-desktop");
  assert.equal(exchange?.redirectUri, authorization!.searchParams.get("redirect_uri"));
  assert.equal(exchange?.state, authorization!.searchParams.get("state"));
  assert.equal(createHash("sha256").update(exchange!.codeVerifier!).digest("base64url"),
    authorization!.searchParams.get("code_challenge"));
  const callback = new URL(authorization!.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ grant: "A".repeat(43), state: exchange!.state! }).toString();
  await assert.rejects(fetch(callback));
  assert.equal(exchangeCount, 1);
});

test("cancelling browser sign-in closes its listener before a later callback", { timeout: 5_000 }, async () => {
  const cancellation = new AbortController();
  let address: URL | undefined;
  await assert.rejects(signInThroughBrowser({
    signal: cancellation.signal, version: "0.1.0",
    openExternal: async (url) => {
      address = new URL(url);
      cancellation.abort();
    },
  }), { name: "AbortError" });
  const redirect = new URL(address!.searchParams.get("redirect_uri")!);
  redirect.search = new URLSearchParams({ grant: "A".repeat(43), state: address!.searchParams.get("state")! }).toString();
  await assert.rejects(fetch(redirect));
});
