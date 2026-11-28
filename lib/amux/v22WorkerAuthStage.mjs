import { randomBytes } from "node:crypto";
import { mkdir, readFile as readFileDefault, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { inspectAmuxV19ChannelAuth } from "./ideaV19CliChannelHost.mjs";

/**
 * Sign-in copies for the fixed v22 worker sidecars on the AMUX box. A timer
 * copies the operator's own CLI logins into each worker's profile with the
 * refresh secret replaced, so a worker CLI can never rotate (and so break) the
 * operator's login; the operator's own CLI keeps refreshing it.
 *
 * Claude was missing (2026-11-06): the Claude workers' copies were made once
 * on 2026-10-12 and expired that night. The claim admits an Anthropic route
 * only with a fresh quota reading, and the sidecar reads quota only with an
 * unexpired access token, so no Claude worker could be assigned again.
 *
 * Cursor was missing too (2026-11-10): its sidecar reads the sign-in from
 * `<cli>/cursor/auth.json` (v22ChannelRun.mjs, v22ChannelQuota.mjs) and
 * nothing wrote it, so no Cursor worker could run a Task or report quota.
 *
 * Antigravity (owner decision 2026-11-10) is the one copy that keeps its
 * refresh token: Google's access token lasts an hour, and agy refreshes it in
 * the run home without touching the operator's login (measured on agy 1.5.4).
 *
 * Kimi Code CLI (owner request 2026-11-28) keeps only its access token: a
 * Kimi refresh rotates the refresh token (kimi_cli/auth/oauth.py persists the
 * rotated pair), so a worker refreshing with the operator's would sign the
 * operator's login out. With an empty refresh token the CLI uses the access
 * token until it expires and never refreshes.
 *
 * Qwen Code CLI (owner request 2026-11-28) signs in with the owner's Alibaba
 * Cloud Coding Plan key: Qwen OAuth's free tier ended on 2026-04-15, and
 * `/auth` stores the plan's key as `env.BAILIAN_CODING_PLAN_API_KEY` in
 * ~/.qwen/settings.json. The copy is that key alone, nothing else in the file.
 */

/* A Claude copy is staged whenever the operator's access token has not
 * expired. Until 2026-11-16 it also needed two hours left, but refusing never
 * gave a worker a later token: the copy kept the same or an older one, and the
 * stage unit and the worker's Admin health signal read failed for the last
 * two hours of every ~8 h token, until the login keepalive
 * (scripts/amux-v22-claude-login-keepalive.mjs) refreshed it 10 minutes
 * before expiry and restaged the copies itself. */
/** Non-secret stand-in for the refresh token; a refresh with it just fails. */
export const AMUX_V22_CLAUDE_REFRESH_PLACEHOLDER = "amux-v22-no-refresh";

export const AMUX_V22_AUTH_SOURCES = Object.freeze({
  anthropic: Object.freeze({ from: ".claude/.credentials.json", to: ".credentials.json" }),
  openai: Object.freeze({ from: ".codex/auth.json", to: "auth.json" }),
  "github-copilot": Object.freeze({ from: ".copilot/config.json", to: "auth-token" }),
  cursor: Object.freeze({ from: ".config/cursor/auth.json", to: "cursor/auth.json" }),
  antigravity: Object.freeze({ from: ".gemini/antigravity-cli/antigravity-oauth-token",
    to: "antigravity/antigravity-oauth-token" }),
  // Kimi's share directory is ~/.kimi; the Kimi Code login is
  // credentials/kimi-code.json (OAuth key "oauth/kimi-code").
  kimi: Object.freeze({ from: ".kimi/credentials/kimi-code.json", to: "kimi/kimi-code.json" }),
  qwen: Object.freeze({ from: ".qwen/settings.json", to: "qwen/coding-plan-key" }),
});

const WORKER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,8192}$/;
const refused = () => new TypeError("unsafe AMUX v22 worker sign-in");
const plainObject = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value);

/** The worker's copy of the operator's Claude subscription login. */
export function inspectAmuxV22ClaudeAuth(bytes, now) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(now)) throw refused();
  let auth;
  try { auth = JSON.parse(bytes.toString("utf8"))?.claudeAiOauth; }
  catch { throw refused(); }
  if (!plainObject(auth) || typeof auth.accessToken !== "string" ||
      !TOKEN.test(auth.accessToken) || typeof auth.refreshToken !== "string" ||
      !Number.isSafeInteger(auth.expiresAt) ||
      auth.expiresAt <= now ||
      !Array.isArray(auth.scopes) || auth.scopes.length > 32 ||
      !auth.scopes.every((scope) => typeof scope === "string" && scope.length <= 128)) {
    throw refused();
  }
  const copy = { claudeAiOauth: {
    accessToken: auth.accessToken,
    refreshToken: AMUX_V22_CLAUDE_REFRESH_PLACEHOLDER,
    expiresAt: auth.expiresAt,
    scopes: [...auth.scopes],
    ...(typeof auth.subscriptionType === "string" ?
      { subscriptionType: auth.subscriptionType } : {}),
    ...(typeof auth.rateLimitTier === "string" ? { rateLimitTier: auth.rateLimitTier } : {}),
  } };
  return { copy: Buffer.from(JSON.stringify(copy), "utf8"), expiresAt: auth.expiresAt };
}

const GOOGLE_TOKEN = /^[A-Za-z0-9._~+/=-]{16,4096}$/;
/**
 * Antigravity's sign-in copy: the access and refresh tokens, their type and
 * expiry and the sign-in method; the account e-mail is dropped. The refresh
 * token stays with the CLI in the run home, which the jailed shell does not
 * see (v22ShellJail.mjs). Throws on any other shape.
 */
export function inspectAmuxV22AntigravityAuth(bytes) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw refused(); }
  const token = plainObject(parsed) ? parsed.token : null;
  if (!plainObject(token) || typeof token.access_token !== "string" ||
      !GOOGLE_TOKEN.test(token.access_token) || typeof token.refresh_token !== "string" ||
      !GOOGLE_TOKEN.test(token.refresh_token) || token.token_type !== "Bearer" ||
      typeof token.expiry !== "string" || !Number.isFinite(Date.parse(token.expiry)) ||
      typeof parsed.auth_method !== "string" || !/^[a-z_]{1,32}$/.test(parsed.auth_method))
    throw refused();
  return { copy: Buffer.from(JSON.stringify({ token: { access_token: token.access_token,
    token_type: token.token_type, refresh_token: token.refresh_token, expiry: token.expiry },
    // agy refreshes the copy itself, so the hour-long access expiry says
    // nothing about how long the copy is good for.
    auth_method: parsed.auth_method }), "utf8"), expiresAt: null };
}

const KIMI_FIELD = /^[A-Za-z0-9 ._:/-]{0,256}$/;
// An access token said to outlive a year is not a Kimi Code login.
const KIMI_MAX_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;
/**
 * Kimi Code's sign-in copy (kimi_cli OAuthToken.to_dict): the access token,
 * its expiry (`expires_at`, seconds since the epoch) and lifetime, scope and
 * type, with the refresh token emptied. Refused once the access token has
 * expired. Throws on any other shape.
 */
export function inspectAmuxV22KimiAuth(bytes, now) {
  if (!Number.isSafeInteger(now)) throw refused();
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw refused(); }
  if (!plainObject(parsed) || typeof parsed.access_token !== "string" ||
      !TOKEN.test(parsed.access_token) || typeof parsed.refresh_token !== "string" ||
      typeof parsed.expires_at !== "number" || !Number.isFinite(parsed.expires_at) ||
      parsed.expires_at * 1000 <= now || parsed.expires_at * 1000 > now + KIMI_MAX_LIFETIME_MS ||
      (parsed.expires_in !== undefined && (typeof parsed.expires_in !== "number" ||
        !Number.isFinite(parsed.expires_in) || parsed.expires_in < 0)) ||
      typeof parsed.scope !== "string" || !KIMI_FIELD.test(parsed.scope) ||
      typeof parsed.token_type !== "string" || !KIMI_FIELD.test(parsed.token_type))
    throw refused();
  const expiresAt = Math.floor(parsed.expires_at * 1000);
  return { copy: Buffer.from(JSON.stringify({ access_token: parsed.access_token,
    refresh_token: "", expires_at: parsed.expires_at, scope: parsed.scope,
    token_type: parsed.token_type, expires_in: parsed.expires_in ?? 0 }), "utf8"), expiresAt };
}

/** A Coding Plan key: `sk-` and a token (the plan's keys are `sk-sp-…`). */
export const AMUX_V22_QWEN_CODING_PLAN_KEY = /^sk-[A-Za-z0-9_-]{16,256}$/;
const QWEN_SETTINGS_MAX_BYTES = 256 * 1024;
/** The Coding Plan key from the operator's Qwen settings, and nothing else.
 * A key has no expiry. Throws when the file holds none. */
export function inspectAmuxV22QwenAuth(bytes) {
  if (Buffer.byteLength(bytes) > QWEN_SETTINGS_MAX_BYTES) throw refused();
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw refused(); }
  const key = plainObject(parsed) && plainObject(parsed.env) ?
    parsed.env.BAILIAN_CODING_PLAN_API_KEY : null;
  if (typeof key !== "string" || !AMUX_V22_QWEN_CODING_PLAN_KEY.test(key)) throw refused();
  return { copy: Buffer.from(key, "utf8"), expiresAt: null };
}

function accessExpiry(provider, copy) {
  try {
    const parsed = JSON.parse(copy.toString("utf8"));
    const token = provider === "openai" ? parsed.tokens.access_token : parsed.accessToken;
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
    return Number.isSafeInteger(exp) ? exp * 1000 : null;
  } catch { return null; }
}

/** One provider's copy; `expiresAt` is null when the login carries none. */
export function inspectAmuxV22WorkerAuth(provider, bytes, now) {
  if (provider === "anthropic") return inspectAmuxV22ClaudeAuth(bytes, now);
  if (provider === "antigravity") return inspectAmuxV22AntigravityAuth(bytes);
  if (provider === "kimi") return inspectAmuxV22KimiAuth(bytes, now);
  if (provider === "qwen") return inspectAmuxV22QwenAuth(bytes);
  if (provider !== "openai" && provider !== "github-copilot" && provider !== "cursor")
    throw refused();
  // Cursor's copy keeps only the access token, with the v19 channel's fixed
  // non-secret refresh placeholder (measured 2026-11-10 on Cursor 2026.11.05:
  // `status` signs in with it from a read-only install).
  const { copy } = inspectAmuxV19ChannelAuth(provider, bytes, now);
  return { copy, expiresAt: provider === "github-copilot" ? null : accessExpiry(provider, copy) };
}

/**
 * Replace one worker's sign-in copy. A refused login leaves the current copy
 * as it is. With `check`, nothing is written.
 */
export async function stageAmuxV22WorkerAuth({ provider, worker, home,
  stateRoot = "/var/lib", now = Date.now(), check = false,
  readFile = readFileDefault }) {
  const source = Object.hasOwn(AMUX_V22_AUTH_SOURCES, provider) ?
    AMUX_V22_AUTH_SOURCES[provider] : null;
  if (!source || typeof worker !== "string" || !WORKER.test(worker) ||
      typeof home !== "string" || !isAbsolute(home)) throw refused();
  const bytes = await readFile(join(home, source.from));
  let inspected;
  try { inspected = inspectAmuxV22WorkerAuth(provider, bytes, now); }
  finally { bytes.fill(0); }
  try {
    if (!check) {
      const target = join(stateRoot, `tomverse-amux-v22-${worker}`, "cli", source.to);
      // Cursor's, Antigravity's, Kimi's and Qwen's copies sit one directory down. The cli directory itself
      // belongs to the sidecar unit and is never created here.
      if (dirname(source.to) !== ".") {
        await mkdir(dirname(target), { mode: 0o700 }).catch((error) => {
          if (error?.code !== "EEXIST") throw error;
        });
      }
      const temporary = join(dirname(target),
        `.${basename(target)}.${randomBytes(6).toString("hex")}`);
      // A failed write may leave part of the token behind; it never stays.
      try {
        await writeFile(temporary, inspected.copy, { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
      } catch (error) { await rm(temporary, { force: true }); throw error; }
    }
    return { provider, worker, expiresAt: inspected.expiresAt };
  } finally { inspected.copy.fill(0); }
}
