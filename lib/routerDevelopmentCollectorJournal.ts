/** Node-only local journal. File fsync is not a power-loss or malicious-admin guarantee. */
import * as fs from "node:fs";
import { resolve } from "node:path";
import { AVAILABLE_MODELS } from "./models";
import { canonicalBenchmarkJson, DEVELOPMENT_LIMITS, DEVELOPMENT_RESULTS_VERSION, isBenchmarkInstant, parseBenchmarkJson, strictBenchmarkObject, validateDevelopmentResults, type DevelopmentResults } from "./routerDevelopmentBenchmark";
import { COLLECTION_LIMITS, COLLECTION_VERSION, collectionFail, collectionHash, collectionId, estimateCollectionUsageCost, sumCollectionMoney, validateCollectionApproval, validateCollectionManifest, validateCollectionOutcome, type CollectionApproval, type CollectionManifest, type CollectionOutcome } from "./routerDevelopmentCollector";

export type CollectionRequest = { modelId: string; prompt: string; maxOutputTokens: number; settings: CollectionManifest["calls"][number]["settings"]; signal: AbortSignal };
export type CollectionAdapter = (request: CollectionRequest) => Promise<CollectionOutcome>;
export type CollectionIO = Pick<typeof fs, "openSync" | "closeSync" | "readSync" | "writeSync" | "fsyncSync" | "fstatSync" | "existsSync" | "mkdirSync" | "unlinkSync" | "lstatSync">;
export const collectorPaths = (commonDir: string, approvalId: string) => {
  const root = resolve(commonDir, "router-development-collector-v1.1");
  const id = collectionId(approvalId);
  return { root, registration: resolve(root, `${id}.registration.jsonl`), ledger: resolve(root, `${id}.jsonl`), lock: resolve(root, `${id}.lock`) };
};
export function readCollectionText(path: string, maximum: number, io: CollectionIO = fs): string {
  if (io.lstatSync(path).isSymbolicLink()) collectionFail("symlink");
  const fd = io.openSync(path, "r");
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) collectionFail("file_size_or_type");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = io.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size) collectionFail("file_changed_during_read");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally { io.closeSync(fd); }
}
/** Node fs.writeSync may write only part of the buffer; fsync must precede dispatch. */
export function writeCollectionDurably(path: string, text: string, flag: "wx" | "a", io: CollectionIO = fs): void {
  const fd = io.openSync(path, flag, 0o600);
  try {
    const data = Buffer.from(text);
    let offset = 0;
    while (offset < data.length) {
      const count = io.writeSync(fd, data, offset, data.length - offset, null);
      if (!Number.isSafeInteger(count) || count <= 0 || count > data.length - offset) collectionFail("short_write");
      offset += count;
    }
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
}
type Header = { kind: "header"; approvalDigest: string; manifestDigest: string; startedAt: string };
type Intent = { kind: "intent"; rowId: string; at: string; reservedMicroUsd: number };
type Terminal = { kind: "terminal"; rowId: string; at: string; outcome: CollectionOutcome; tokenUsageAtFrozenRatesMicroUsd: number | null };
type Event = Header | Intent | Terminal;
type Envelope = { seq: number; previousDigest: string | null; event: Event; entryDigest: string };
function observedTokenBoundExceeded(observation: CollectionOutcome["observation"], call: CollectionManifest["calls"][number]): boolean {
  const { contextInputBoundAssumption: inputBound, outputCapTokens: outputBound } = call.reserve;
  // Known disjoint partitions form only a lower bound. Never persist an inferred
  // total or replace a missing observation with zero. BigInt avoids sum overflow.
  const knownInputLowerBound = [observation.noCacheInputTokens, observation.cacheReadTokens, observation.cacheWriteTokens]
    .reduce((total, value) => value === null ? total : total + BigInt(value), BigInt(0));
  return (observation.inputTokens !== null && observation.inputTokens > inputBound)
    || knownInputLowerBound > BigInt(inputBound)
    || (observation.outputTokens !== null && observation.outputTokens > outputBound)
    || (observation.reasoningTokens !== null && observation.reasoningTokens > outputBound);
}
function terminalUsageEstimate(outcome: CollectionOutcome, call: CollectionManifest["calls"][number]): number | null {
  // A disproved token-bound assumption must preserve the response even if its
  // huge counters would overflow cost arithmetic. This is not an invoice claim.
  return observedTokenBoundExceeded(outcome.observation, call) ? null : estimateCollectionUsageCost(outcome.observation, call);
}
function jsonLines(text: string) {
  if (!text || !text.endsWith("\n")) collectionFail("journal_truncated");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => !line)) collectionFail("journal_blank_line");
  return lines.map((line) => parseBenchmarkJson(line, COLLECTION_LIMITS.eventBytes));
}
export function replayCollectionJournal(text: string, manifest: CollectionManifest, approval: CollectionApproval) {
  const entries: Envelope[] = [];
  const attempts = new Map<string, { intent: Intent; terminal: Terminal | null }>();
  let startedAt = "";
  for (const [seq, value] of jsonLines(text).entries()) {
    const obj = strictBenchmarkObject(value, ["seq", "previousDigest", "event", "entryDigest"], "journal_entry");
    const previousDigest = entries.at(-1)?.entryDigest ?? null;
    if (obj.seq !== seq || obj.previousDigest !== previousDigest || obj.entryDigest !== collectionHash({ seq, previousDigest, event: obj.event })) collectionFail("journal_chain");
    const kind = (obj.event as { kind?: string })?.kind;
    if (seq === 0) {
      const event = strictBenchmarkObject(obj.event, ["kind", "approvalDigest", "manifestDigest", "startedAt"], "journal_header");
      if (kind !== "header" || event.approvalDigest !== collectionHash(approval) || event.manifestDigest !== manifest.manifestDigest || !isBenchmarkInstant(event.startedAt)) collectionFail("journal_identity");
      startedAt = event.startedAt as string;
    } else {
      const event = strictBenchmarkObject(obj.event, kind === "intent" ? ["kind", "rowId", "at", "reservedMicroUsd"] : ["kind", "rowId", "at", "outcome", "tokenUsageAtFrozenRatesMicroUsd"], "journal_event");
      const call = manifest.calls.find((candidate) => candidate.rowId === event.rowId);
      if (!call || !isBenchmarkInstant(event.at) || Date.parse(event.at as string) < Date.parse(startedAt)) collectionFail("journal_row_or_time");
      if (kind === "intent") {
        if (attempts.has(call.rowId) || event.reservedMicroUsd !== call.reserve.reservedMicroUsd || call.reserve.reservedMicroUsd > manifest.limits.maxRequestMicroUsd || Date.parse(event.at as string) >= Math.min(Date.parse(approval.expiresAt), Date.parse(startedAt) + manifest.limits.runTimeoutMs)) collectionFail("duplicate_or_forged_intent");
        attempts.set(call.rowId, { intent: event as Intent, terminal: null });
      } else if (kind === "terminal") {
        const attempt = attempts.get(call.rowId);
        if (!attempt || attempt.terminal || Date.parse(event.at as string) < Date.parse(attempt.intent.at)) collectionFail("duplicate_or_orphan_terminal");
        const outcome = validateCollectionOutcome(event.outcome);
        if (event.tokenUsageAtFrozenRatesMicroUsd !== terminalUsageEstimate(outcome, call)) collectionFail("journal_cost_forged");
        attempt.terminal = event as Terminal;
      } else collectionFail("journal_kind");
    }
    entries.push(value as unknown as Envelope);
  }
  const totalReservedMicroUsd = sumCollectionMoney([...attempts.values()].map((attempt) => attempt.intent.reservedMicroUsd));
  if (totalReservedMicroUsd > manifest.limits.maxTotalMicroUsd || attempts.size > manifest.limits.maxCalls) collectionFail("journal_overbudget");
  const unknownRows = [...attempts].filter(([, attempt]) => !attempt.terminal).map(([rowId]) => rowId);
  const tokenBoundExceeded = [...attempts].some(([rowId, attempt]) => attempt.terminal && observedTokenBoundExceeded(attempt.terminal.outcome.observation, manifest.calls.find((call) => call.rowId === rowId)!));
  const overrun = [...attempts.values()].some((attempt) => attempt.terminal?.tokenUsageAtFrozenRatesMicroUsd !== null && (attempt.terminal?.tokenUsageAtFrozenRatesMicroUsd ?? 0) > attempt.intent.reservedMicroUsd);
  const unsupported = [...attempts.values()].some((attempt) => attempt.terminal && (["unknown", "measurement_unsupported"].includes(attempt.terminal.outcome.status) || attempt.terminal.outcome.observation.unsupportedBilling));
  const timeout = [...attempts.values()].some((attempt) => attempt.terminal?.outcome.status === "timeout");
  return { entries, attempts, startedAt, totalReservedMicroUsd, unknownRows, stopReason: tokenBoundExceeded ? "observed_token_bound_exceeded" : overrun ? "observed_reservation_overrun" : unknownRows.length ? "unknown_after_dispatch" : unsupported ? "measurement_or_execution_unknown" : timeout ? "request_timeout" : null };
}
type CollectionRunInput = { manifest: CollectionManifest; approval: CollectionApproval; commonDir: string; now?: () => number; io?: CollectionIO };
function withLock<T>(input: CollectionRunInput, fn: (io: CollectionIO, paths: ReturnType<typeof collectorPaths>) => Promise<T>): Promise<T> {
  const io = input.io ?? fs;
  const paths = collectorPaths(input.commonDir, input.approval.approvalId);
  io.mkdirSync(paths.root, { recursive: true });
  if (io.lstatSync(paths.root).isSymbolicLink()) collectionFail("symlink");
  let fd: number;
  try { fd = io.openSync(paths.lock, "wx", 0o600); } catch { collectionFail("lock_unavailable_no_stale_recovery"); }
  return fn(io, paths).finally(() => { io.closeSync(fd); io.unlinkSync(paths.lock); });
}
function readRegistered(input: CollectionRunInput, io: CollectionIO, paths: ReturnType<typeof collectorPaths>) {
  if (!io.existsSync(paths.registration) || !io.existsSync(paths.ledger)) collectionFail("registered_ledger_missing");
  const registration = jsonLines(readCollectionText(paths.registration, COLLECTION_LIMITS.eventBytes, io));
  const expected = { schemaVersion: COLLECTION_VERSION, approvalId: input.approval.approvalId, approvalDigest: collectionHash(input.approval), manifestDigest: input.manifest.manifestDigest };
  if (canonicalBenchmarkJson(registration[0]) !== canonicalBenchmarkJson(expected)) collectionFail("registration_identity");
  const replay = replayCollectionJournal(readCollectionText(paths.ledger, COLLECTION_LIMITS.journalBytes, io), input.manifest, input.approval);
  // A separate fsynced witness detects a ledger replaced by an older valid prefix.
  if (registration.length !== replay.entries.length + 1 || replay.entries.some((entry, index) => canonicalBenchmarkJson(registration[index + 1]) !== canonicalBenchmarkJson({ seq: index, entryDigest: entry.entryDigest }))) collectionFail("journal_witness_mismatch");
  return replay;
}
function appendEvent(event: Event, entries: Envelope[], io: CollectionIO, paths: ReturnType<typeof collectorPaths>) {
  const body = { seq: entries.length, previousDigest: entries.at(-1)?.entryDigest ?? null, event };
  const entry = { ...body, entryDigest: collectionHash(body) };
  const line = `${canonicalBenchmarkJson(entry)}\n`;
  if (Buffer.byteLength(line) > COLLECTION_LIMITS.eventBytes) collectionFail("event_byte_limit");
  if (io.existsSync(paths.ledger) && io.lstatSync(paths.ledger).size + Buffer.byteLength(line) > COLLECTION_LIMITS.journalBytes) collectionFail("journal_byte_limit");
  writeCollectionDurably(paths.ledger, line, entries.length ? "a" : "wx", io);
  writeCollectionDurably(paths.registration, `${canonicalBenchmarkJson({ seq: entry.seq, entryDigest: entry.entryDigest })}\n`, "a", io);
  entries.push(entry);
}
export async function collectDevelopment(input: CollectionRunInput & { adapter: CollectionAdapter; assertCurrent: () => void; onCheckpoint?: (point: "intent_durable" | "response_received" | "terminal_durable") => void }) {
  const now = input.now ?? Date.now;
  validateCollectionApproval(input.approval, input.manifest, now());
  validateCollectionManifest(input.manifest, { plan: input.manifest.plan, models: AVAILABLE_MODELS, collectorSource: input.manifest.collectorSource });
  if (input.manifest.plan.source.dirty || input.manifest.collectorSource.dirty) collectionFail("dirty_source_execution");
  return withLock(input, async (io, paths) => {
    input.assertCurrent();
    if (!io.existsSync(paths.registration)) {
      if (io.existsSync(paths.ledger)) collectionFail("unregistered_ledger");
      writeCollectionDurably(paths.registration, `${canonicalBenchmarkJson({ schemaVersion: COLLECTION_VERSION, approvalId: input.approval.approvalId, approvalDigest: collectionHash(input.approval), manifestDigest: input.manifest.manifestDigest })}\n`, "wx", io);
      appendEvent({ kind: "header", approvalDigest: collectionHash(input.approval), manifestDigest: input.manifest.manifestDigest, startedAt: new Date(now()).toISOString() }, [], io, paths);
    }
    let state = readRegistered(input, io, paths);
    let stopReason = state.stopReason;
    for (const call of input.manifest.calls) {
      if (stopReason) break;
      if (state.attempts.has(call.rowId)) continue;
      const remainingMs = Math.min(Date.parse(state.startedAt) + input.manifest.limits.runTimeoutMs, Date.parse(input.approval.expiresAt)) - now();
      if (remainingMs <= 0) { stopReason = "deadline_stopped"; break; }
      if (state.attempts.size >= input.manifest.limits.maxCalls || call.reserve.reservedMicroUsd > input.manifest.limits.maxRequestMicroUsd || state.totalReservedMicroUsd > input.manifest.limits.maxTotalMicroUsd - call.reserve.reservedMicroUsd) { stopReason = "budget_stopped"; break; }
      input.assertCurrent();
      validateCollectionApproval(input.approval, input.manifest, now());
      if (now() >= Date.parse(state.startedAt) + input.manifest.limits.runTimeoutMs) { stopReason = "deadline_stopped"; break; }
      const row = input.manifest.plan.rows.find((candidate) => candidate.rowId === call.rowId)!;
      appendEvent({ kind: "intent", rowId: row.rowId, at: new Date(now()).toISOString(), reservedMicroUsd: call.reserve.reservedMicroUsd }, state.entries, io, paths);
      input.onCheckpoint?.("intent_durable");
      input.assertCurrent();
      const dispatchRemainingMs = Math.min(Date.parse(state.startedAt) + input.manifest.limits.runTimeoutMs, Date.parse(input.approval.expiresAt)) - now();
      if (dispatchRemainingMs <= 0) { state = readRegistered(input, io, paths); stopReason = "deadline_before_dispatch"; break; }
      const signal = AbortSignal.timeout(Math.max(1, Math.min(input.manifest.limits.requestTimeoutMs, dispatchRemainingMs)));
      // Adapter errors propagate: the durable intent remains unknown and cannot retry.
      const outcome = validateCollectionOutcome(await input.adapter({ modelId: row.modelId, prompt: row.input.prompt, maxOutputTokens: row.callConfig.proposedMaxOutputTokens!, settings: call.settings, signal }));
      input.onCheckpoint?.("response_received");
      appendEvent({ kind: "terminal", rowId: row.rowId, at: new Date(now()).toISOString(), outcome, tokenUsageAtFrozenRatesMicroUsd: terminalUsageEstimate(outcome, call) }, state.entries, io, paths);
      input.onCheckpoint?.("terminal_durable");
      state = readRegistered(input, io, paths);
      stopReason = state.stopReason;
    }
    return collectionReport(input.manifest, state, stopReason);
  });
}
function collectionReport(manifest: CollectionManifest, state: ReturnType<typeof replayCollectionJournal>, stopReason: string | null) {
  return { schemaVersion: COLLECTION_VERSION, purpose: "development-only", manifestDigest: manifest.manifestDigest, stopReason,
    committedReservationMicroUsd: state.totalReservedMicroUsd, reservationPolicy: "never_released_not_actual_spend", actualInvoiceMicroUsd: null,
    dispatchIntents: state.attempts.size, terminalRecords: [...state.attempts.values()].filter((attempt) => attempt.terminal).length,
    unknownRows: state.unknownRows, rows: manifest.plan.rows.map((row) => ({ rowId: row.rowId,
      outcome: !row.benchmarkEligibility.eligible ? "refused" : state.attempts.get(row.rowId)?.terminal?.outcome.status ?? (state.attempts.has(row.rowId) ? "unknown_after_dispatch" : "not_run"),
      refusalReasons: row.benchmarkEligibility.reasons })) };
}
export async function exportDevelopmentCollection(input: CollectionRunInput): Promise<DevelopmentResults> {
  validateCollectionApproval(input.approval, input.manifest, (input.now ?? Date.now)(), true);
  return withLock(input, async (io, paths) => {
    const state = readRegistered(input, io, paths);
    if (state.stopReason && state.stopReason !== "request_timeout") collectionFail("export_uncertain_or_unsupported");
    const rows = [...state.attempts].map(([rowId, attempt]) => {
      const terminal = attempt.terminal!;
      const outcome = terminal.outcome;
      if (outcome.status === "returned" && !outcome.completeResponse || (outcome.answerBytes ?? 0) > DEVELOPMENT_LIMITS.answerBytes || outcome.textOmitted || !["returned", "failed", "timeout"].includes(outcome.status)) collectionFail("export_uncertain_or_unsupported");
      const row = input.manifest.plan.rows.find((candidate) => candidate.rowId === rowId)!;
      return { rowId, caseId: row.caseId, modelId: row.modelId, provider: row.provider, apiModel: row.apiModel, promptDigest: row.promptDigest, callConfigDigest: row.callConfigDigest,
        status: outcome.status === "returned" ? "succeeded" as const : outcome.status === "timeout" ? "timeout" as const : "failed" as const,
        answerText: outcome.answerText, answerDigest: outcome.answerDigest, failureCode: outcome.failureCode, recordedAt: terminal.at,
        providerResponseId: outcome.observation.providerResponseId, modelVersion: outcome.observation.providerReportedModel,
        metrics: { inputTokens: outcome.observation.inputTokens, outputTokens: outcome.observation.outputTokens, latencyMs: outcome.latencyMs, providerCostUsd: null } };
    });
    const results: DevelopmentResults = { schemaVersion: DEVELOPMENT_RESULTS_VERSION, purpose: "development-only", corpusDigest: input.manifest.plan.corpusDigest, planDigest: input.manifest.plan.planDigest,
      origin: { kind: "externally-saved", description: `Local operator collector ${COLLECTION_VERSION}; journal-bound self-reported evidence, not provider-authenticated or invoice evidence. Manifest ${input.manifest.manifestDigest}.` }, rows };
    if (Buffer.byteLength(JSON.stringify(results)) > DEVELOPMENT_LIMITS.documentBytes) collectionFail("export_document_limit");
    return validateDevelopmentResults(results, input.manifest.plan);
  });
}
