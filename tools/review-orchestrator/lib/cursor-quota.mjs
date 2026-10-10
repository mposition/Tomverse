import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reviewerEnv } from "./env.mjs";

const UNKNOWN = { state: "unknown" };
const DASHBOARD = "https://api2.cursor.sh/aiserver.v1.DashboardService";
const USAGE_URL = `${DASHBOARD}/GetCurrentPeriodUsage`;
const CREDIT_URL = `${DASHBOARD}/GetCreditGrantsBalance`;

/**
 * The account's credit-grant balance in cents, or null when it cannot be told.
 * `creditBalanceCents` is an int64, which the Connect JSON encoding sends as a
 * decimal string. No grants at all is a zero balance, not an unknown one.
 */
export function cursorCreditCentsFromBalance(body) {
  if (!body || typeof body !== "object") return null;
  const value = body.creditBalanceCents;
  if (value === undefined || value === null) return body.hasCreditGrants === false ? 0 : null;
  const cents = typeof value === "number" ? value : typeof value === "string" && /^-?\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(cents)) return null;
  return Math.max(0, cents);
}

/**
 * Cursor CLI 2026.10.01 /usage schema. An exhausted included pool pauses this
 * provider only when the account has no credit left to spend after it
 * (`creditCents`, from GetCreditGrantsBalance): with credit, Cursor keeps
 * serving the CLI. A credit balance that could not be read leaves an exhausted
 * pool exhausted -- assigning on an unproven balance would fail the review.
 */
export function cursorQuotaFromUsage(body, creditCents = null) {
  const row = body?.planUsage;
  if (!row || typeof row !== "object") return UNKNOWN;
  if (["totalPercentUsed", "autoPercentUsed", "apiPercentUsed"].some((key) =>
    row[key] !== undefined && (!Number.isFinite(row[key]) || row[key] < 0)) ||
    (row.remaining !== undefined && !Number.isFinite(row.remaining))) return UNKNOWN;
  const percentages = [row.totalPercentUsed, row.autoPercentUsed, row.apiPercentUsed]
    .filter((value) => Number.isFinite(value) && value >= 0);
  const hasAmount = Number.isFinite(row.remaining);
  if (percentages.length === 0 && !hasAmount) return UNKNOWN;
  const planExhausted = (hasAmount && row.remaining <= 0) || percentages.some((value) => value >= 100);
  const hasCredit = Number.isFinite(creditCents) && creditCents > 0;
  const state = planExhausted && !hasCredit ? "exhausted" : "available";
  const credit = Number.isFinite(creditCents) ? { creditUsd: creditCents / 100 } : {};
  const used = percentages.length > 0 ? Math.max(...percentages) :
    Number.isFinite(row.limit) && row.limit > 0 ? 100 * (1 - row.remaining / row.limit) : null;
  if (used !== null) {
    return { state, remainingPercent: planExhausted ? 0 : Math.max(0, Math.min(100, 100 - used)), ...credit };
  }
  return { state, remaining: Math.max(0, row.remaining) / 100, unit: "usd", ...credit };
}

function authPath(env) {
  const home = env.HOME ?? homedir();
  if (process.platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "auth.json");
  if (process.platform === "darwin") return join(home, ".cursor", "auth.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "cursor", "auth.json");
}

/** One read-only dashboard call; null when it does not answer with JSON. */
async function dashboardRead(fetchUsage, url, token) {
  const response = await fetchUsage(url, {
    method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`,
      "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: "{}", signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;
  const text = await response.text();
  if (Buffer.byteLength(text) > 128_000) return null;
  return JSON.parse(text);
}

/**
 * Read the same account token as the CLI; no login, refresh, or model call.
 * Two read-only dashboard requests: the period's usage, then the credit
 * balance. A credit read that fails leaves the usage judgement as it was.
 */
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
  let usage;
  try {
    usage = await dashboardRead(fetchUsage, USAGE_URL, credential.accessToken);
  } catch {
    return UNKNOWN;
  }
  if (usage === null) return UNKNOWN;
  let creditCents = null;
  try {
    creditCents = cursorCreditCentsFromBalance(await dashboardRead(fetchUsage, CREDIT_URL, credential.accessToken));
  } catch {
    creditCents = null;
  }
  return cursorQuotaFromUsage(usage, creditCents);
}
