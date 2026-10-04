/** Content-free Railway trigger. It has no product DB or S3 credential and
 * sends one bounded request to the app. The app decides every purge. */
export const RETENTION_TRIGGER_ENV = "TOMVERSE_AMUX_V4_CONTENT_RETENTION_TRIGGER";
export const RETENTION_APP_ORIGIN_ENV = "TOMVERSE_AMUX_V4_CONTENT_RETENTION_APP_ORIGIN";
export const RETENTION_SECRET_ENV = "TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET";
const AGENT_ID = "amux-v4-intake-retention";
const ALLOWED_ORIGINS = new Set([
  "https://tomverse.app", "https://staging.tomverse.app",
]);
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const FORBIDDEN_ENV = /^(?:DATABASE_URL|DIRECT_DATABASE_URL|POSTGRES(?:QL)?_.*|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|AMUX_V4_KEY_STORE_.*|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN)$/;

export function planAmuxContentRetentionTrigger(env) {
  const forbidden = Object.keys(env).filter((key) =>
    FORBIDDEN_ENV.test(key) && !!env[key]);
  if (forbidden.length) return { kind: "config_error", reason: "forbidden_credential" };
  if (env[RETENTION_TRIGGER_ENV] !== "enabled") return { kind: "dark" };
  const origin = env[RETENTION_APP_ORIGIN_ENV];
  const secret = env[RETENTION_SECRET_ENV];
  if (!ALLOWED_ORIGINS.has(origin) || !SECRET.test(secret ?? "")) {
    return { kind: "config_error", reason: "invalid_destination_or_secret" };
  }
  return { kind: "ready", origin, secret };
}

/** One call only. A timeout or unparseable answer is unknown, never retried. */
export async function runAmuxContentRetentionTrigger(env, fetchImpl,
  timeoutMs = 20_000) {
  const plan = planAmuxContentRetentionTrigger(env);
  if (plan.kind !== "ready") return plan;
  let response;
  try {
    response = await fetchImpl(`${plan.origin}/api/internal/amux/v4/content-retention`, {
      method: "POST", redirect: "error", cache: "no-store",
      headers: { authorization: `Bearer ${plan.secret}`,
        "x-amux-agent-id": AGENT_ID, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return { kind: "outcome_unknown" }; }
  try {
    const body = await response.json();
    if (response.status === 409 && body?.reason === "content_retention_disabled") {
      return { kind: "disabled" };
    }
    if (!response.ok || !body || typeof body !== "object") {
      return { kind: "outcome_unknown" };
    }
    for (const name of ["holdNotices", "cancellation", "raw", "analysis"]) {
      if (!body[name] || !Number.isSafeInteger(body[name].scanned) ||
          body[name].scanned < 0) return { kind: "outcome_unknown" };
    }
    return { kind: "completed", scanned: {
      notices: body.holdNotices.scanned,
      cancellations: body.cancellation.scanned,
      raw: body.raw.scanned,
      analysis: body.analysis.scanned,
    } };
  } catch { return { kind: "outcome_unknown" }; }
}
