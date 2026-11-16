import { createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { amuxV19SessionPromptForClaim } from
  "./ideaSessionAnalysisPromptCore.ts";
import { runAmuxV19MaxClaimedTrackedCheckoutOnce } from
  "./ideaLocalMaxClaimedTrackedCheckoutOnce.mjs";
import { readAmuxV19MaxClaimedIdeaOnce } from "./ideaLocalMaxIdeaRead.mjs";
import { runAmuxV19MaxSessionQueueClaimOnce } from
  "./ideaLocalMaxSessionQueueClaimOnce.mjs";
import { settleAmuxV19MaxShadowResultOnce } from
  "./ideaLocalMaxShadowResultOnce.mjs";
import { finalizeAmuxV19MaxSessionResultWithReceipts } from
  "./ideaLocalMaxTrackedCheckoutReceipts.mjs";
import { localAmuxSessionClaimMarker } from "./ideaLocalSessionClaimMarker.mjs";

export const AMUX_V19_MAX_SESSION_CYCLE_ENV =
  "TOMVERSE_AMUX_V19_MAX_SESSION_CYCLE";
/** Excluded-path digests are keyed by the launcher secret per claim, so the
 * operator can recompute one without another runner secret. */
export const AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID =
  "amux-v19-launcher-claim-hmac-v1";
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
/** The only text a cycle reason may carry: a lowercase code. IDs, prices,
 * paths and model names all contain a digit, a hyphen, a dot or a slash. */
export const AMUX_V19_SESSION_CYCLE_WORD = /^[a-z_]{1,40}$/;

const word = (value) => typeof value === "string" &&
  AMUX_V19_SESSION_CYCLE_WORD.test(value) ? value : null;
const bounded = (value, min, max) => Number.isSafeInteger(value) &&
  value >= min && value <= max ? value : null;

/** Why one analysis did not verify, from the diagnostic observation, as
 * lowercase codes and bounded counts only. `reason` is the step's own fixed
 * reason (a stop, a dropped link, a host failure), else the observation's
 * kind. The parser's reported usage model names, stderr text and model
 * output are never copied. */
export function amuxV19SessionAnalysisFailure(observed) {
  const parser = observed?.parserReason;
  const cliError = observed?.cliError;
  return Object.freeze({
    reason: word(observed?.reason) ?? word(observed?.kind) ?? "unavailable",
    cliStarted: typeof observed?.cliStarted === "boolean"
      ? observed.cliStarted : null,
    beforeCli: observed?.beforeCli === true,
    failure: word(observed?.failureStage),
    parser: word(parser?.code),
    trace: word(parser?.traceReason),
    stderr: word(observed?.stderrClass),
    cliError: word(cliError?.assistantError),
    terminal: word(cliError?.terminalReason),
    apiStatus: bounded(cliError?.apiErrorStatus, 100, 599),
    exit: bounded(observed?.childExitCode, 0, 255),
    approved: bounded(observed?.approvedConnects, 0, 1_000_000),
    denied: bounded(observed?.deniedConnects, 0, 1_000_000),
  });
}

/** Default off. When `enabled`, a failed analysis writes the names behind its
 * parser or trace refusal (an unknown event subtype, key names, a checkout-
 * relative path outside the manifest, open flags) to one 0600 file in the
 * runner's state directory. That file is the only place the detail goes: the
 * status line gets `detail=written|unwritten`, and the unknown report, the
 * receipts and the result are built field by field from the claim identity,
 * so none of them can carry it. It never holds event bodies, model output,
 * prompts, tokens or credentials. Every entry and every file is kept
 * (operator, 2026-11-16: no count caps); the operator prunes the directory. */
export const AMUX_V19_DIAGNOSTIC_DETAIL_ENV =
  "TOMVERSE_AMUX_V19_DIAGNOSTIC_DETAIL";
const DETAIL_NAME = /^[A-Za-z0-9_.:<>-]{1,66}$/;
const DETAIL_PATH = /^[\x20-\x7e]{1,200}$/;
const DETAIL_FLAG = /^O_[A-Z0-9_]{1,24}$/;
const detailString = (value, pattern) => typeof value === "string" &&
  pattern.test(value) ? value : null;
const detailList = (values, pattern) => Array.isArray(values)
  ? values.filter((value) => detailString(value, pattern)) : null;

/** Rebuilt from allowlisted fields, so a stray field never reaches the file. */
function cleanDetailEntry(entry) {
  const code = detailString(entry?.code, AMUX_V19_SESSION_CYCLE_WORD);
  if (!code) return null;
  const clean = { code };
  for (const key of ["subtype", "name"]) {
    const value = detailString(entry[key], DETAIL_NAME);
    if (value) clean[key] = value;
  }
  const path = detailString(entry.path, DETAIL_PATH);
  if (path) clean.path = path;
  for (const [key, pattern] of [["keys", DETAIL_NAME], ["names", DETAIL_NAME],
    ["flags", DETAIL_FLAG]]) {
    const list = detailList(entry[key], pattern);
    if (list) clean[key] = list;
  }
  return clean;
}

const cleanDetailEntries = (values) => (Array.isArray(values) ? values : [])
  .map(cleanDetailEntry).filter(Boolean);

/** Writes one `diagnostic-<UTC>.json`. Returns null when there is nothing to
 * write, else "written" or "unwritten"; it never throws, so a failed write
 * cannot change the cycle's outcome. */
export async function writeAmuxV19DiagnosticDetail(stateDirectory, analysis,
  detail, now = new Date()) {
  const events = cleanDetailEntries(detail?.events);
  const trace = cleanDetailEntries(detail?.trace);
  if (events.length === 0 && trace.length === 0) return null;
  try {
    if (typeof stateDirectory !== "string" || !isAbsolute(stateDirectory)) {
      return "unwritten";
    }
    const info = await lstat(stateDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (typeof process.getuid === "function" &&
          (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
      return "unwritten";
    }
    const stamp = now.toISOString().replace(/[-:]/g, "");
    const handle = await open(join(stateDirectory, `diagnostic-${stamp}.json`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1,
        recordedAt: now.toISOString(), stage: "analysis",
        analysis: analysis ?? null, events, trace }, null, 2)}\n`);
    } finally { await handle.close(); }
    return "written";
  } catch { return "unwritten"; }
}

const defaultSteps = Object.freeze({
  claim: runAmuxV19MaxSessionQueueClaimOnce,
  readIdea: readAmuxV19MaxClaimedIdeaOnce,
  analyse: runAmuxV19MaxClaimedTrackedCheckoutOnce,
  finalize: finalizeAmuxV19MaxSessionResultWithReceipts,
  reportUnknown: settleAmuxV19MaxShadowResultOnce,
  marker: localAmuxSessionClaimMarker,
});

/** One timer tick of the subscription (v19) session analysis (amux-intake
 * v19 item 4): discover, claim, read the page prompt, analyse, receipts,
 * result. A later page of the same idea is simply the next claim the queue
 * offers, and so is a page asked again after a failure.
 *
 * Nothing here waits for a person (operator, 2026-11-16). Every step after
 * the claim either records the result or ends the attempt by reporting the
 * claim's outcome unknown through the existing unknown route, whose lost
 * answer is only read back, never resent. The app closes an unknown
 * subscription claim at zero and queues the idea again after a wait; a result
 * that still lands afterwards is taken. Once the app confirms the claim is
 * closed (or was settled first), the local marker is removed and the next
 * tick goes on. Only an unconfirmed report keeps the marker, and the next
 * tick reconciles the claim it names before claiming anything else.
 *
 * Network resilience lives in the steps (ideaLocalAppRequest.mjs): a request
 * that never left is sent again, a read is asked again, a lost write answer
 * is read back, and only the app's explicit stop answer stops an attempt.
 * Every stop names why in one fixed word (`reason`, and `reportReason` for an
 * unconfirmed unknown report). */
export async function runAmuxV19MaxSessionCycleOnce(input,
  steps = defaultSteps) {
  if (process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV] !== "enabled") {
    return { kind: "disabled" };
  }
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!SECRET.test(secret ?? "")) return { kind: "refused" };
  const { origin, fetchImpl, stateDirectory } = input ?? {};
  const detailOn = process.env[AMUX_V19_DIAGNOSTIC_DETAIL_ENV] === "enabled";

  /** Reports one claim's outcome unknown and removes the marker once the app
   * confirms the claim is closed. The report is built from the claim identity
   * alone. */
  const reconcile = async (claim) => {
    let unknownReport = "unconfirmed";
    let receipt = null;
    let reportReason = null;
    try {
      const reported = await steps.reportUnknown({ origin, fetchImpl,
        input: { claimId: claim.claimId, requestId: claim.requestId,
          reservationId: claim.reservationId, ideaId: claim.ideaId,
          invocationOrdinal: claim.invocationOrdinal,
          outcome: "outcome_unknown", inputTokens: null, outputTokens: null } });
      if (reported?.kind === "recorded") {
        unknownReport = reported.recovered === true ? "read_back" : "recorded";
      } else if (reported?.kind === "refused") unknownReport = "refused";
      receipt = word(reported?.receiptStatus);
      if (unknownReport === "unconfirmed") {
        reportReason = word(reported?.reason) ?? "report_unconfirmed";
      }
    } catch {
      // The write may have landed: the next tick reads it back.
      reportReason = "report_threw";
    }
    let haltReleased = false;
    if (unknownReport === "recorded" || unknownReport === "read_back") {
      try {
        await steps.marker(stateDirectory).release();
        haltReleased = true;
      } catch { /* The next tick reconciles the claim again. */ }
    }
    return { unknownReport, haltReleased,
      ...(receipt ? { receipt } : {}),
      ...(reportReason ? { reportReason } : {}) };
  };

  let claimed;
  try { claimed = await steps.claim({ origin, fetchImpl, stateDirectory }); }
  catch { return { kind: "outcome_unknown", stage: "claim",
    reason: "claim_threw" }; }
  if (claimed?.kind === "recover") {
    // An earlier tick left its claim unreconciled. A marker naming no claim
    // (from before 2026-11-16) is only removed: the app closes an unknown
    // subscription claim itself.
    if (!claimed.identity) {
      try { await steps.marker(stateDirectory).release(); }
      catch { return { kind: "halt_unavailable", stage: "recover" }; }
      return { kind: "recovered", stage: "recover", reason: "unnamed_marker",
        haltReleased: true };
    }
    const reconciled = await reconcile(claimed.identity);
    return { kind: reconciled.haltReleased ? "recovered" : "outcome_unknown",
      stage: "recover", claimId: claimed.identity.claimId, ...reconciled };
  }
  if (claimed?.kind !== "claimed") {
    // A pre-write refusal (not_ready, integrity_unavailable, ...) left no
    // claim and no marker; its fixed reason word is the only detail carried.
    // Any other answer carries the step's network or readback reason.
    const reason = word(claimed?.reason);
    return { kind: claimed?.kind ?? "outcome_unknown", stage: "claim",
      ...(reason ? { reason } : {}) };
  }
  const { identity } = claimed;
  const stop = async (stage, reason) => ({ kind: "outcome_unknown", stage,
    claimId: identity.claimId, reason: word(reason) ?? `${stage}_unavailable`,
    ...await reconcile(identity) });
  // An analysis stop carries its reason inside `analysis`.
  const analysisStopped = async (observed) => {
    const analysis = amuxV19SessionAnalysisFailure(observed);
    // Local file only: the unknown report is built from the claim identity
    // alone and never sees `observed.diagnosticDetail`.
    const detail = detailOn && !analysis.beforeCli
      ? await writeAmuxV19DiagnosticDetail(stateDirectory, analysis,
        observed?.diagnosticDetail) : null;
    return { kind: "outcome_unknown", stage: "analysis",
      claimId: identity.claimId, analysis,
      ...(detail ? { detail } : {}), ...await reconcile(identity) };
  };
  let idea;
  try { idea = await steps.readIdea({ origin, selection: claimed, fetchImpl }); }
  catch { return stop("idea_read", "idea_read_threw"); }
  if (idea?.kind !== "ready") return stop("idea_read", idea?.reason);
  let promptHold = false;
  const prompt = (referenceCount) => {
    const text = amuxV19SessionPromptForClaim({ claimId: identity.claimId,
      pagePrompt: idea.prompt, referenceCount, provider: identity.provider });
    if (text === null) {
      promptHold = true;
      return null;
    }
    return Buffer.from(text, "utf8");
  };
  const digestSecret = createHmac("sha256", secret)
    .update(`amux-v19-excluded-path-digest\0${identity.claimId}`)
    .digest("hex");
  let observed;
  try {
    // Diagnostic mode only adds fixed failure codes to a failed observation
    // (and file-tool counts to a verified one, which the receipt step does
    // not copy); stderr is classified, never kept.
    observed = await steps.analyse({ origin, fetchImpl, identity,
      claim: claimed.claim, provider: identity.provider,
      modelId: identity.modelId,
      reasoningEffort: identity.reasoningEffort, prompt, digestSecret,
      diagnostic: true, ...(detailOn ? { diagnosticDetail: true } : {}) });
  } catch { return analysisStopped({ kind: "analysis_threw" }); }
  if (promptHold) return stop("prompt", "prompt_hold");
  if (observed?.kind !== "verified_success") return analysisStopped(observed);
  if (!Array.isArray(observed.preparedReferences)) {
    return analysisStopped({ ...observed, kind: "references_missing" });
  }
  let result;
  try {
    result = await steps.finalize({ origin, fetchImpl,
      identity: { claimId: identity.claimId, requestId: identity.requestId,
        reservationId: identity.reservationId, ideaId: identity.ideaId,
        invocationOrdinal: identity.invocationOrdinal },
      provider: identity.provider,
      references: observed.preparedReferences,
      excludedPathDigestKeyId: AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID,
    }, observed);
  } catch { return stop("result", "result_threw"); }
  // An unconfirmed result write: the unknown report below is confirmed by the
  // settled claim if the write landed first, and the write is still taken as
  // a late result if it lands after.
  if (result?.kind !== "recorded") return stop("result", result?.reason);
  // Failed tool calls the analysis recovered from, counts by tool only.
  const failedTools = observed.toolErrors ? { toolErrors: observed.toolErrors } : {};
  let haltReleased = true;
  try { await steps.marker(stateDirectory).release(); }
  catch { haltReleased = false; }
  return { kind: "recorded", claimId: identity.claimId, haltReleased,
    planState: result.planState ?? null,
    planReason: result.planReason ?? null,
    registrationState: result.registrationState ?? null, ...failedTools };
}
