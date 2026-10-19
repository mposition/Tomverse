import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_V19_AUTH_MIN_REMAINING_MS, AMUX_V19_CODEX_MAX_REFRESH_AGE_MS,
  amuxV19OutputRevealsSecret, inspectAmuxV19ChannelAuth } from
  "../lib/amux/ideaV19CliChannelHost.mjs";

// Synthetic credentials only: unsigned JWT-shaped strings and fake tokens.
const now = Date.parse("2026-10-20T00:00:00.000Z");
const jwt = (expMs, tag = "a") => [
  Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), sub: "synthetic" }))
    .toString("base64url"),
  `${tag}`.repeat(43).slice(0, 43) + "SyntheticSignatureSegment0123456789abcdef"];
const token = (expMs, tag) => jwt(expMs, tag).join(".");
const bytes = (value) => Buffer.from(typeof value === "string" ? value
  : JSON.stringify(value), "utf8");

const codex = (change = {}) => ({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { id_token: token(now + 3_600_000, "i"),
    access_token: token(now + 3 * 86_400_000, "x"),
    refresh_token: "synthetic-refresh-secret-never-copied",
    account_id: "00000000-0000-4000-8000-000000000000" },
  last_refresh: new Date(now - 86_400_000).toISOString(), ...change });

test("the Codex sandbox copy keeps the access token and drops the refresh secret", () => {
  const source = codex();
  const { copy, secrets } = inspectAmuxV19ChannelAuth("openai", bytes(source), now);
  const parsed = JSON.parse(copy.toString("utf8"));
  assert.equal(parsed.tokens.refresh_token, "");
  assert.equal(parsed.tokens.access_token, source.tokens.access_token);
  assert.equal(parsed.OPENAI_API_KEY, null);
  assert.equal(copy.includes("synthetic-refresh-secret-never-copied"), false);
  assert.deepEqual(secrets, [source.tokens.access_token, source.tokens.id_token]);
});

test("a Codex sign-in that would bill an API key or need a refresh is refused", () => {
  for (const change of [
    { auth_mode: "apikey" },
    { OPENAI_API_KEY: "sk-synthetic" },
    { tokens: { ...codex().tokens, access_token: token(now +
      AMUX_V19_AUTH_MIN_REMAINING_MS - 1000) } },
    { tokens: { ...codex().tokens, access_token: "opaque" } },
    { tokens: { ...codex().tokens, account_id: "bad id" } },
    { last_refresh: new Date(now - AMUX_V19_CODEX_MAX_REFRESH_AGE_MS - 1).toISOString() },
    { last_refresh: new Date(now + 3_600_000).toISOString() },
    { last_refresh: "yesterday" },
  ]) {
    assert.throws(() => inspectAmuxV19ChannelAuth("openai", bytes(codex(change)), now),
      Error, JSON.stringify(Object.keys(change)));
  }
});

const copilotConfig = (change = {}) => [
  "// Copilot CLI configuration (synthetic)",
  "// The CLI writes these comment lines itself",
  JSON.stringify({ authTokens: {
    "https://github.com:someone": { token: "gho_" + "A".repeat(36) },
    "https://github.com:org:someone": { token: "gho_" + "B".repeat(36) },
  }, lastLoggedInUser: { host: "https://github.com", login: "someone" },
  trustedFolders: [], ...change }),
].join("\n");

test("the Copilot copy is only the signed-in user's own token", () => {
  const { copy, secrets } = inspectAmuxV19ChannelAuth("github-copilot",
    bytes(copilotConfig()), now);
  assert.equal(copy.toString("utf8"), "gho_" + "A".repeat(36));
  assert.deepEqual(secrets, ["gho_" + "A".repeat(36)]);
  for (const change of [
    { lastLoggedInUser: { host: "https://ghe.example", login: "someone" } },
    { lastLoggedInUser: { host: "https://github.com", login: "nobody" } },
    { lastLoggedInUser: null },
    { authTokens: { "https://github.com:someone": { token: "ghp_" + "C".repeat(36) } } },
  ]) {
    assert.throws(() => inspectAmuxV19ChannelAuth("github-copilot",
      bytes(copilotConfig(change)), now), Error);
  }
});

test("the Cursor copy needs a session token that outlives the run", () => {
  const session = token(now + 30 * 86_400_000, "s");
  const { copy, secrets } = inspectAmuxV19ChannelAuth("cursor",
    bytes({ accessToken: session, refreshToken: session }), now);
  assert.deepEqual(JSON.parse(copy.toString("utf8")),
    { accessToken: session, refreshToken: session });
  assert.deepEqual(secrets, [session]);
  for (const value of [{ accessToken: session },
    { accessToken: token(now + 60_000), refreshToken: session },
    { accessToken: "opaque", refreshToken: session }, []]) {
    assert.throws(() => inspectAmuxV19ChannelAuth("cursor", bytes(value), now), Error);
  }
  assert.throws(() => inspectAmuxV19ChannelAuth("anthropic", bytes("{}"), now), TypeError);
});

test("an answer that repeats any part of a staged credential is caught", () => {
  const session = token(now + 30 * 86_400_000, "s");
  const signature = session.split(".")[2];
  const gho = "gho_" + "Z".repeat(36);
  assert.equal(amuxV19OutputRevealsSecret("{\"units\":[]}", [session, gho]), false);
  assert.equal(amuxV19OutputRevealsSecret(`leak ${session}`, [session]), true);
  assert.equal(amuxV19OutputRevealsSecret(`part ${signature.slice(5, 30)} end`, [session]), true);
  assert.equal(amuxV19OutputRevealsSecret(`part ${gho.slice(10, 36)}`, [gho]), true);
  // A JWT header is shared by every JWT and is not a secret.
  assert.equal(amuxV19OutputRevealsSecret(session.split(".")[0], [session]), false);
  assert.equal(amuxV19OutputRevealsSecret("short", ["tiny"]), false);
  assert.equal(amuxV19OutputRevealsSecret(null, [gho]), true);
});
