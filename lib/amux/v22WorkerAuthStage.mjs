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
 */

/** A copy is staged only with at least this long left, so a Task started on
 * it does not outlive its access token. The operator's token lasts ~8 h. */
export const AMUX_V22_CLAUDE_AUTH_MIN_REMAINING_MS = 2 * 60 * 60 * 1000;
/** Non-secret stand-in for the refresh token; a refresh with it just fails. */
export const AMUX_V22_CLAUDE_REFRESH_PLACEHOLDER = "amux-v22-no-refresh";

export const AMUX_V22_AUTH_SOURCES = Object.freeze({
  anthropic: Object.freeze({ from: ".claude/.credentials.json", to: ".credentials.json" }),
  openai: Object.freeze({ from: ".codex/auth.json", to: "auth.json" }),
  "github-copilot": Object.freeze({ from: ".copilot/config.json", to: "auth-token" }),
  cursor: Object.freeze({ from: ".config/cursor/auth.json", to: "cursor/auth.json" }),
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
      auth.expiresAt - now < AMUX_V22_CLAUDE_AUTH_MIN_REMAINING_MS ||
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
      // Cursor's copy sits one directory down. The cli directory itself
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
