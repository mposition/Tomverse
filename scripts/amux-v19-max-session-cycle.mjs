/** One v19 session analysis cycle on the fixed Ubuntu worker, run by its
 * timer (amux-intake v19 item 4). Default off: it does nothing unless
 * TOMVERSE_AMUX_V19_MAX_SESSION_CYCLE=enabled and the tracked-checkout CLI
 * switch are both set. An unknown outcome exits non-zero and keeps the local
 * halt marker, so the next tick stays halted until the operator resolves it. */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAmuxV19MaxSessionCycleOnce } from
  "../lib/amux/ideaLocalMaxSessionCycle.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

const QUIET = new Set(["recorded", "idle", "disabled",
  "catalog_unapproved", "more_unexamined", "discovered"]);
// `halted` means an earlier unknown outcome still waits for the operator.
const KINDS = new Set([...QUIET, "halted", "outcome_unknown", "refused",
  "unavailable", "price_unavailable", "cursor_rejected", "halt_unavailable",
  "auth_unavailable"]);
const STAGES = new Set(["claim", "idea_read", "prompt", "analysis", "result"]);
const STATES = /^[a-z_]{1,40}$/;

/** Fixed words only: never an ID, a price, a path or model text. */
export function amuxV19MaxSessionCycleStatus(result) {
  const kind = KINDS.has(result?.kind) ? result.kind : "unavailable";
  const parts = [`AMUX_V19_MAX_SESSION_CYCLE_${kind}`];
  if (STAGES.has(result?.stage)) parts.push(`stage=${result.stage}`);
  if (kind === "recorded") {
    for (const key of ["planState", "registrationState"]) {
      if (STATES.test(result?.[key] ?? "")) parts.push(`${key}=${result[key]}`);
    }
    if (result?.haltReleased === false) parts.push("haltReleased=false");
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
