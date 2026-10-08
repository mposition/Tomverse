import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { reviewerEnv } from "./env.mjs";

const UNKNOWN = { state: "unknown" };

/** Account entitlement percentage, never a conversion from session spend to AI Credits. */
export function copilotQuotaFromUsage(body, key = "premium_interactions") {
  const row = body?.quotaSnapshots?.[key];
  if (!row || typeof row !== "object") return UNKNOWN;
  if (row.isUnlimitedEntitlement === true && row.entitlementRequests === -1) {
    return { state: "available", remainingPercent: 100, unlimited: true };
  }
  if (!Number.isFinite(row.remainingPercentage) || row.remainingPercentage < 0 || row.remainingPercentage > 100 ||
      !Number.isFinite(row.entitlementRequests) || row.entitlementRequests <= 0 ||
      !Number.isFinite(row.usedRequests) || row.usedRequests < 0) return UNKNOWN;
  const exhausted = row.remainingPercentage === 0 || row.usedRequests >= row.entitlementRequests;
  return { state: exhausted ? "exhausted" : "available",
    remainingPercent: exhausted ? 0 : row.remainingPercentage };
}

/** Official SDK's headless stdio transport. Only connect/ping/account.getQuota are sent. */
export function copilotQuota(provider, { spawnChild = spawn, sourceEnv = process.env } = {}) {
  const env = reviewerEnv(provider, sourceEnv);
  const token = env.COPILOT_GITHUB_TOKEN;
  if (provider.passEnv?.includes("COPILOT_GITHUB_TOKEN") && !token) return Promise.resolve(UNKNOWN);
  return new Promise((resolve) => {
    const args = ["--headless", "--stdio", "--no-auto-update", "--no-auto-login",
      "--disable-builtin-mcps", "--no-custom-instructions", "--no-remote", "--no-remote-export"];
    if (token) args.push("--auth-token-env", "COPILOT_GITHUB_TOKEN", "--secret-env-vars", "COPILOT_GITHUB_TOKEN");
    const child = spawnChild(provider.command, args, {
      stdio: ["pipe", "pipe", "ignore"], env, cwd: env.HOME ?? homedir(),
      detached: process.platform !== "win32",
    });
    let settled = false;
    let resultToReturn = UNKNOWN;
    let cleanupTimer;
    let buffer = Buffer.alloc(0);
    let totalBytes = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resultToReturn = result;
      clearTimeout(timer);
      // Wait for the child to exit before allowing another probe to start.
      cleanupTimer = setTimeout(() => resolve(UNKNOWN), 1_000);
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already stopped */ }
    };
    const timer = setTimeout(() => finish(UNKNOWN), 12_000);
    const send = (message) => {
      const body = Buffer.from(JSON.stringify(message));
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    };
    const getQuota = () => send({ jsonrpc: "2.0", id: 3, method: "account.getQuota",
      params: token ? { gitHubToken: token } : {} });
    const onMessage = (message) => {
      if (message.id === 1) {
        if (message.error?.code === -32601) send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
        else if (message.error || !Number.isFinite(message.result?.protocolVersion)) finish(UNKNOWN);
        else getQuota();
      } else if (message.id === 2) {
        if (message.error || !Number.isFinite(message.result?.protocolVersion)) finish(UNKNOWN);
        else getQuota();
      } else if (message.id === 3) {
        finish(message.error ? UNKNOWN : copilotQuotaFromUsage(message.result, provider.quotaKey));
      } else if (message.method && message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported" } });
      }
    };
    child.on("error", () => finish(UNKNOWN));
    child.on("close", () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      resolve(resultToReturn);
    });
    child.stdin.on("error", () => finish(UNKNOWN));
    child.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 256_000) return finish(UNKNOWN);
      buffer = Buffer.concat([buffer, chunk]);
      while (!settled) {
        const at = buffer.indexOf("\r\n\r\n");
        if (at === -1) break;
        const match = /^Content-Length:\s*(\d+)\r?$/im.exec(buffer.subarray(0, at).toString("ascii"));
        const length = match ? Number(match[1]) : NaN;
        if (!Number.isInteger(length) || length < 1 || length > 128_000) return finish(UNKNOWN);
        if (buffer.length < at + 4 + length) break;
        const body = buffer.subarray(at + 4, at + 4 + length);
        buffer = buffer.subarray(at + 4 + length);
        try { onMessage(JSON.parse(body.toString("utf8"))); } catch { return finish(UNKNOWN); }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "connect", params: {} });
  });
}
