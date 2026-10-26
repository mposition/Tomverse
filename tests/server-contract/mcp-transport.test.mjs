import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
const sockets = [];
let pauseLookup = false;
mock.module("node:dns/promises", { namedExports: { lookup: async () => pauseLookup ? new Promise(() => {}) : [{ address: "93.184.216.34", family: 4 }] } });
mock.module("node:https", { namedExports: { request: (options, callback) => {
  sockets.push(options);
  const request = new EventEmitter();
  request.end = () => queueMicrotask(() => {
    const response = new PassThrough(); response.statusCode = 200; response.headers = { "content-type": "application/json" };
    callback(response); response.end("{}");
  });
  request.destroy = () => {};
  return request;
} } });
const { guardedMcpFetch } = await import("../../lib/mcpConnectorClient.ts");
test("credentialed HTTPS requests cannot share an agent and retain their verified peer name", async () => {
  for (const [host, token] of [["first.example", "synthetic-first"], ["second.example", "synthetic-second"]]) {
    const server = { id: "fixture", name: "Fixture", url: `https://${host}/mcp`, auth: "bearer", readTools: [] };
    const fetcher = guardedMcpFetch(server, token, new AbortController().signal);
    const response = await fetcher(server.url, { method: "POST", body: "{}", headers: { cookie: "must-not-leave", authorization: "Tomverse-session-must-not-leave" } });
    await response.text();
    const options = sockets.at(-1);
    assert.equal(options.hostname, "93.184.216.34"); assert.equal(options.servername, host);
    assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.headers.host, host); assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.headers.cookie, undefined);
    await assert.rejects(() => fetcher("https://other.example/mcp", { method: "POST" }), { code: "unexpected_endpoint" });
  }
  assert.equal(sockets.length, 2);
});
test("a cancelled DNS lookup returns before opening a credentialed socket", async () => {
  pauseLookup = true;
  const controller = new AbortController();
  const fetcher = guardedMcpFetch({ id: "fixture", name: "Fixture", url: "https://slow.example/mcp", auth: "bearer", readTools: [] }, "synthetic", controller.signal);
  const request = fetcher("https://slow.example/mcp", { method: "POST", body: "{}" });
  controller.abort();
  await assert.rejects(request, { code: "cancelled_or_timeout" });
  assert.equal(sockets.length, 2);
});

test("OAuth Basic credentials match the owned client exactly and cannot carry a Tomverse session", async () => {
  pauseLookup = false;
  const server = { id: "fixture", name: "Fixture", url: "https://oauth.example/token", auth: "oauth", readTools: [] };
  const authorization = `Basic ${Buffer.from("synthetic-client:synthetic-secret").toString("base64")}`;
  const fetcher = guardedMcpFetch(server, null, new AbortController().signal, true, authorization);
  const response = await fetcher(server.url, { method: "POST", body: "grant_type=authorization_code", headers: { authorization, cookie: "private-session" } });
  await response.text();
  assert.equal(sockets.at(-1).headers.authorization, authorization);
  assert.equal(sockets.at(-1).headers.cookie, undefined);
  const opened = sockets.length;
  for (const authorization of ["Bearer Tomverse-session", "Basic wrong-client"])
    await assert.rejects(() => fetcher(server.url, { method: "POST", headers: { authorization } }), { code: "oauth_client_authorization_refused" });
  const registration = { ...server, url: "https://oauth.example/register" };
  await assert.rejects(() => guardedMcpFetch(registration, null, new AbortController().signal, true)(registration.url,
    { method: "POST", headers: { authorization } }), { code: "oauth_client_authorization_refused" });
  assert.throws(() => guardedMcpFetch(server, "Tomverse-session", new AbortController().signal, true), { code: "oauth_client_authorization_refused" });
  assert.equal(sockets.length, opened);
});
