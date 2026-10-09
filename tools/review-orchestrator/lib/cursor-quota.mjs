import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reviewerEnv } from "./env.mjs";

const UNKNOWN = { state: "unknown" };
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

/** Cursor CLI 2026.10.01 /usage schema. Any exhausted included pool pauses this provider. */
export function cursorQuotaFromUsage(body) {
  const row = body?.planUsage;
  if (!row || typeof row !== "object") return UNKNOWN;
  if (["totalPercentUsed", "autoPercentUsed", "apiPercentUsed"].some((key) =>
    row[key] !== undefined && (!Number.isFinite(row[key]) || row[key] < 0)) ||
    (row.remaining !== undefined && !Number.isFinite(row.remaining))) return UNKNOWN;
  const percentages = [row.totalPercentUsed, row.autoPercentUsed, row.apiPercentUsed]
    .filter((value) => Number.isFinite(value) && value >= 0);
  const hasAmount = Number.isFinite(row.remaining);
  if (percentages.length === 0 && !hasAmount) return UNKNOWN;
  const exhausted = (hasAmount && row.remaining <= 0) || percentages.some((value) => value >= 100);
  const used = percentages.length > 0 ? Math.max(...percentages) :
    Number.isFinite(row.limit) && row.limit > 0 ? 100 * (1 - row.remaining / row.limit) : null;
  if (used !== null) {
    return { state: exhausted ? "exhausted" : "available",
      remainingPercent: exhausted ? 0 : Math.max(0, Math.min(100, 100 - used)) };
  }
  return { state: exhausted ? "exhausted" : "available",
    remaining: Math.max(0, row.remaining) / 100, unit: "usd" };
}

function authPath(env) {
  const home = env.HOME ?? homedir();
  if (process.platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "auth.json");
  if (process.platform === "darwin") return join(home, ".cursor", "auth.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "cursor", "auth.json");
}

/** Read the same account token as the CLI; no login, refresh, or model call. */
export async function cursorQuota(provider, {
  fetchUsage = fetch,
  readCredentials = (path) => JSON.parse(readFileSync(path, "utf8")),
  sourceEnv = process.env,
  now = Date.now(),
} = {}) {
  const env = reviewerEnv(provider, sourceEnv);
  if (env.CURSOR_API_BASE_URL && env.CURSOR_API_BASE_URL !== "https://api2.cursor.sh") return UNKNOWN;
  let credential;
  try { credential = readCredentials(authPath(env)); } catch { return UNKNOWN; }
  if (typeof credential?.accessToken !== "string" || !credential.accessToken) return UNKNOWN;
  // API-key CLI login can select another account. Never substitute an unrelated saved token.
  if (env.CURSOR_API_KEY && credential.apiKey !== env.CURSOR_API_KEY) return UNKNOWN;
  try {
    const payload = JSON.parse(Buffer.from(credential.accessToken.split(".")[1], "base64url").toString("utf8"));
    if (Number.isFinite(payload.exp) && payload.exp * 1000 <= now) return UNKNOWN;
  } catch {
    // The server validates opaque tokens and JWT signatures.
  }
  try {
    const response = await fetchUsage(USAGE_URL, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: "{}", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return UNKNOWN;
    const text = await response.text();
    if (Buffer.byteLength(text) > 128_000) return UNKNOWN;
    return cursorQuotaFromUsage(JSON.parse(text));
  } catch {
    return UNKNOWN;
  }
}
