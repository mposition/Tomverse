// Where the Higgsfield image path reads its facts (owner 2026-11-12): the list
// an operator keeps in Admin › Marketing › Settings › Ad facts, fetched once a
// run from GET /api/internal/marketing-features under the job's own
// MARKETING_APP_URL + MARKETING_MEDIA_SUBMIT_SECRET, and features.json beside
// this file when the app cannot answer. The fetched copy is written to the
// day's folder and named by MARKETING_FEATURES_FILE, so loadFeatures, the
// concept prompt, the review folders and make-card.mjs (a child process with
// the same environment) all read the same bytes.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FEATURES_FILE_ENV = "MARKETING_FEATURES_FILE";

/** The file the run reads its facts from. */
export function featuresFile(toolDir, env = process.env) {
  const chosen = env[FEATURES_FILE_ENV];
  return chosen && existsSync(chosen) ? chosen : path.join(toolDir, "features.json");
}

/** A document the job can use: a non-empty list whose entries have an id and a `what`. */
export function usableFeatures(document) {
  const list = document?.features;
  return (
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((entry) => entry && typeof entry.id === "string" && typeof entry.what === "string")
  );
}

/**
 * Fetches the list into `out` and returns `{ source: "app", file }`, or
 * `{ source: "repo", file, reason }` with the repository's features.json when
 * the app is not configured, refuses, or answers something unusable.
 */
export async function syncFeatures({ toolDir, out, env = process.env, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const fallback = (reason) => ({ source: "repo", file: path.join(toolDir, "features.json"), reason });
  const appUrl = env.MARKETING_APP_URL;
  const secret = env.MARKETING_MEDIA_SUBMIT_SECRET;
  if (!appUrl || !secret) return fallback("not_configured");
  let response;
  try {
    response = await fetchImpl(new URL("/api/internal/marketing-features", appUrl), {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return fallback("unreachable");
  }
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || !usableFeatures(body?.result)) return fallback(`http_${response.status}${body?.code ? `_${body.code}` : ""}`);
  writeFileSync(out, `${JSON.stringify(body.result, null, 2)}\n`);
  return { source: "app", file: out };
}
