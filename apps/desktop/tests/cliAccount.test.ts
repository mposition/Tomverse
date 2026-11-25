import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { unknownCliAccount } from "../src/code-execution";
import { claudeAccountFromStatus } from "../src/host/claude-account";
import { inspectIsolatedAcpAccount, type Frame } from "../src/host/cli-protocol";

const now = Date.parse("2026-11-22T00:00:00.000Z");
const subscription = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" };
const signedOut = { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
const parse = (value: unknown, exitCode = 0) => claudeAccountFromStatus(JSON.stringify(value), exitCode, now);

test("CLI account status distinguishes subscription, API billing and unknown without forwarding credentials or identity", () => {
  assert.deepEqual(parse({ ...subscription, email: "fixture@example.invalid", token: "fixture-secret" }),
    { status: "signedIn", billingSource: "provider_subscription" });
  assert.deepEqual(parse({ ...subscription, subscriptionType: "free" }), { status: "signedIn", billingSource: "unknown" });
  assert.deepEqual(parse({ ...subscription, subscriptionType: null }), { status: "signedIn", billingSource: "unknown" });
  assert.deepEqual(parse({ ...subscription, apiProvider: "custom" }), { status: "signedIn", billingSource: "unknown" });
  assert.deepEqual(parse({ ...subscription, authMethod: "api_key" }), { status: "signedIn", billingSource: "provider_api" });
  assert.deepEqual(parse({ ...subscription, authMethod: "third_party", apiProvider: "bedrock" }), { status: "signedIn", billingSource: "provider_api" });
  assert.deepEqual(parse({ ...subscription, authMethod: "oauth_token" }), { status: "signedIn", billingSource: "unknown" });
});

test("CLI account checks drop stale, malformed and other-profile status", () => {
  assert.deepEqual(parse({ ...subscription, loginExpiresAt: "2026-11-01T00:00:00.000Z" }),
    { status: "signInExpired", billingSource: "unknown" });
  assert.deepEqual(parse(signedOut, 1), { status: "signInRequired", billingSource: "unknown" });
  assert.deepEqual(parse(subscription, 1), unknownCliAccount);
  assert.deepEqual(parse({ ...subscription, loginExpiresAt: "tomorrow" }), unknownCliAccount);
  assert.deepEqual(claudeAccountFromStatus("truncated JSON", 0), unknownCliAccount);
  const status = JSON.stringify({ ...subscription, configDirectory: "different-profile" });
  assert.deepEqual(claudeAccountFromStatus(status, 0, now, "current-test-profile"), unknownCliAccount);
});

test("Grok requires explicit signed-out metadata from the verified profile and stops after initialization", async () => {
  const versions = { client: "0.1.73", executable: "1.0.92" };
  const profile = resolve("isolated-grok-profile");
  const loginMethod = { id: "grok.com" };
  const metadata = { grokShell: true, agentVersion: versions.executable, currentWorkingDirectory: profile, defaultAuthMethodId: null };
  async function probe(_meta: unknown, authMethods = [loginMethod]) {
    const requests: Frame[] = [];
    const result = await inspectIsolatedAcpAccount({
      send: (frame) => requests.push(frame),
      read: async (match) => {
        const reply = { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, authMethods, _meta } };
        assert.ok(match(reply));
        return reply;
      },
    }, "xai", profile, versions);
    assert.deepEqual(requests.map(({ method }) => method), ["initialize"]);
    return result;
  }

  assert.deepEqual(await probe({ ...metadata, token: "fixture-private-value" }), {
    status: "signInRequired", billingSource: "unknown",
  });
  assert.deepEqual(await probe({ ...metadata, currentWorkingDirectory: profile + "-other" }), unknownCliAccount);
  assert.deepEqual(await probe({ ...metadata, agentVersion: "1.0.0" }), unknownCliAccount);
  assert.deepEqual(await probe({ ...metadata, defaultAuthMethodId: undefined }), unknownCliAccount);
  assert.deepEqual(await probe({ ...metadata, defaultAuthMethodId: "cached_token" }, [loginMethod, { id: "cached_token" }]), unknownCliAccount);
  assert.deepEqual(await probe(metadata, [loginMethod, { id: "xai.api_key" }]), unknownCliAccount);
});

test("MiniMax classifies only the pinned agent's explicit session-start sign-in requirement", async () => {
  const versions = { client: "0.1.74", executable: "0.7.9" };
  const profile = resolve("isolated-minimax-profile");
  const loginRequired = { code: -32000, message: "Authentication required: Run `mcode login` and try again." };
  async function probe(outcome: { error?: { code: number; message: string }; result?: object }) {
    const requests: Frame[] = [];
    const result = await inspectIsolatedAcpAccount({
      send: (frame) => requests.push(frame),
      read: async (match) => {
        const reply = requests.length === 1
          ? { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "minimax-code", version: versions.executable } } }
          : { jsonrpc: "2.0", id: requests[1].id, ...outcome };
        assert.ok(match(reply));
        return reply;
      },
    }, "minimax", profile, versions);
    assert.deepEqual(requests.map(({ method }) => method), ["initialize", "session/new"]);
    assert.deepEqual(requests[1].params, { cwd: profile, mcpServers: [] });
    return result;
  }

  assert.deepEqual(await probe({ error: loginRequired }), { status: "signInRequired", billingSource: "unknown" });
  assert.deepEqual(await probe({ error: { ...loginRequired, message: "Authentication required" } }), unknownCliAccount);
  assert.deepEqual(await probe({ error: { ...loginRequired, code: -32603 } }), unknownCliAccount);
  assert.deepEqual(await probe({ error: loginRequired, result: { sessionId: "fixture" } }), unknownCliAccount);
  assert.deepEqual(await probe({ result: { sessionId: "fixture" } }), unknownCliAccount);
});
