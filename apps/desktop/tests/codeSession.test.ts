import assert from "node:assert/strict";
import test from "node:test";
import { Gateway, GatewayError } from "../../tomverse-cli/src/gateway.js";
import { resolveEndpoint } from "../../tomverse-cli/src/runtime.js";
import { codeSessionConnection, codeSessionIdentity, createCodeSessionTokens } from "../src/host/code-session";
import { readDesktopCapabilities } from "../src/host/desktop-capabilities";
import { cleanText, hasCredential } from "../src/host/journal-view";

const origin = "http://127.0.0.1:4318";
const endpoint = resolveEndpoint({ endpoint: origin + "/api/code/v1", allowInsecureLocalhost: true }, {});
const TOKEN_A = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.signature-one-aaaaaaaaaaaaaaaa";
const TOKEN_B = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.signature-two-bbbbbbbbbbbbbbbb";

test("the session connection names the account without carrying a secret or the account id", () => {
  const connection = codeSessionConnection("account-1", origin);
  assert.deepEqual(connection, { endpoint: origin + "/api/code/v1", key: codeSessionIdentity("account-1"), session: true });
  assert.equal(codeSessionIdentity("account-1"), codeSessionIdentity("account-1"), "stable across renewals");
  assert.notEqual(codeSessionIdentity("account-1"), codeSessionIdentity("account-2"), "one per account");
  assert.ok(!connection.key.includes("account-1"));
  // Not shaped like a Code key, so no key check mistakes it for one, and scrubbing it never touches real text.
  assert.equal(hasCredential("a plain sentence", connection.key), false);
  assert.equal(cleanText("plain", connection.key), "plain");
});

test("the engine sends the token in force with the Desktop origin, follows each renewal and stops at sign-out", async () => {
  const tokens = createCodeSessionTokens();
  const connection = codeSessionConnection("account-1", origin);
  const sent: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json({ data: [] });
  }) as typeof fetch;
  const gateway = new Gateway(endpoint, tokens.credential(connection), fetchImpl, "tomverse-desktop");

  // Nothing is sent before the app hands over a token, and the refusal says nothing went out.
  await assert.rejects(gateway.models(), (error) => error instanceof GatewayError && error.extra.status === 401 &&
    error.extra.code === "desktop_session_required");
  assert.equal(sent.length, 0);

  tokens.set(connection.key, TOKEN_A);
  await gateway.models();
  assert.equal(sent.at(-1)?.headers.get("authorization"), `Bearer ${TOKEN_A}`);
  assert.equal(sent.at(-1)?.headers.get("origin"), "tomverse://desktop");
  assert.equal(sent.at(-1)?.url, origin + "/api/code/v1/models");

  // A renewal reaches the same gateway, which the running task keeps.
  tokens.set(connection.key, TOKEN_B);
  await gateway.models();
  assert.equal(sent.at(-1)?.headers.get("authorization"), `Bearer ${TOKEN_B}`);

  // A token for another account is not this connection's.
  tokens.set(codeSessionIdentity("account-2"), TOKEN_A);
  await assert.rejects(gateway.models(), GatewayError);

  // Sign-out: no further request leaves.
  tokens.set(connection.key, TOKEN_B);
  tokens.set(connection.key, null);
  const before = sent.length;
  await assert.rejects(gateway.models(), GatewayError);
  assert.equal(sent.length, before);
});

test("a generation after sign-out is refused before any intent is recorded, so nothing is left unknown", async () => {
  const tokens = createCodeSessionTokens();
  const connection = codeSessionConnection("account-1", origin);
  let fetched = 0;
  const gateway = new Gateway(endpoint, tokens.credential(connection), (async () => { fetched += 1; return new Response("{}"); }) as typeof fetch);
  let recorded = 0;
  const hooks = {
    before: async () => { recorded += 1; return { idempotencyKey: "intent-1" }; },
    headers: async () => undefined, failed: async () => undefined, ended: async () => undefined,
  };
  const generate = gateway.generationFetch(hooks);
  await assert.rejects(generate(origin + "/api/code/v1/chat/completions", { method: "POST", body: "{}" }),
    (error) => error instanceof GatewayError && error.extra.code === "desktop_session_required");
  assert.equal(recorded, 0, "no intent");
  assert.equal(fetched, 0, "no request");
  tokens.set(connection.key, TOKEN_A);
  await generate(origin + "/api/code/v1/chat/completions", { method: "POST", body: "{}" });
  assert.deepEqual([recorded, fetched], [1, 1]);
});

test("a session gateway knows its own token as a credential and lists under the session's identity", () => {
  const tokens = createCodeSessionTokens();
  const connection = codeSessionConnection("account-1", origin);
  const gateway = new Gateway(endpoint, tokens.credential(connection));
  tokens.set(connection.key, TOKEN_A);
  assert.equal(gateway.keyPrefix, connection.key.slice(0, 12));
  assert.equal(gateway.carriesKey(`query ${TOKEN_A}`), true, "the token is never sent anywhere but as the credential");
  assert.equal(gateway.carriesKey(`query ${connection.key}`), true);
  assert.equal(gateway.carriesKey("node 22 release notes"), false);
  // A key gateway is unchanged.
  const key = "tvk_abcdefgh_" + "A".repeat(43);
  const keyed = new Gateway(endpoint, key);
  assert.equal(keyed.keyPrefix, "tvk_abcdefgh");
  assert.equal(keyed.carriesKey(key), true);
});

test("Code runs on the session only where the server names desktopCodeSession", async (t) => {
  let body: Record<string, unknown> = { autoSelection: { offered: false } };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const load = () => readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  assert.equal((await load())?.codeSession, false, "an older server: the Code key path");
  body = { ...body, desktopCodeSession: true };
  assert.equal((await load())?.codeSession, true);
});
