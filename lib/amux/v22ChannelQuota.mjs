import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute, join } from "node:path";

import { amuxV22ChannelEnv, createAmuxV22ChannelRunHome } from "./v22ChannelRun.mjs";
import { inspectAmuxV19ChannelAuth } from "./ideaV19CliChannelHost.mjs";

/**
 * Subscription quota of a non-Claude v22 sidecar's own sign-in (owner report
 * 2026-11-08: the Agent office showed only Claude's quota). Each probe is the
 * read the AMUX server's usage page and the review orchestrator already make
 * for the same account (vendor/amux .../api/usage.rs probe_codex_usage,
 * agent_quota.rs probe_copilot_usage and probe_cursor_usage;
 * tools/review-orchestrator/lib/{quota,copilot-quota,cursor-quota}.mjs):
 *
 * - Codex: `codex app-server` answers `account/rateLimits/read`.
 * - Copilot: the headless CLI answers `account.getQuota`.
 * - Cursor: the dashboard's GetCurrentPeriodUsage.
 *
 * None sends a prompt, starts a session or spends a request. The CLI probes
 * run in the same cut-down home a v22 run gets (createAmuxV22ChannelRunHome):
 * no refresh secret, so a probe can never rotate the operator's login, and
 * no user config, MCP server or hook. Anything unexpected is null -- the
 * sidecar then answers quota_unavailable -- never a made-up number.
 */

const PROBE_TIMEOUT_MS = 10_000;
const MAX_STREAM_BYTES = 256_000;
const MAX_BODY_BYTES = 128_000;
const MAX_AUTH_BYTES = 64 * 1024;
const NAME = /^[A-Za-z0-9._:-]{1,120}$/;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finiteAtLeastZero = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export const AMUX_V22_CHANNEL_QUOTA_PROVIDERS = Object.freeze(["openai", "github-copilot", "cursor"]);

/** The observation the bridge accepts: the most-used window decides, never
 * rounded up, and the earliest reset is when it can change. */
function channelObservation(provider, windows, observedAt) {
  if (windows.length === 0 || windows.length > 12) return null;
  const used = Math.max(...windows.map((window) => window.used));
  const remaining = Math.floor(Math.min(100, Math.max(0, 100 - used)) * 100);
  return { provider, remaining_basis_points: remaining,
    confidence_basis_points: 10_000, exhausted: remaining === 0,
    source: "provider_api", observed_at: observedAt,
    reset_at: new Date(Math.min(...windows.map((window) => window.reset))).toISOString() };
}

/**
 * Codex `account/rateLimits/read`. The account-wide bucket is `codex` in
 * rateLimitsByLimitId (older CLIs send only `rateLimits`); another bucket
 * limits one model (for example Spark) and does not bound this worker's.
 * A present window needs its usage and a future `resetsAt` (Unix seconds).
 */
export function normalizeAmuxV22CodexQuota(body, observedAt) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now) || !plain(body)) return null;
  const byId = plain(body.rateLimitsByLimitId) ? body.rateLimitsByLimitId : null;
  const bucket = byId && Object.hasOwn(byId, "codex") ? byId.codex : body.rateLimits;
  if (!plain(bucket)) return null;
  const windows = [];
  for (const key of ["primary", "secondary"]) {
    const row = bucket[key];
    if (row === null || row === undefined) continue;
    if (!plain(row) || !finiteAtLeastZero(row.usedPercent) ||
        !Number.isSafeInteger(row.resetsAt) || row.resetsAt * 1000 <= now) return null;
    windows.push({ used: row.usedPercent, reset: row.resetsAt * 1000 });
  }
  return channelObservation("openai", windows, observedAt);
}

/**
 * Copilot `account.getQuota`, the premium-request entitlement (the same key
 * the AMUX usage page reads). Unlimited is the explicit pair the CLI sends;
 * otherwise percentage, entitlement and used count must all be present. The
 * reset is the entitlement's own `resetDate`.
 */
export function normalizeAmuxV22CopilotQuota(result, observedAt) {
  const now = Date.parse(observedAt);
  const row = result?.quotaSnapshots?.premium_interactions;
  if (!Number.isFinite(now) || !plain(row) || typeof row.resetDate !== "string") return null;
  const reset = Date.parse(row.resetDate);
  if (!Number.isFinite(reset) || reset <= now) return null;
  if (row.isUnlimitedEntitlement === true && row.entitlementRequests === -1)
    return channelObservation("github-copilot", [{ used: 0, reset }], observedAt);
  if (!finiteAtLeastZero(row.remainingPercentage) || row.remainingPercentage > 100 ||
      !finiteAtLeastZero(row.entitlementRequests) || row.entitlementRequests === 0 ||
      !finiteAtLeastZero(row.usedRequests)) return null;
  const used = row.usedRequests >= row.entitlementRequests ? 100 : 100 - row.remainingPercentage;
  return channelObservation("github-copilot", [{ used, reset }], observedAt);
}

/**
 * Cursor GetCurrentPeriodUsage, the included plan only: the most-used of its
 * percentages, or the money left against the limit when it sends none. A
 * credit-grant balance spent after the plan is not counted, so an exhausted
 * plan reads as exhausted. The reset is the billing cycle's end (epoch ms,
 * an int64 the Connect JSON encoding may send as a string).
 */
export function normalizeAmuxV22CursorQuota(body, observedAt) {
  const now = Date.parse(observedAt);
  const plan = body?.planUsage;
  if (!Number.isFinite(now) || !plain(plan)) return null;
  const end = typeof body.billingCycleEnd === "string" && /^\d{1,15}$/.test(body.billingCycleEnd)
    ? Number(body.billingCycleEnd) : body.billingCycleEnd;
  if (!Number.isSafeInteger(end) || end <= now) return null;
  const keys = ["totalPercentUsed", "autoPercentUsed", "apiPercentUsed"];
  if (keys.some((key) => plan[key] !== undefined && !finiteAtLeastZero(plan[key])) ||
      (plan.remaining !== undefined && !Number.isFinite(plan.remaining))) return null;
  const percentages = keys.filter((key) => plan[key] !== undefined).map((key) => plan[key]);
  let used = percentages.length > 0 ? Math.max(...percentages) : null;
  if (used === null && Number.isFinite(plan.remaining)) {
    if (plan.remaining <= 0) used = 100;
    else if (Number.isFinite(plan.limit) && plan.limit > 0)
      used = Math.max(0, 100 * (1 - plan.remaining / plan.limit));
  }
  if (Number.isFinite(plan.remaining) && plan.remaining <= 0) used = 100;
  if (used === null) return null;
  return channelObservation("cursor", [{ used, reset: end }], observedAt);
}

const lineProtocol = {
  encode: (message) => `${JSON.stringify(message)}\n`,
  // The app-server may print non-JSON diagnostics; those lines are skipped.
  decode(buffer) {
    const messages = [];
    let rest = buffer;
    for (let at = rest.indexOf(10); at >= 0; at = rest.indexOf(10)) {
      const line = rest.subarray(0, at).toString("utf8");
      rest = rest.subarray(at + 1);
      try { messages.push(JSON.parse(line)); } catch { /* diagnostic */ }
    }
    return rest.length > MAX_BODY_BYTES ? null : { messages, rest };
  },
};

const frameProtocol = {
  encode(message) {
    const body = Buffer.from(JSON.stringify(message));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  },
  decode(buffer) {
    const messages = [];
    let rest = buffer;
    for (;;) {
      const at = rest.indexOf("\r\n\r\n");
      if (at === -1) return rest.length > 8_192 ? null : { messages, rest };
      const lengths = rest.subarray(0, at).toString("ascii").split("\r\n")
        .map((line) => /^Content-Length:\s*(\d+)\s*$/i.exec(line)).filter(Boolean);
      const length = lengths.length === 1 ? Number(lengths[0][1]) : NaN;
      if (!Number.isInteger(length) || length < 1 || length > MAX_BODY_BYTES) return null;
      if (rest.length < at + 4 + length) return { messages, rest };
      try { messages.push(JSON.parse(rest.subarray(at + 4, at + 4 + length).toString("utf8"))); }
      catch { return null; }
      rest = rest.subarray(at + 4 + length);
    }
  },
};

/** One bounded JSON-RPC exchange with a CLI started only for it. The whole
 * process group is killed when it answers, fails or runs out of time. */
function probeChild(spawnChild, binary, args, { env, cwd }, protocol, conversation) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnChild(binary, args, { stdio: ["pipe", "pipe", "ignore"], env, cwd,
        detached: true });
    } catch { resolve(null); return; }
    let settled = false;
    let total = 0;
    let buffer = Buffer.alloc(0);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL");
      } catch { try { child.kill("SIGKILL"); } catch { /* already stopped */ } }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    timer.unref?.();
    const send = (message) => {
      try { child.stdin.write(protocol.encode(message)); } catch { finish(null); }
    };
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (settled) return;
      if (total > MAX_STREAM_BYTES) { finish(null); return; }
      const decoded = protocol.decode(Buffer.concat([buffer, chunk]));
      if (!decoded) { finish(null); return; }
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (settled) return;
        if (plain(message)) conversation.onMessage(message, send, finish);
      }
    });
    conversation.start(send);
  });
}

const CODEX_ARGS = ["app-server", "--stdio", "--disable", "remote_control"];
const codexConversation = {
  // Codex stops on stdin EOF, so stdin stays open until the answer.
  start(send) {
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "tomverse-v22-quota", version: "1" },
        capabilities: { experimentalApi: true } } });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null });
  },
  onMessage(message, _send, finish) {
    if (message.id === 2) finish(message.error ? null : message.result ?? null);
  },
};

const COPILOT_ARGS = ["--headless", "--stdio", "--no-auto-update", "--disable-builtin-mcps",
  "--no-custom-instructions", "--no-remote", "--no-remote-export",
  // The token in the environment is the only login it may use.
  "--no-auto-login", "--auth-token-env", "COPILOT_GITHUB_TOKEN",
  "--secret-env-vars", "COPILOT_GITHUB_TOKEN"];
const copilotConversation = (token) => {
  const getQuota = (send) => send({ jsonrpc: "2.0", id: 3, method: "account.getQuota",
    params: { gitHubToken: token } });
  return {
    start: (send) => send({ jsonrpc: "2.0", id: 1, method: "connect", params: {} }),
    onMessage(message, send, finish) {
      if (message.id === 1 && message.error?.code === -32601)
        send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
      else if (message.id === 1 || message.id === 2) {
        if (message.error || !Number.isFinite(message.result?.protocolVersion)) finish(null);
        else getQuota(send);
      } else if (message.id === 3) finish(message.error ? null : message.result ?? null);
      else if (message.method !== undefined && message.id !== undefined)
        send({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "Method not supported" } });
    },
  };
};

const cursorUsageRequest = (token, requestFn = httpsRequest) => new Promise((resolve, reject) => {
  const req = requestFn({ hostname: "api2.cursor.sh", port: 443, method: "POST",
    rejectUnauthorized: true, path: "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "Connect-Protocol-Version": "1", "Content-Length": 2 } }, (response) => {
    if (response.statusCode !== 200) { response.resume(); reject(new Error("quota unavailable")); return; }
    const parts = [];
    let length = 0;
    response.on("data", (part) => {
      length += part.length;
      if (length > MAX_BODY_BYTES) req.destroy(new Error("quota response limit"));
      else parts.push(part);
    });
    response.on("error", reject);
    response.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
      catch { reject(new Error("quota unavailable")); }
    });
  });
  req.on("error", reject);
  req.end("{}");
});

/** The Cursor access token from the same cut-down copy a run gets (expiring
 * within six hours is refused, as for a run); its buffers are zeroed. */
async function cursorAccessToken(config, now, read) {
  const bytes = await read(join(config.claudeConfigDir, "cursor", "auth.json"));
  try {
    if (bytes.length > MAX_AUTH_BYTES) return null;
    const { copy } = inspectAmuxV19ChannelAuth("cursor", bytes, now);
    try {
      const token = JSON.parse(copy.toString("utf8")).accessToken;
      return typeof token === "string" && token.length >= 16 && token.length <= 8192 &&
        !/[\r\n]/.test(token) ? token : null;
    } finally { copy.fill(0); }
  } finally { bytes.fill(0); }
}

/**
 * The quota of this sidecar's own provider sign-in, or null. `options` lets
 * tests replace the clock, the run home, the CLI spawn and the HTTPS read.
 */
export async function probeAmuxV22ChannelQuota(provider, config, options = {}) {
  const clock = options.now ?? Date.now;
  let home = null;
  try {
    if (!AMUX_V22_CHANNEL_QUOTA_PROVIDERS.includes(provider) || !NAME.test(config?.worker) ||
        ![config.binaryPath, config.claudeConfigDir, config.homePath].every((path) =>
          typeof path === "string" && isAbsolute(path))) return null;
    if (provider === "cursor") {
      const token = await cursorAccessToken(config, clock(), options.readFile ?? readFile);
      if (!token) return null;
      const body = await (options.request ?? cursorUsageRequest)(token);
      return normalizeAmuxV22CursorQuota(body, new Date(clock()).toISOString());
    }
    home = await (options.createRunHome ?? createAmuxV22ChannelRunHome)(provider, config,
      { now: clock() });
    const env = amuxV22ChannelEnv(provider, home.config, { copilotToken: home.copilotToken });
    const spawnChild = options.spawn ?? spawn;
    const where = { env, cwd: home.config.homePath };
    if (provider === "openai") {
      const result = await probeChild(spawnChild, config.binaryPath, CODEX_ARGS, where,
        lineProtocol, codexConversation);
      return normalizeAmuxV22CodexQuota(result, new Date(clock()).toISOString());
    }
    if (!home.copilotToken) return null;
    const result = await probeChild(spawnChild, config.binaryPath, COPILOT_ARGS, where,
      frameProtocol, copilotConversation(home.copilotToken));
    return normalizeAmuxV22CopilotQuota(result, new Date(clock()).toISOString());
  } catch { return null; }
  finally { await home?.cleanup?.().catch(() => {}); }
}
