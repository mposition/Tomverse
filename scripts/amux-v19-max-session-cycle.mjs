/** One v19 session analysis cycle on the fixed Ubuntu worker, run by its
 * timer (amux-intake v19 item 4). Default off: it does nothing unless
 * TOMVERSE_AMUX_V19_MAX_SESSION_CYCLE=enabled and the tracked-checkout CLI
 * switch are both set. An unknown outcome exits non-zero and keeps the local
 * halt marker, so the next tick stays halted until the operator resolves it.
 * A claim the app refused before writing, confirmed absent by its exact
 * readback, keeps no marker and prints its fixed reason word.
 * A failed analysis also names why, in fixed words, and whether its claim was
 * held as outcome_unknown in the app (`unknownReport`, with `reportReason`
 * when that stayed unconfirmed). Every other stop names its fixed reason too,
 * such as stop_requested, stop_unreachable, read_unreachable,
 * readback_unreachable or network_unsent_retry_exhausted.
 * With TOMVERSE_AMUX_V19_DIAGNOSTIC_DETAIL=enabled a failed analysis also
 * prints `detail=written` or `detail=unwritten`: the names themselves go to
 * a local 0600 file in the state directory, never to this line or the app. */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AMUX_V19_SESSION_CYCLE_WORD, runAmuxV19MaxSessionCycleOnce } from
  "../lib/amux/ideaLocalMaxSessionCycle.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

// A claim the app refused before writing (budget_hold, not_ready, the claim
// switch off) leaves no claim and no halt marker: the next tick asks again.
const QUIET = new Set(["recorded", "idle", "disabled",
  "catalog_unapproved", "more_unexamined", "discovered",
  "budget_hold", "not_ready", "claim_disabled"]);
// `halted` means an earlier unknown outcome still waits for the operator.
// budget_unavailable and integrity_unavailable are pre-write refusals too,
// but they exit non-zero so the operator looks at the ledger.
const KINDS = new Set([...QUIET, "halted", "outcome_unknown", "refused",
  "unavailable", "price_unavailable", "cursor_rejected", "halt_unavailable",
  "auth_unavailable", "budget_unavailable", "integrity_unavailable"]);
const REFUSALS = new Set(["budget_hold", "not_ready", "claim_disabled",
  "budget_unavailable", "integrity_unavailable"]);
// Kinds whose fixed reason word is printed: a refusal's code, or why a step
// stopped (a stop answer, a dropped link, an unconfirmed write).
const REASONED = new Set([...REFUSALS, "outcome_unknown", "unavailable"]);
const STAGES = new Set(["claim", "idea_read", "prompt", "analysis", "result"]);
const STATES = AMUX_V19_SESSION_CYCLE_WORD;
const ANALYSIS_WORDS = ["reason", "failure", "parser", "trace", "stderr",
  "cliError", "terminal"];
const ANALYSIS_COUNTS = [["apiStatus", 100, 599], ["exit", 0, 255],
  ["approved", 0, 1_000_000], ["denied", 0, 1_000_000]];

/** Re-checked here, at the only place a reason is printed. */
function analysisParts(analysis) {
  if (!analysis || typeof analysis !== "object") return [];
  const parts = [];
  const add = (key, value) => {
    if (typeof value === "string" && STATES.test(value)) {
      parts.push(`${key}=${value}`);
    }
  };
  add("reason", analysis.reason);
  for (const key of ["cliStarted", "beforeCli"]) {
    if (typeof analysis[key] === "boolean") parts.push(`${key}=${analysis[key]}`);
  }
  for (const key of ANALYSIS_WORDS.slice(1)) add(key, analysis[key]);
  for (const [key, min, max] of ANALYSIS_COUNTS) {
    const value = analysis[key];
    if (Number.isSafeInteger(value) && value >= min && value <= max) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts;
}

/** Fixed words only: never an ID, a price, a path or model text. */
export function amuxV19MaxSessionCycleStatus(result) {
  const kind = KINDS.has(result?.kind) ? result.kind : "unavailable";
  const parts = [`AMUX_V19_MAX_SESSION_CYCLE_${kind}`];
  if (STAGES.has(result?.stage)) parts.push(`stage=${result.stage}`);
  const analysis = kind === "outcome_unknown" && result?.stage === "analysis";
  // An analysis stop prints its reason among its own words below.
  if (!analysis && REASONED.has(kind) && STATES.test(result?.reason ?? "")) {
    parts.push(`reason=${result.reason}`);
  }
  if (kind === "recorded") {
    for (const key of ["planState", "planReason", "registrationState"]) {
      if (STATES.test(result?.[key] ?? "")) parts.push(`${key}=${result[key]}`);
    }
    if (result?.haltReleased === false) parts.push("haltReleased=false");
    // Counts of failed Read/Grep/Glob calls the analysis recovered from.
    for (const [tool, key] of [["Read", "readErrors"], ["Grep", "grepErrors"],
      ["Glob", "globErrors"]]) {
      const count = result?.toolErrors?.[tool];
      if (Number.isSafeInteger(count) && count > 0 && count <= 1_000_000) {
        parts.push(`${key}=${count}`);
      }
    }
  }
  if (analysis) {
    parts.push(...analysisParts(result.analysis));
    for (const key of ["unknownReport", "receipt", "reportReason", "detail"]) {
      const value = result?.[key];
      if (typeof value === "string" && STATES.test(value)) {
        parts.push(`${key}=${value}`);
      }
    }
  }
  return { line: `${parts.join(" ")}\n`,
    exitCode: QUIET.has(kind) && result?.haltReleased !== false ? 0 : 1 };
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== "linux") {
    process.stderr.write("AMUX_V19_MAX_SESSION_CYCLE_REFUSED\n");
    process.exitCode = 2;
  } else {
    let result = { kind: "unavailable" };
    try {
      result = await runAmuxV19MaxSessionCycleOnce({
        origin: process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV],
        fetchImpl: fetch,
        stateDirectory: join(homedir(),
          ".local/state/tomverse-amux-v19-max-analysis"),
      });
    } catch { /* Never emit IDs, prices, paths or response bodies. */ }
    const status = amuxV19MaxSessionCycleStatus(result);
    process.stdout.write(status.line);
    process.exitCode = status.exitCode;
  }
}
