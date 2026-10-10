import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { release, tryAcquire, writeJsonAtomic } from "./fsutil.mjs";
import { reviewerEnv } from "./env.mjs";
import { cursorQuota } from "./cursor-quota.mjs";
import { copilotQuota } from "./copilot-quota.mjs";

const PROBE_TIMEOUT_MS = 12_000;
const CACHE_MS = 60_000;
const MANUAL_MAX_AGE_MS = 5 * 60_000;
const cache = new Map();

const unknown = { state: "unknown" };
const quotaFromUsed = (values) => {
  const usable = values.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
  if (usable.length === 0) return unknown;
  const remainingPercent = Math.max(0, 100 - Math.max(...usable));
  return { state: remainingPercent === 0 ? "exhausted" : "available", remainingPercent };
};

/** Match AMUX's primary Claude OAuth windows, falling back to classified limits[]. */
export function claudeQuotaFromUsage(body) {
  if (!body || typeof body !== "object") return unknown;
  const primary = ["five_hour", "seven_day", "seven_day_opus"]
    .map((key) => body[key]?.utilization)
    .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (primary.length > 0) return quotaFromUsed(primary);
  const limits = Array.isArray(body.limits) ? body.limits : [];
  return quotaFromUsed(limits
    .filter((row) => row && (row.kind === "session" || row.kind === "worker" ||
      row.kind?.startsWith("weekly") || row.group === "weekly"))
    .map((row) => row.percent));
}

/** Match AMUX's Codex rateLimitsByLimitId and legacy rateLimits windows. */
export function codexQuotaFromUsage(body) {
  if (!body || typeof body !== "object") return unknown;
  const byId = body.rateLimitsByLimitId;
  const buckets = byId && typeof byId === "object" && Object.keys(byId).length > 0
    ? Object.values(byId) : [body.rateLimits];
  return quotaFromUsed(buckets.flatMap((bucket) => [
    bucket?.primary?.usedPercent,
    bucket?.secondary?.usedPercent,
  ]));
}

export function manualQuotaFromSnapshot(row, now = Date.now()) {
  if (!row || typeof row !== "object" || !Number.isFinite(row.remaining) ||
      row.remaining < 0 || !["percent", "credits", "usd"].includes(row.unit) ||
      typeof row.observedAt !== "string") return unknown;
  const observed = Date.parse(row.observedAt);
  if (!Number.isFinite(observed) || observed > now || now - observed > MANUAL_MAX_AGE_MS) return unknown;
  if (row.consumedAt !== undefined) return { state: "unknown", reason: "manual_evidence_consumed" };
  return { state: row.remaining === 0 ? "exhausted" : "available",
    remaining: row.remaining, unit: row.unit };
}

/**
 * One read of the Claude subscription usage endpoint, with what a caller needs
 * to pace the next one: the HTTP status when there was an answer, and the
 * server's Retry-After in seconds when it sent one.
 */
export async function readClaudeUsage(provider, {
  fetchUsage = fetch,
  readCredentials = () => JSON.parse(readFileSync(join(process.env.HOME ?? homedir(), ".claude", ".credentials.json"), "utf8"))
    .claudeAiOauth,
  sourceEnv = process.env,
  now = Date.now(),
} = {}) {
  let credential = null;
  if (provider.passEnv?.includes("CLAUDE_CODE_OAUTH_TOKEN")) {
    credential = { accessToken: sourceEnv.CLAUDE_CODE_OAUTH_TOKEN };
  } else {
    try {
      credential = readCredentials();
    } catch {
      return { quota: unknown, status: null, retryAfterSeconds: null };
    }
  }
  if (!credential?.accessToken ||
      (Number.isFinite(credential.expiresAt) && credential.expiresAt <= now)) {
    return { quota: unknown, status: null, retryAfterSeconds: null };
  }
  try {
    const response = await fetchUsage("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const retryAfterSeconds = retryAfterSecondsFrom(response.headers?.get?.("retry-after"), now);
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => undefined);
      return { quota: unknown, status: response.status, retryAfterSeconds };
    }
    return { quota: claudeQuotaFromUsage(await response.json()), status: response.status, retryAfterSeconds };
  } catch {
    return { quota: unknown, status: null, retryAfterSeconds: null };
  }
}

/** The longest Retry-After honoured: a day. A larger value would park the probe until a restart. */
export const RETRY_AFTER_MAX_SECONDS = 24 * 60 * 60;

/** Retry-After as seconds: a delay in seconds or an HTTP date (RFC 9110); null when absent or past. */
export function retryAfterSecondsFrom(header, now = Date.now()) {
  if (typeof header !== "string" || header.trim() === "") return null;
  const value = header.trim();
  let seconds;
  if (/^\d+$/.test(value)) {
    seconds = Number(value);
  } else {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, RETRY_AFTER_MAX_SECONDS);
}

// The Claude usage endpoint rate-limits hard (HTTP 429), and AMUX reads the
// same subscription accounts. So a good reading is reused for five minutes;
// a 429 waits Retry-After or an exponential delay (2, 4, 8 ... up to 30
// minutes); and while waiting, the last good reading stands for up to 30
// minutes. Older than that it is unknown -- assignment needs evidence, not a
// memory. (AMUX's own probe does the same: provider/claude/usage_cache.rs.)
export const CLAUDE_REFRESH_MS = 5 * 60_000;
export const CLAUDE_LAST_KNOWN_MAX_MS = 30 * 60_000;
const CLAUDE_BACKOFF_BASE_MS = 2 * 60_000;
const CLAUDE_BACKOFF_MAX_MS = 30 * 60_000;
const claudePacing = new Map();

/**
 * The Claude quota for one provider, paced as above. `read` is
 * readClaudeUsage, injectable for tests; `pacing` holds each provider's
 * record, in memory for the daemon's lifetime.
 */
export async function pacedClaudeQuota(provider, { now = Date.now(), read = readClaudeUsage, pacing = claudePacing } = {}) {
  // Paced per credential, not per provider: two providers on the same login
  // share one account's rate limit, and must not each spend it.
  const key = provider.passEnv?.includes("CLAUDE_CODE_OAUTH_TOKEN") ? "claude:env-token" : "claude:credentials-file";
  const entry = pacing.get(key) ?? { retryAt: 0, rateLimited: 0, lastGood: null, inflight: null };
  pacing.set(key, entry);
  const lastKnown = () =>
    entry.lastGood && now - entry.lastGood.at <= CLAUDE_LAST_KNOWN_MAX_MS ? entry.lastGood.quota : unknown;
  // probeProviderQuotas asks for every provider at once: a read already on
  // its way answers every caller on the same credential, so one account is
  // read once and no answer overwrites another's pacing.
  if (entry.inflight) return entry.inflight;
  if (now < entry.retryAt) return lastKnown();
  entry.inflight = (async () => {
    const { quota, status, retryAfterSeconds } = await read(provider, { now });
    if (quota.state !== "unknown") {
      entry.lastGood = { quota, at: now };
      entry.rateLimited = 0;
      entry.retryAt = now + CLAUDE_REFRESH_MS;
      return quota;
    }
    // Only 429s climb the backoff; any other failure retries after a minute
    // and leaves the 429 count where it was.
    let delay = 60_000;
    if (status === 429) {
      entry.rateLimited += 1;
      delay = Math.min(CLAUDE_BACKOFF_BASE_MS * 2 ** Math.min(entry.rateLimited - 1, 10), CLAUDE_BACKOFF_MAX_MS);
    }
    entry.retryAt = now + Math.max(delay, (retryAfterSeconds ?? 0) * 1000);
    return lastKnown();
  })().finally(() => {
    entry.inflight = null;
  });
  return entry.inflight;
}

function codexQuota(provider) {
  return new Promise((resolve) => {
    const child = spawn(provider.command, ["app-server", "--stdio", "--disable", "remote_control"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: reviewerEnv(provider),
    });
    let settled = false;
    let output = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish(unknown), PROBE_TIMEOUT_MS);
    child.on("error", () => finish(unknown));
    child.on("close", () => finish(unknown));
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 128_000) return finish(unknown);
      let newline;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 2) return finish(codexQuotaFromUsage(message.result));
        } catch {
          // The app-server may emit non-JSON diagnostics before the response.
        }
      }
    });
    child.stdin.on("error", () => finish(unknown));
    // Codex stops on stdin EOF; keep the stream open until the asynchronous
    // account response arrives. finish() still terminates the read-only runtime.
    child.stdin.write([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { clientInfo: { name: "review-orchestrator-usage", version: "1" },
          capabilities: { experimentalApi: true } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null }),
      "",
    ].join("\n"));
  });
}

export async function probeProviderQuota(provider, stateDir, now = Date.now()) {
  if (provider.enabled !== true) return { state: "disabled" };
  if (provider.quotaProbe === "manual") {
    try {
      const snapshot = JSON.parse(readFileSync(join(stateDir, "quotas", `${provider.id}.json`), "utf8"));
      return manualQuotaFromSnapshot(snapshot, now);
    } catch {
      return unknown;
    }
  }
  // Claude paces itself (pacedClaudeQuota); the others share the one-minute cache.
  if (provider.quotaProbe === "claude") return pacedClaudeQuota(provider, { now });
  const probes = { codex: codexQuota, cursor: cursorQuota, copilot: copilotQuota };
  if (!Object.hasOwn(probes, provider.quotaProbe)) return unknown;
  const cached = cache.get(provider.id);
  if (cached && now - cached.at < CACHE_MS && now >= cached.at) return cached.result;
  let result;
  try { result = await probes[provider.quotaProbe](provider); } catch { result = unknown; }
  cache.set(provider.id, { at: now, result });
  return result;
}

export async function probeProviderQuotas(config, now = Date.now()) {
  const rows = await Promise.all(config.providers.map(async (provider) =>
    [provider.id, await probeProviderQuota(provider, config.stateDir, now)]));
  return Object.fromEntries(rows);
}

/** Status clients read daemon evidence; they never start extra provider probes. */
export function writeQuotaStatus(config, quotas, now = Date.now()) {
  writeJsonAtomic(join(config.stateDir, "quota-status.json"), { observedAt: now, quotas });
}

export function readQuotaStatus(config, now = Date.now()) {
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(join(config.stateDir, "quota-status.json"), "utf8"));
  } catch {
    snapshot = null;
  }
  const fresh = Number.isFinite(snapshot?.observedAt) && snapshot.observedAt <= now &&
    now - snapshot.observedAt <= 90_000;
  return Object.fromEntries(config.providers.map((provider) => {
    if (provider.quotaProbe === "manual") {
      try {
        const row = JSON.parse(readFileSync(quotaPath(config, provider.id), "utf8"));
        return [provider.id, manualQuotaFromSnapshot(row, now)];
      } catch {
        return [provider.id, unknown];
      }
    }
    return [provider.id, fresh ? snapshot.quotas?.[provider.id] ?? unknown : unknown];
  }));
}

/** Local operator input from the provider's own usage screen. Never exposed over SSH RPC. */
export function recordManualQuota(config, providerId, remaining, unit, now = Date.now()) {
  const provider = config.providers.find((row) => row.id === providerId);
  if (!provider || provider.quotaProbe !== "manual") throw new Error("manual_quota_provider_invalid");
  if (!Number.isFinite(remaining) || remaining < 0 || !["percent", "credits", "usd"].includes(unit) ||
      (unit === "percent" && remaining > 100)) {
    throw new Error("remaining_quota_invalid");
  }
  const row = { remaining, unit, observedAt: new Date(now).toISOString() };
  withQuotaLock(config, providerId, () => writeJsonAtomic(quotaPath(config, providerId), row));
  return row;
}

const quotaPath = (config, providerId) => join(config.stateDir, "quotas", `${providerId}.json`);
function withQuotaLock(config, providerId, fn) {
  const lock = join(config.stateDir, "quotas", `${providerId}.lock`);
  mkdirSync(join(config.stateDir, "quotas"), { recursive: true });
  const token = tryAcquire(lock);
  if (token === null) throw new Error("manual_quota_busy");
  try { return fn(); } finally { release(lock, token); }
}

/** A manual observation permits one new review; another assignment needs a fresh observation. */
export function consumeManualQuota(config, providerId, now = Date.now()) {
  try {
    return withQuotaLock(config, providerId, () => {
      const path = quotaPath(config, providerId);
      const row = JSON.parse(readFileSync(path, "utf8"));
      if (manualQuotaFromSnapshot(row, now).state !== "available") return false;
      writeJsonAtomic(path, { ...row, consumedAt: new Date(now).toISOString() });
      return true;
    });
  } catch {
    return false;
  }
}
