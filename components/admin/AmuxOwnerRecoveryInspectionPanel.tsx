"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { AdminApiFailureNotice } from "./AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "./AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminIntlLocale, type AdminMessageShape } from "@/lib/adminLocale";
import { adminAmuxRecoveryInspectionMessages } from "@/lib/adminMessages/amuxRecoveryInspection";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { bindAmuxRecoveryInspection, type AmuxOwnerRecoveryInspection,
  type AmuxRecoveryInspectionIdentity } from "@/lib/amux/ownerRecoveryInspectionCore";
import type { AmuxV22RecoveryCost, AmuxV22RecoveryRead } from "@/lib/amux/v22TaskRecoveryCore";
import { clearAmuxAcceptedRiskResume, clearAmuxPendingRecovery,
  readAmuxAcceptedRiskResume, readAmuxPendingRecovery,
  saveAmuxAcceptedRiskResume, saveAmuxPendingRecovery,
  type AmuxPendingRecovery, type AmuxPendingRecoveryLoad, type RecoveryAction,
  type RecoveryReceiptBinding } from "@/lib/amux/ownerRecoveryPending";
export type AmuxHostRecoveryRead = AmuxV22RecoveryRead & { recoveryEnabled?: boolean;
  safeStopEnabled?: boolean; sourceEvidenceDigest?: string | null };

export const AMUX_RECOVERY_INSPECTION_TIMEOUT_MS = 10_000;
type Messages = AdminMessageShape<(typeof adminAmuxRecoveryInspectionMessages)["en"]>;
export type AmuxRecoveryInspectionState =
  | { state: "idle" | "loading" | "changed" }
  | { state: "unavailable"; failure: AdminApiFailure | null }
  | { state: "ready"; inspection: AmuxOwnerRecoveryInspection };
export type AmuxHostRecoveryState =
  | { state: "idle" | "loading" }
  | { state: "changed"; reason?: string | null }
  | { state: "unavailable"; failure: AdminApiFailure | null; requestId: string; unknownWrite: boolean;
      unknownAction?: RecoveryAction; expectedReceipt?: RecoveryReceiptBinding }
  | { state: "ready"; data: AmuxHostRecoveryRead };

const record = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) =>
  Object.keys(value).sort().join(",") === expected;
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const money = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" &&
  /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const version = (value: unknown): value is string => typeof value === "string" &&
  value.length >= 1 && value.length <= 160;
const recoveryCost = (value: unknown): value is AmuxV22RecoveryCost => {
  if (!record(value) || !keys(value,
    "additionalCapMicroUsd,catalogApprovalId,catalogVersion,costDigest,costReceiptDigest,oldHeldMicroUsd,pricingVersion,worstExposureMicroUsd")) return false;
  return money(value.oldHeldMicroUsd) && money(value.additionalCapMicroUsd) &&
    money(value.worstExposureMicroUsd) && BigInt(value.additionalCapMicroUsd) > BigInt(0) &&
    BigInt(value.oldHeldMicroUsd) + BigInt(value.additionalCapMicroUsd) === BigInt(value.worstExposureMicroUsd) &&
    digest(value.costReceiptDigest) && digest(value.costDigest) && version(value.catalogApprovalId) &&
    version(value.catalogVersion) && version(value.pricingVersion);
};
const sameRecoveryCost = (left: AmuxV22RecoveryCost, right: AmuxV22RecoveryCost) =>
  (["oldHeldMicroUsd", "additionalCapMicroUsd", "worstExposureMicroUsd", "catalogApprovalId",
    "catalogVersion", "pricingVersion", "costReceiptDigest", "costDigest"] as const)
    .every((key) => left[key] === right[key]);
const recoveryRiskAcceptance = (value: unknown): value is NonNullable<AmuxV22RecoveryRead["riskAcceptance"]> =>
  record(value) && keys(value,
    "acceptedAt,additionalCapMicroUsd,digest,executionStarted,id,oldHeldMicroUsd,ownerRequestId,reservationCreated,sourceEvidenceDigest,sourceEvidenceId,worstExposureMicroUsd") &&
  uuid(value.id) && digest(value.digest) && uuid(value.ownerRequestId) && uuid(value.sourceEvidenceId) &&
  digest(value.sourceEvidenceDigest) && typeof value.acceptedAt === "string" &&
  Number.isFinite(Date.parse(value.acceptedAt)) && money(value.oldHeldMicroUsd) &&
  money(value.additionalCapMicroUsd) && money(value.worstExposureMicroUsd) &&
  BigInt(value.oldHeldMicroUsd) + BigInt(value.additionalCapMicroUsd) === BigInt(value.worstExposureMicroUsd) &&
  value.oldHeldMicroUsd === "3400000" && value.additionalCapMicroUsd === "3400000" &&
  value.worstExposureMicroUsd === "6800000" &&
  value.executionStarted === false && value.reservationCreated === false;
const recoveryLaunchProof = (value: unknown): value is NonNullable<AmuxV22RecoveryRead["launchProof"]> =>
  record(value) && keys(value,
    "briefDigest,costReceiptDigest,digest,id,launchBindingId,launchScopeVersion,modelId,pricingVersion,provider,role,routeId,state,workerName") &&
  uuid(value.id) && digest(value.digest) && uuid(value.launchBindingId) &&
  ["current", "stale", "mismatch"].includes(String(value.state)) && id(value.workerName) &&
  id(value.provider) && typeof value.modelId === "string" && value.modelId.length >= 1 &&
  value.modelId.length <= 160 && id(value.routeId) && value.role === "investigate" &&
  digest(value.briefDigest) && version(value.pricingVersion) && digest(value.costReceiptDigest) &&
  value.launchScopeVersion === 1;
const recoveryApiModelAccess = (value: unknown): value is NonNullable<
  AmuxV22RecoveryRead["apiModelAccess"]> =>
  record(value) && keys(value,
    "balanceKnown,canonicalModelId,maximumCostMicroUsd,recordedAt,selectedModelId,state,worstExposureMicroUsd") &&
  ["required", "verified", "stale", "unavailable", "unknown", "catalog_mismatch"]
    .includes(String(value.state)) && typeof value.selectedModelId === "string" &&
  value.selectedModelId.length >= 1 && value.selectedModelId.length <= 160 &&
  (value.canonicalModelId === null || (typeof value.canonicalModelId === "string" &&
    value.canonicalModelId.length >= 1 && value.canonicalModelId.length <= 160)) &&
  value.balanceKnown === false && value.maximumCostMicroUsd === "3400000" &&
  value.worstExposureMicroUsd === "6800000" &&
  (value.recordedAt === null || (typeof value.recordedAt === "string" &&
    Number.isFinite(Date.parse(value.recordedAt))));
const recoveryEligibility = (value: unknown): value is AmuxV22RecoveryRead["eligibility"] =>
  record(value) && keys(value, "acceptUnknownPriorEffects,approveAttempt,reason,requestSafeStop") &&
  typeof value.acceptUnknownPriorEffects === "boolean" && typeof value.requestSafeStop === "boolean" &&
  typeof value.approveAttempt === "boolean" && (value.reason === null || ["exact_target_only",
    "risk_acceptance_required", "safe_stop_required", "safe_stop_stale", "launch_proof_required",
    "launch_proof_stale", "binding_changed", "api_model_access_required",
    "api_model_access_stale", "api_model_access_unverified",
    "canonical_catalog_approval_required", "already_approved"].includes(String(value.reason)));
const recoveryGuards = (value: unknown): value is AmuxV22RecoveryRead["guards"] =>
  record(value) && keys(value, "oldCost,priorEffects,readOnlyLaunch,taskAttemptLimit") &&
  value.priorEffects === "unknown" && value.oldCost === "held" &&
  value.readOnlyLaunch === "required" && value.taskAttemptLimit === 2;
const approvalReceipt = (value: RecoveryReceiptBinding | undefined): value is RecoveryReceiptBinding &
  { inspectionId: string | null; evidenceId: string | null; evidenceDigest: string | null; costDigest: string } =>
  Boolean(value && "costDigest" in value);
const riskApprovalReceipt = (value: RecoveryReceiptBinding | undefined): value is RecoveryReceiptBinding &
  { riskAcceptanceId: string; riskAcceptanceDigest: string; launchProofId: string;
    launchProofDigest: string; launchBindingId: string; workerName: string; provider: string;
    modelId: string; routeId: string; briefDigest: string; pricingVersion: string;
    costReceiptDigest: string } => Boolean(value && "costDigest" in value && "launchProofId" in value);
const safeStopReceipt = (value: RecoveryReceiptBinding | undefined): value is RecoveryReceiptBinding &
  { sourceEvidenceId: string; sourceEvidenceDigest: string } => Boolean(value && "sourceEvidenceId" in value);
const riskSafeStopReceipt = (value: RecoveryReceiptBinding | undefined): value is RecoveryReceiptBinding &
  { riskAcceptanceId: string; riskAcceptanceDigest: string } =>
  Boolean(value && "sourceEvidenceId" in value && "riskAcceptanceId" in value);
const unknownRiskSourceEligible = (value: AmuxV22RecoveryRead | undefined): value is AmuxV22RecoveryRead =>
  Boolean(value && value.state === "unverified" && uuid(value.evidenceId) && digest(value.evidenceDigest) &&
    (value.requestKind === "safe_stop" || value.reason === "legacy_invocation_unbound"));
const recoverySource = (value: AmuxV22RecoveryRead | undefined) => value?.riskAcceptance ? {
  id: value.riskAcceptance.sourceEvidenceId, digest: value.riskAcceptance.sourceEvidenceDigest,
} : value && uuid(value.evidenceId) && digest(value.evidenceDigest) ? {
  id: value.evidenceId, digest: value.evidenceDigest,
} : null;
const safeStopSourceEligible = (value: AmuxV22RecoveryRead | undefined): value is AmuxV22RecoveryRead =>
  Boolean(recoverySource(value) && (value?.riskAcceptance || unknownRiskSourceEligible(value)));
export function bindAmuxHostRecovery(value: unknown, identity: AmuxRecoveryInspectionIdentity,
  requestId: string): AmuxHostRecoveryRead | null {
  if (!record(value) || value.taskId !== identity.taskId || value.requestId !== requestId ||
      value.retryWrite !== false || (value.reason !== null &&
        (typeof value.reason !== "string" || !/^[A-Za-z0-9_]{1,128}$/.test(value.reason))) ||
      (value.recoveryEnabled !== undefined && typeof value.recoveryEnabled !== "boolean") ||
      (value.safeStopEnabled !== undefined && typeof value.safeStopEnabled !== "boolean") ||
      (value.requestKind !== undefined && !["inspect", "safe_stop"].includes(String(value.requestKind))) ||
      (value.sourceEvidenceId !== undefined && value.sourceEvidenceId !== null && !uuid(value.sourceEvidenceId)) ||
      (value.sourceEvidenceDigest !== undefined && value.sourceEvidenceDigest !== null && !digest(value.sourceEvidenceDigest)) ||
      (value.stopAcknowledgement !== undefined && value.stopAcknowledgement !== null &&
        !["acknowledged", "outcome_unknown", "not_issued"].includes(String(value.stopAcknowledgement))) ||
      (value.processState !== undefined && value.processState !== null &&
        !["gone", "present", "unknown"].includes(String(value.processState))) ||
      !["pending", "unverified", "verified", "approved", "not_visible"].includes(String(value.state))) return null;
  if (value.currentTask !== undefined && value.currentTask !== null &&
      (!record(value.currentTask) || Object.keys(value.currentTask).sort().join(",") !== "revision,status" ||
       !Number.isSafeInteger(value.currentTask.revision) || Number(value.currentTask.revision) < 0 ||
       Number(value.currentTask.revision) > 2_147_483_647 ||
       !["backlog", "todo", "doing", "review", "blocked", "done", "cancelled"].includes(String(value.currentTask.status)))) return null;
  if (!recoveryEligibility(value.eligibility) || !recoveryGuards(value.guards) ||
      (value.cost !== null && !recoveryCost(value.cost)) ||
      (value.quote !== null && !recoveryCost(value.quote)) ||
      ((value.cost === null) !== (value.quote === null)) ||
      (recoveryCost(value.cost) && recoveryCost(value.quote) && !sameRecoveryCost(value.cost, value.quote)) ||
      (value.riskAcceptance !== null && !recoveryRiskAcceptance(value.riskAcceptance)) ||
      (value.launchProof !== null && !recoveryLaunchProof(value.launchProof)) ||
      (value.apiModelAccess !== undefined &&
        !recoveryApiModelAccess(value.apiModelAccess))) return null;
  if (value.state === "not_visible") return value.inspectionId === null && value.evidenceId === null &&
    value.evidenceDigest === null && value.cost === null && value.quote === null &&
    value.riskAcceptance === null && value.launchProof === null ? value as AmuxHostRecoveryRead : null;
  const acceptanceOnly = value.state === "pending" && value.inspectionId === null &&
    value.evidenceId === null && value.evidenceDigest === null && value.riskAcceptance !== null &&
    value.launchProof === null;
  if ((!acceptanceOnly && !uuid(value.inspectionId)) || value.priorAttemptId !== identity.attemptId ||
      value.taskRevision !== identity.taskRevision + (value.state === "approved" ? 1 : 0) ||
      (value.evidenceId !== null && !uuid(value.evidenceId)) ||
      (value.evidenceDigest !== null && !digest(value.evidenceDigest))) return null;
  if (["verified", "approved"].includes(String(value.state)) &&
      (!uuid(value.evidenceId) || !digest(value.evidenceDigest) || !record(value.cost))) return null;
  if (value.state === "approved" && (typeof value.approvalId !== "string" || !value.approvalId)) return null;
  if (value.requestKind === "safe_stop" && (!uuid(value.sourceEvidenceId) || !digest(value.sourceEvidenceDigest) ||
      typeof value.workerProfileAlias !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.workerProfileAlias) ||
      !Array.isArray(value.profileWorkerNames) || value.profileWorkerNames.length < 1 ||
      value.profileWorkerNames.length > 16 || value.profileWorkerNames.some(name =>
        typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) ||
      typeof value.targetUnit !== "string" || value.targetUnit !==
        `tomverse-amux-v22-sidecar@${value.workerProfileAlias}.service` || !digest(value.profileConfigDigest))) return null;
  if (value.launchProof && recoveryCost(value.quote) &&
      (value.launchProof.pricingVersion !== value.quote.pricingVersion ||
       value.launchProof.costReceiptDigest !== value.quote.costReceiptDigest)) return null;
  return value as AmuxHostRecoveryRead;
}

/** One mutation at most; a lost answer permits one exact GET, never a POST
 * replay. Both transport and body await end at the same 10-second deadline. */
export async function fetchAmuxHostRecovery({ identity, requestId, action, displayed,
  unknownWrite = false, unknownAction, expectedReceipt,
  controller, isCurrent, fallback, locale = "en", fetcher = adminFetch,
  timeoutMs = AMUX_RECOVERY_INSPECTION_TIMEOUT_MS }: {
  identity: AmuxRecoveryInspectionIdentity; requestId: string;
  action?: RecoveryAction; displayed?: AmuxV22RecoveryRead;
  unknownWrite?: boolean; unknownAction?: RecoveryAction; expectedReceipt?: RecoveryReceiptBinding;
  controller: AbortController; isCurrent: () => boolean; fallback: string;
  locale?: "en" | "ko"; fetcher?: typeof adminFetch; timeoutMs?: number;
}): Promise<AmuxHostRecoveryState | null> {
  if (!isCurrent() || controller.signal.aborted) return null;
  const unresolvedAction = unknownAction ?? action;
  const displayedSource = recoverySource(displayed);
  const receiptBinding = expectedReceipt ?? (action === "approve_attempt" && displayed?.cost ?
    displayed.riskAcceptance && displayed.launchProof ? {
      inspectionId: displayed.inspectionId, evidenceId: displayed.evidenceId,
      evidenceDigest: displayed.evidenceDigest, costDigest: displayed.cost.costDigest,
      riskAcceptanceId: displayed.riskAcceptance.id,
      riskAcceptanceDigest: displayed.riskAcceptance.digest,
      launchProofId: displayed.launchProof.id, launchProofDigest: displayed.launchProof.digest,
      launchBindingId: displayed.launchProof.launchBindingId, workerName: displayed.launchProof.workerName,
      provider: displayed.launchProof.provider, modelId: displayed.launchProof.modelId,
      routeId: displayed.launchProof.routeId, briefDigest: displayed.launchProof.briefDigest,
      pricingVersion: displayed.launchProof.pricingVersion,
      costReceiptDigest: displayed.launchProof.costReceiptDigest,
    } : { inspectionId: displayed.inspectionId, evidenceId: displayed.evidenceId,
      evidenceDigest: displayed.evidenceDigest, costDigest: displayed.cost.costDigest } :
    (action === "request_safe_stop" || action === "accept_unknown_prior_effects") &&
      displayedSource ? {
        sourceEvidenceId: displayedSource.id, sourceEvidenceDigest: displayedSource.digest,
        ...(action === "request_safe_stop" && displayed?.riskAcceptance ? {
          riskAcceptanceId: displayed.riskAcceptance.id,
          riskAcceptanceDigest: displayed.riskAcceptance.digest,
        } : {}),
      } : undefined);
  let unresolvedWrite = unknownWrite;
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const abort = () => rejectAborted(new DOMException("Aborted", "AbortError"));
  controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const bounded = <T,>(promise: Promise<T>) => Promise.race([promise, aborted]);
  const unavailable = (failure: AdminApiFailure | null, unconfirmed = unresolvedWrite || Boolean(action)) =>
    ({ state: "unavailable", failure, requestId, unknownWrite: unconfirmed,
      ...(unconfirmed ? { unknownAction: unresolvedAction, expectedReceipt: receiptBinding } : {}) }) as AmuxHostRecoveryState;
  const parse = async (response: Response): Promise<AmuxHostRecoveryState | null> => {
    if (!isCurrent()) return null;
    if (response.status === 409) {
      const failure = await bounded(readAdminApiFailure(response, { fallback, locale }));
      if (!isCurrent()) return null;
      const code = /^[A-Za-z0-9_]{1,128}$/.test(failure.message) ? failure.message : null;
      if (unresolvedWrite) return unavailable(failure, true);
      if (code === "recovery_disabled") return unavailable(failure, false);
      return { state: "changed", reason: code };
    }
    if (!response.ok) {
      const failure = await bounded(readAdminApiFailure(response, { fallback, locale }));
      if (!isCurrent()) return null;
      return unavailable(failure, unresolvedWrite || ![400, 403, 404, 413, 428, 429].includes(response.status));
    }
    const data = bindAmuxHostRecovery(await bounded(response.json()), identity, requestId);
    if (!isCurrent()) return null;
    if (!data) return unresolvedWrite || action ? unavailable(null, true) : { state: "changed" };
    if ((unresolvedWrite || action) && (data.state === "not_visible" ||
        (unresolvedAction === "approve_attempt" && data.state !== "approved") ||
        (unresolvedAction === "request_safe_stop" && data.requestKind !== "safe_stop") ||
        (unresolvedAction === "accept_unknown_prior_effects" &&
          data.riskAcceptance?.ownerRequestId !== requestId)))
      return unavailable(null, true);
    if (data.state === "approved" && approvalReceipt(receiptBinding) &&
        (data.inspectionId !== receiptBinding.inspectionId || data.evidenceId !== receiptBinding.evidenceId ||
         data.evidenceDigest !== receiptBinding.evidenceDigest || data.cost?.costDigest !== receiptBinding.costDigest))
      return unavailable(null, true);
    if (data.state === "approved" && approvalReceipt(receiptBinding) &&
        !riskApprovalReceipt(receiptBinding) && (data.riskAcceptance !== null || data.launchProof !== null))
      return unavailable(null, true);
    if (data.state === "approved" && riskApprovalReceipt(receiptBinding) &&
        (data.riskAcceptance?.id !== receiptBinding.riskAcceptanceId ||
         data.riskAcceptance?.digest !== receiptBinding.riskAcceptanceDigest ||
         data.launchProof?.id !== receiptBinding.launchProofId ||
         data.launchProof?.digest !== receiptBinding.launchProofDigest ||
         data.launchProof?.launchBindingId !== receiptBinding.launchBindingId ||
         data.launchProof?.workerName !== receiptBinding.workerName ||
         data.launchProof?.provider !== receiptBinding.provider ||
         data.launchProof?.modelId !== receiptBinding.modelId ||
         data.launchProof?.routeId !== receiptBinding.routeId ||
         data.launchProof?.briefDigest !== receiptBinding.briefDigest ||
         data.launchProof?.pricingVersion !== receiptBinding.pricingVersion ||
         data.launchProof?.costReceiptDigest !== receiptBinding.costReceiptDigest)) return unavailable(null, true);
    if (unresolvedAction === "accept_unknown_prior_effects" && safeStopReceipt(receiptBinding) &&
        (data.riskAcceptance?.ownerRequestId !== requestId ||
         data.riskAcceptance?.sourceEvidenceId !== receiptBinding.sourceEvidenceId ||
         data.riskAcceptance?.sourceEvidenceDigest !== receiptBinding.sourceEvidenceDigest))
      return unavailable(null, true);
    if (data.requestKind === "safe_stop" && safeStopReceipt(receiptBinding) &&
        (data.sourceEvidenceId !== receiptBinding.sourceEvidenceId ||
         data.sourceEvidenceDigest !== receiptBinding.sourceEvidenceDigest)) return unavailable(null, true);
    if (data.requestKind === "safe_stop" && safeStopReceipt(receiptBinding) &&
        !riskSafeStopReceipt(receiptBinding) && data.riskAcceptance !== null) return unavailable(null, true);
    if (data.requestKind === "safe_stop" && riskSafeStopReceipt(receiptBinding) &&
        (data.riskAcceptance?.id !== receiptBinding.riskAcceptanceId ||
         data.riskAcceptance?.digest !== receiptBinding.riskAcceptanceDigest)) return unavailable(null, true);
    return { state: "ready", data };
  };
  const read = () => bounded(fetcher(`/api/admin/amux/execution-recovery?${new URLSearchParams({
    taskId: identity.taskId, requestId })}`, { cache: "no-store", signal: controller.signal, timeoutMs }));
  try {
    if (action && unknownWrite) return unavailable(null, true);
    if (!action) return await parse(await read());
    if (identity.attemptId === null || !uuid(requestId)) return { state: "changed" };
    const body = { action, taskId: identity.taskId, expectedRevision: identity.taskRevision,
      priorAttemptId: identity.attemptId, requestId,
      ...(action === "approve_attempt" ? { inspectionId: displayed?.inspectionId,
        evidenceId: displayed?.evidenceId, evidenceDigest: displayed?.evidenceDigest,
        costDigest: displayed?.cost?.costDigest,
        ...(displayed?.riskAcceptance && displayed.launchProof ? {
          riskAcceptanceId: displayed.riskAcceptance.id,
          riskAcceptanceDigest: displayed.riskAcceptance.digest,
          launchProofId: displayed.launchProof.id,
          launchProofDigest: displayed.launchProof.digest, acceptRetry: true,
        } : {}) } : {}),
      ...(action === "accept_unknown_prior_effects" ? {
        sourceEvidenceId: displayedSource?.id,
        sourceEvidenceDigest: displayedSource?.digest, acceptRisk: true,
      } : {}),
      ...(action === "request_safe_stop" ? { sourceEvidenceId: displayedSource?.id,
        sourceEvidenceDigest: displayedSource?.digest } : {}) };
    if (action === "approve_attempt" && (!displayed || displayed.state !== "verified" ||
        !displayed.cost || !displayed.eligibility.approveAttempt ||
        (Boolean(displayed.riskAcceptance) !== Boolean(displayed.launchProof)) ||
        (displayed.launchProof !== null && displayed.launchProof.state !== "current") ||
        !bindAmuxHostRecovery(displayed, identity, displayed.requestId))) return { state: "changed" };
    if (action === "accept_unknown_prior_effects" && (!unknownRiskSourceEligible(displayed) ||
        !displayed.eligibility.acceptUnknownPriorEffects || displayed.riskAcceptance !== null ||
        !bindAmuxHostRecovery(displayed, identity, displayed.requestId)))
      return { state: "changed" };
    if (action === "request_safe_stop" && (!safeStopSourceEligible(displayed) ||
        !displayed.eligibility.requestSafeStop ||
        !bindAmuxHostRecovery(displayed, identity, displayed.requestId))) return { state: "changed" };
    try {
      const response = await bounded(fetcher("/api/admin/amux/execution-recovery", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: controller.signal, timeoutMs }));
      const result = await parse(response);
      if (result?.state !== "unavailable" || !result.unknownWrite) return result;
    } catch { /* A single exact read below resolves a lost write answer. */ }
    if (!isCurrent()) return null;
    unresolvedWrite = true;
    if (controller.signal.aborted) return unavailable(null);
    return await parse(await read());
  } catch { return isCurrent() ? unavailable(null) : null; }
  finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
}

/** On-demand GET only. Each await is fenced against close, replacement and
 * timeout, including a delayed response body. It never retries a write. */
export async function fetchAmuxRecoveryInspection({ identity, taskStatus,
  controller, isCurrent, fallback, locale = "en", fetcher = adminFetch,
  timeoutMs = AMUX_RECOVERY_INSPECTION_TIMEOUT_MS }: {
  identity: AmuxRecoveryInspectionIdentity; taskStatus: string;
  controller: AbortController; isCurrent: () => boolean; fallback: string;
  locale?: "en" | "ko"; fetcher?: typeof adminFetch; timeoutMs?: number;
}): Promise<AmuxRecoveryInspectionState | null> {
  if (!isCurrent() || controller.signal.aborted) return null;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ view: "recovery_inspection", taskId: identity.taskId,
      taskRevision: String(identity.taskRevision) });
    if (identity.attemptId !== null) params.set("attemptId", identity.attemptId);
    const response = await fetcher(`/api/admin/amux/execution-view?${params}`,
      { cache: "no-store", signal: controller.signal, timeoutMs });
    if (!isCurrent()) return null;
    if (controller.signal.aborted) return { state: "unavailable", failure: null };
    if (response.status === 409) {
      await discardResponseBody(response);
      return isCurrent() ? { state: "changed" } : null;
    }
    if (!response.ok) {
      const failure = await readAdminApiFailure(response, { fallback, locale });
      if (!isCurrent()) return null;
      return { state: "unavailable", failure };
    }
    const value: unknown = await response.json();
    if (!isCurrent()) return null;
    if (controller.signal.aborted) return { state: "unavailable", failure: null };
    const inspection = bindAmuxRecoveryInspection(value, identity);
    return inspection && inspection.task.status === taskStatus ? { state: "ready", inspection }
      : { state: "changed" };
  } catch {
    return isCurrent() ? { state: "unavailable", failure: null } : null;
  } finally { clearTimeout(timer); }
}

const amount = (value: string | null, fallback: string) => {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return fallback;
  const microusd = BigInt(value);
  const fraction = (microusd % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `US$${microusd / BigInt(1_000_000)}.${fraction}`;
};

export function AmuxRecoveryInspectionView({ m, state, onInspect, onReloadReview, busy = false,
  date }: { m: Messages; state: AmuxRecoveryInspectionState; onInspect: () => void;
  onReloadReview: () => void; date: (value: string) => string; busy?: boolean }) {
  const data = state.state === "ready" ? state.inspection : null;
  return <section className="mt-4 rounded-xl border border-zinc-700 bg-zinc-950/60 p-4"
    data-testid="admin-amux-recovery-inspection">
    <h6 className="font-bold text-zinc-100">{m.title}</h6>
    <p className="mt-2 text-sm leading-6 text-zinc-300">{m.intro}</p>
    <button type="button" onClick={onInspect} disabled={busy || state.state === "loading" || state.state === "changed"}
      data-testid="admin-amux-inspect-records"
      className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-blue-500/40 px-4 py-2 text-sm font-semibold text-blue-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-60">
      {state.state === "loading" ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
      {state.state === "ready" || state.state === "unavailable" ? m.inspectAgain : m.inspect}
    </button>
    <div role="status" aria-live="polite" className="mt-3 text-sm leading-6 text-zinc-300">
      {state.state === "idle" && m.noInspection}
      {state.state === "loading" && m.loading}
      {state.state === "unavailable" && !state.failure && m.unavailable}
      {state.state === "changed" && <><p>{m.changed}</p><button type="button" onClick={onReloadReview}
        className="mt-2 min-h-11 rounded-lg border border-amber-300/40 px-4 py-2 font-semibold text-amber-100">{m.reloadReview}</button></>}
      {data && <>
        <p>{m.checkedAt}: <time dateTime={data.checkedAt}>{date(data.checkedAt)}</time></p>
        <dl className="mt-3 space-y-4">
          <div><dt className="font-semibold text-zinc-100">{m.result}</dt>
            <dd>{m.resultState[data.result.state]}</dd></div>
          <div><dt className="font-semibold text-zinc-100">{m.usage}</dt>
            <dd>{m.usageState[data.usage.state]}</dd>
            <dd>{m.receiptCount(data.usage.displayedCount, data.usage.displayLimit)}</dd>
            {data.usage.state === "reported_complete" && <dd>{m.inputTokens}: {data.usage.inputTokens} · {m.outputTokens}: {data.usage.outputTokens}</dd>}
          </div>
          <div><dt className="font-semibold text-zinc-100">{m.reservation}</dt>
            <dd>{amount(data.cost.reservedMaximumMicrousd, m.unknown)}</dd>
            <dt className="mt-2 font-semibold text-zinc-100">{m.settlement}</dt>
            <dd>{data.cost.confirmed ? amount(data.cost.settledMicrousd, m.unknown) : m.unknown}</dd>
            <dd>{data.cost.confirmed ? m.confirmedCost : m.unknownCost}</dd></div>
          <div><dt className="font-semibold text-zinc-100">{m.worker}</dt>
            <dd className="break-words">{data.attempt?.worker ?? m.unknown}</dd>
            <dt className="mt-2 font-semibold text-zinc-100">{m.runtime}</dt>
            <dd>{data.runtime.state === "not_recorded" ? m.runtimeMissing : data.runtime.state === "different_instance"
              ? m.runtimeDifferent : `${data.runtime.status} · ${data.runtime.heartbeatAt ? date(data.runtime.heartbeatAt) : m.unknown}`}</dd>
            <dd>{m.runtimeBoundary}</dd></div>
        </dl>
        <p className="mt-4 font-semibold text-amber-200">{m.hostTitle}</p>
        <p className="mt-1 text-amber-100/90">{m.hostBoundary}</p>
        <p className="mt-3 text-zinc-400">{m.noAction}</p>
      </>}
    </div>
    {state.state === "unavailable" && state.failure && <AdminApiFailureNotice failure={state.failure}
      returnTo="/admin/amux-execution?tab=assignment" />}
  </section>;
}

export function AmuxHostRecoveryView({ m, state, confirmed, onConfirm, onRequest,
  onRefresh, onApprove, onReloadReview, canRequest, safeStopConfirmed = false,
  onSafeStopConfirm = () => {}, onSafeStop = () => {}, riskConfirmed = false,
  onRiskConfirm = () => {}, onAcceptRisk = () => {}, busy = false, writesBlocked = false,
  storageBlocked = false }: {
  m: Messages; state: AmuxHostRecoveryState; confirmed: boolean;
  onConfirm: (value: boolean) => void; onRequest: () => void; onRefresh: () => void;
  onApprove: () => void; onReloadReview: () => void; canRequest: boolean; busy?: boolean;
  safeStopConfirmed?: boolean; onSafeStopConfirm?: (value: boolean) => void; onSafeStop?: () => void;
  riskConfirmed?: boolean; onRiskConfirm?: (value: boolean) => void; onAcceptRisk?: () => void;
  writesBlocked?: boolean; storageBlocked?: boolean;
}) {
  const data = state.state === "ready" ? state.data : null;
  const quote = data?.quote ?? null;
  const exceptionApproval = Boolean(data?.riskAcceptance && data.launchProof);
  const canApprove = data?.state === "verified" && quote !== null && data.recoveryEnabled !== false &&
    data.eligibility.approveAttempt && (data.requestKind !== "safe_stop" || data.safeStopEnabled === true) &&
    (!exceptionApproval || data.launchProof?.state === "current");
  const safeStopSource = safeStopSourceEligible(data ?? undefined);
  const canAcceptRisk = Boolean(data && safeStopSource && data.recoveryEnabled !== false &&
    data.eligibility.acceptUnknownPriorEffects && data.riskAcceptance === null);
  const canSafeStop = safeStopSource && data?.recoveryEnabled !== false && data?.safeStopEnabled === true &&
    data.eligibility.requestSafeStop;
  const safeStopResult = data?.requestKind === "safe_stop" ? data : null;
  const requestId = data?.requestId ?? (state.state === "unavailable" ? state.requestId : null);
  const disabled = data?.recoveryEnabled === false || data?.reason === "recovery_disabled" ||
    (state.state === "unavailable" && state.failure?.message === "recovery_disabled");
  const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-blue-500/40 px-4 py-2 text-sm font-semibold text-blue-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-60";
  return <section className="mt-4 rounded-xl border border-zinc-700 bg-zinc-950/60 p-4 text-sm leading-6"
    data-testid="admin-amux-host-recovery">
    <h6 className="font-bold text-zinc-100">{m.host.title}</h6>
    <p className="mt-2 text-zinc-300">{m.host.intro}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={button} onClick={onRequest} data-testid="admin-amux-request-host-inspection"
        disabled={writesBlocked || disabled || busy || !canRequest || state.state === "loading" || state.state === "changed" ||
          (state.state === "unavailable" && state.unknownWrite) || data?.state === "approved" ||
          data?.riskAcceptance !== null && data?.riskAcceptance !== undefined}>
        {requestId ? m.host.requestAgain : m.host.request}</button>
      {requestId && <button type="button" className={button} onClick={onRefresh}
        data-testid="admin-amux-refresh-host-inspection" disabled={busy || state.state === "loading" || state.state === "changed"}>
        {m.host.refresh}</button>}
    </div>
    {!canRequest && <p className="mt-2 text-amber-200">{m.host.noAttempt}</p>}
    {storageBlocked && <p className="mt-2 text-amber-200">{m.host.storageBlocked}</p>}
    <div className="mt-3 text-zinc-300" role="status" aria-live="polite">
      {state.state === "idle" && m.host.idle}
      {state.state === "loading" && <span className="inline-flex items-center gap-2"><Loader2 aria-hidden="true"
        className="h-4 w-4 animate-spin" />{m.host.loading}</span>}
      {state.state === "unavailable" && <><p>{disabled ? m.host.disabled : m.host.unavailable}</p>
        {state.unknownWrite && <p className="mt-2 text-amber-200">{m.host.unknownWrite}</p>}</>}
      {state.state === "changed" && <><p>{m.host.changed}</p><button type="button" className={`${button} mt-2`}
        onClick={onReloadReview}>{m.reloadReview}</button>
        {state.reason && <p className="mt-2 break-words">{m.host.reason}: {state.reason}</p>}</>}
      {data && <><p>{disabled ? m.host.disabled :
        data.riskAcceptance && data.inspectionId === null ? m.host.exception.accepted : m.host.statuses[data.state]}</p>
        {data.reason === "evidence_stale" && <p className="mt-2 text-amber-200">{m.host.stale}</p>}
        {data.reason === "legacy_invocation_unbound" && <p className="mt-2 text-amber-200">{m.host.legacy}</p>}
        {data.reason === "terminal_success" && <p className="mt-2 text-amber-200">{m.host.success}</p>}
      </>}
    </div>
    {data && data.state !== "not_visible" && <section
      className="mt-4 rounded-lg border border-amber-300/40 bg-amber-950/20 p-3"
      data-testid="admin-amux-unknown-risk-exception">
      <h6 className="font-semibold text-amber-100">{m.host.exception.title}</h6>
      <p className="mt-2 text-amber-100/90">{m.host.exception.scope}</p>
      <p className="mt-2 text-zinc-300">{m.host.exception.unknown}</p>
      <p className="mt-1 text-zinc-300">{m.host.exception.held}</p>
      {data.eligibility.reason && <p className="mt-3 text-amber-200"
        data-testid="admin-amux-recovery-disabled-reason">
        {m.host.exception.blocked}: {m.host.exception.reason[data.eligibility.reason]}
        <span className="sr-only"> ({data.eligibility.reason})</span>
      </p>}
      {data.riskAcceptance === null && data.eligibility.acceptUnknownPriorEffects && <>
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 py-2 text-zinc-100">
          <input type="checkbox" checked={riskConfirmed} disabled={busy || writesBlocked || !canAcceptRisk}
            onChange={event => onRiskConfirm(event.target.checked)}
            data-testid="admin-amux-risk-accept-confirm" className="mt-1 h-4 w-4 shrink-0 accent-blue-500" />
          <span>{m.host.exception.confirm}</span>
        </label>
        <button type="button" className={`${button} mt-2`} onClick={onAcceptRisk}
          disabled={busy || writesBlocked || !canAcceptRisk || !riskConfirmed}
          data-testid="admin-amux-accept-unknown-risk">{m.host.exception.accept}</button>
      </>}
      {data.riskAcceptance && <div className="mt-3 border-t border-amber-300/20 pt-3"
        data-testid="admin-amux-risk-acceptance-receipt">
        <p className="font-semibold text-zinc-100">{m.host.exception.accepted}</p>
        <p className="mt-1 text-zinc-300">{m.host.exception.acceptedBoundary}</p>
        <dl className="mt-2 space-y-2 break-words text-zinc-300">
          <div><dt className="font-semibold text-zinc-100">{m.host.exception.acceptanceId}</dt>
            <dd>{data.riskAcceptance.id}</dd></div>
          <div><dt className="font-semibold text-zinc-100">{m.host.exception.acceptedAt}</dt>
            <dd>{data.riskAcceptance.acceptedAt}</dd></div>
        </dl>
        <div className="mt-3 border-t border-zinc-700 pt-3">
          <p className="font-semibold text-zinc-100">{m.host.exception.launchTitle}</p>
          {!data.launchProof && <p className="mt-1 text-amber-200">{m.host.exception.launchMissing}</p>}
          {data.launchProof && <dl className="mt-2 grid gap-3 break-words sm:grid-cols-2"
            data-testid="admin-amux-read-only-launch-proof">
            <div><dt className="font-semibold text-zinc-100">{m.host.exception.launchStatus}</dt>
              <dd>{m.host.exception.launchState[data.launchProof.state]}</dd></div>
            <div><dt className="font-semibold text-zinc-100">{m.host.exception.role}</dt><dd>{data.launchProof.role}</dd></div>
            <div><dt className="font-semibold text-zinc-100">{m.host.exception.worker}</dt><dd>{data.launchProof.workerName}</dd></div>
            <div><dt className="font-semibold text-zinc-100">{m.host.exception.provider}</dt><dd>{data.launchProof.provider}</dd></div>
            <div><dt className="font-semibold text-zinc-100">{m.host.exception.model}</dt><dd>{data.launchProof.modelId}</dd></div>
            <div><dt className="font-semibold text-zinc-100">{m.host.exception.route}</dt><dd>{data.launchProof.routeId}</dd></div>
            <div><dt className="font-semibold text-zinc-100">{m.host.exception.binding}</dt><dd>{data.launchProof.launchBindingId}</dd></div>
            <div><dt className="font-semibold text-zinc-100">{m.host.exception.brief}</dt><dd>{data.launchProof.briefDigest}</dd></div>
          </dl>}
          {data.apiModelAccess && <div className="mt-3 rounded-md border border-zinc-700 p-3"
            data-testid="admin-amux-api-model-access">
            <p className={data.apiModelAccess.state === "verified" ?
              "text-emerald-200" : "text-amber-200"}>
              {data.apiModelAccess.state === "verified" ?
                m.host.exception.apiAccess : m.host.exception.apiAccessPending}
            </p>
            {data.apiModelAccess.canonicalModelId && <p className="mt-1 break-words text-zinc-300">
              {m.host.exception.canonicalModel}: {data.apiModelAccess.canonicalModelId}
            </p>}
          </div>}
        </div>
      </div>}
    </section>}
    {safeStopSource && <div className="mt-4 rounded-lg border border-amber-300/40 bg-amber-950/20 p-3"
      data-testid="admin-amux-safe-stop-risk">
      <h6 className="font-semibold text-amber-100">{m.host.safeStop.title}</h6>
      <p className="mt-2 text-amber-100/90">{m.host.safeStop.risk}</p>
      {data?.safeStopEnabled === false && <p className="mt-2 text-amber-200">{m.host.safeStop.disabled}</p>}
      <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-3 py-2 text-zinc-100">
        <input type="checkbox" checked={safeStopConfirmed}
          disabled={busy || writesBlocked || !canSafeStop}
          onChange={event => onSafeStopConfirm(event.target.checked)}
          data-testid="admin-amux-safe-stop-confirm" className="mt-1 h-4 w-4 shrink-0 accent-blue-500" />
        <span>{m.host.safeStop.confirm}</span>
      </label>
      <button type="button" className={`${button} mt-2`} onClick={onSafeStop}
        disabled={busy || writesBlocked || !canSafeStop || !safeStopConfirmed}
        data-testid="admin-amux-request-safe-stop">{data?.requestKind === "safe_stop" ?
          m.host.safeStop.recheck : m.host.safeStop.action}</button>
    </div>}
    {safeStopResult && <section className="mt-4 rounded-lg border border-zinc-700 p-3"
      data-testid="admin-amux-safe-stop-result">
      <h6 className="font-semibold text-zinc-100">{m.host.safeStop.title}</h6>
      <p className="mt-2 text-zinc-300">{m.host.safeStop.requested}</p>
      <p className="mt-2 text-amber-100/90">{m.host.safeStop.risk}</p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div><dt className="font-semibold text-zinc-100">{m.host.safeStop.stopResult}</dt>
          <dd>{safeStopResult.stopAcknowledgement ?
            m.host.safeStop.acknowledgement[safeStopResult.stopAcknowledgement] : m.unknown}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.safeStop.processResult}</dt>
          <dd>{safeStopResult.processState ? m.host.safeStop.process[safeStopResult.processState] : m.unknown}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.safeStop.modelResult}</dt>
          <dd>{m.host.safeStop.modelUnknown}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.safeStop.actualCost}</dt>
          <dd>{m.host.safeStop.actualCostUnknown}</dd></div>
      </dl>
      <div className="mt-3 border-t border-zinc-700 pt-3">
        <p className="font-semibold text-zinc-100">{m.host.safeStop.nextApproval}</p>
        <p className="mt-1 text-zinc-300">{safeStopResult.state === "verified" &&
          safeStopResult.eligibility.approveAttempt ?
          m.host.safeStop.nextApprovalReady : m.host.safeStop.nextApprovalBlocked}</p>
      </div>
    </section>}
    {requestId && <details className="mt-3 text-zinc-300">
      <summary className="min-h-11 cursor-pointer py-2 font-semibold text-zinc-100">{m.host.safeStop.technical}</summary>
      <dl className="space-y-2 break-words">
        <div><dt className="font-semibold text-zinc-100">{m.host.requestId}</dt><dd>{requestId}</dd></div>
        {data?.inspectionId && <div><dt className="font-semibold text-zinc-100">{m.host.inspectionId}</dt><dd>{data.inspectionId}</dd></div>}
        {data?.evidenceId && <div><dt className="font-semibold text-zinc-100">{m.host.evidenceId}</dt><dd>{data.evidenceId}</dd></div>}
        {data?.evidenceDigest && <div><dt className="font-semibold text-zinc-100">{m.host.evidenceDigest}</dt><dd>{data.evidenceDigest}</dd></div>}
        {data?.reason && <div><dt className="font-semibold text-zinc-100">{m.host.reason}</dt><dd>{data.reason}</dd></div>}
        {data?.approvalId && <div><dt className="font-semibold text-zinc-100">{m.host.approvedId}</dt><dd>{data.approvalId}</dd></div>}
        {data?.taskRevision !== null && data?.taskRevision !== undefined &&
          <div><dt className="font-semibold text-zinc-100">{data.state === "approved" ? m.host.approvedRevision : m.host.revision}</dt><dd>{data.taskRevision}</dd></div>}
        {data?.state === "approved" && <>
          <div><dt className="font-semibold text-zinc-100">{m.host.currentTask}</dt><dd>{data.currentTask?.status ?? m.unknown}</dd></div>
          <div><dt className="font-semibold text-zinc-100">{m.host.currentRevision}</dt><dd>{data.currentTask?.revision ?? m.unknown}</dd></div>
          <p className="text-zinc-400">{m.host.currentBoundary}</p>
        </>}
      </dl>
    </details>}
    {quote && <>
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <div><dt className="font-semibold text-zinc-100">{m.host.oldHeld}</dt><dd className="mt-1">{amount(quote.oldHeldMicroUsd, m.unknown)}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.additional}</dt><dd className="mt-1">{amount(quote.additionalCapMicroUsd, m.unknown)}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.worst}</dt><dd className="mt-1">{amount(quote.worstExposureMicroUsd, m.unknown)}</dd></div>
      </dl>
      <p className="mt-3 text-zinc-400">{m.host.costBoundary}</p>
      <dl className="mt-3 space-y-2 break-words text-zinc-300">
        <div><dt className="font-semibold text-zinc-100">{m.host.catalog}</dt><dd>{quote.catalogApprovalId} · {quote.catalogVersion}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.pricing}</dt><dd>{quote.pricingVersion}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.costReceipt}</dt><dd>{quote.costReceiptDigest}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.costDigest}</dt><dd>{quote.costDigest}</dd></div>
      </dl>
    </>}
    {canApprove && <div className="mt-4 border-t border-zinc-700 pt-3">
      <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-zinc-100">
        <input type="checkbox" checked={confirmed} disabled={busy || writesBlocked} onChange={event => onConfirm(event.target.checked)}
          data-testid="admin-amux-recovery-cost-confirm" className="mt-1 h-4 w-4 shrink-0 accent-blue-500" />
        <span>{exceptionApproval ? m.host.exception.finalConfirm : m.host.confirm}</span>
      </label>
      <button type="button" className={`${button} mt-2`} onClick={onApprove} disabled={busy || writesBlocked || !confirmed}
        data-testid="admin-amux-approve-recovery">{exceptionApproval ? m.host.exception.finalApprove : m.host.approve}</button>
    </div>}
    {data?.state === "approved" && <button type="button" className={`${button} mt-3`}
      onClick={onReloadReview} data-testid="admin-amux-recovery-history">{m.host.trace}</button>}
    {state.state === "unavailable" && state.failure && <AdminApiFailureNotice failure={state.failure}
      returnTo="/admin/amux-execution?tab=assignment" />}
  </section>;
}

export function AmuxOwnerRecoveryInspectionPanel({ identity, taskStatus, onReloadReview }: {
  identity: AmuxRecoveryInspectionIdentity; taskStatus: string; onReloadReview: () => void;
}) {
  const m = useAdminMessages(adminAmuxRecoveryInspectionMessages);
  const { locale } = useAdminLocale();
  const [state, setState] = useState<AmuxRecoveryInspectionState>({ state: "idle" });
  const [host, setHost] = useState<AmuxHostRecoveryState>({ state: "idle" });
  const [confirmed, setConfirmed] = useState(false);
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const [safeStopConfirmed, setSafeStopConfirmed] = useState(false);
  const [pendingStorage, setPendingStorage] = useState<AmuxPendingRecoveryLoad | { state: "loading" }>({ state: "loading" });
  const pendingRecovery = useRef<AmuxPendingRecovery | null>(null);
  const requestId = useRef(0);
  const active = useRef<AbortController | null>(null);
  const hostRequestId = useRef<string | null>(null);
  const unresolvedState = (pending: AmuxPendingRecovery, failure: AdminApiFailure | null = null): AmuxHostRecoveryState =>
    ({ state: "unavailable", failure, requestId: pending.requestId, unknownWrite: true,
      unknownAction: pending.action, ...(pending.expectedReceipt ? { expectedReceipt: pending.expectedReceipt } : {}) });
  useEffect(() => {
    let disposed = false;
    const restored = readAmuxPendingRecovery(identity.taskId);
    const resume = restored.state === "empty" ?
      readAmuxAcceptedRiskResume(identity.taskId) : null;
    const resumeRequestId = resume?.priorAttemptId === identity.attemptId ?
      crypto.randomUUID() : null;
    queueMicrotask(() => {
      if (disposed) return;
      setPendingStorage(restored); setConfirmed(false); setRiskConfirmed(false); setSafeStopConfirmed(false);
      pendingRecovery.current = restored.state === "pending" ? restored.pending : null;
      hostRequestId.current = restored.state === "pending" ? restored.pending.requestId : resumeRequestId;
      setHost(restored.state === "pending" ? { state: "unavailable", failure: null,
        requestId: restored.pending.requestId, unknownWrite: true, unknownAction: restored.pending.action,
        ...(restored.pending.expectedReceipt ? { expectedReceipt: restored.pending.expectedReceipt } : {}) } :
        resumeRequestId ? { state: "loading" } : { state: "idle" });
      if (resumeRequestId) {
        const controller = new AbortController(); active.current = controller;
        const current = ++requestId.current;
        const isCurrent = () => !disposed && current === requestId.current &&
          active.current === controller;
        void fetchAmuxHostRecovery({ identity: { taskId: identity.taskId,
          taskRevision: identity.taskRevision, attemptId: identity.attemptId },
          requestId: resumeRequestId,
          controller, isCurrent, fallback: m.host.unavailable, locale }).then(next => {
          if (!isCurrent()) return;
          if (next) setHost(next);
          active.current = null;
        });
      }
    });
    return () => { disposed = true; requestId.current += 1; active.current?.abort(); active.current = null; };
  }, [identity.taskId, identity.taskRevision, identity.attemptId, locale, m.host.unavailable]);
  const inspect = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const current = ++requestId.current;
    const isCurrent = () => current === requestId.current && active.current === controller;
    setState({ state: "loading" });
    const next = await fetchAmuxRecoveryInspection({ identity, taskStatus, controller, isCurrent,
      fallback: m.unavailable, locale });
    if (!isCurrent()) return;
    if (next) setState(next);
    active.current = null;
  };
  const recover = async (action?: RecoveryAction) => {
    if (active.current) return;
    // Recheck synchronously as well: a click can precede hydration, or another
    // mounted panel can have recorded an unresolved request for this task.
    const stored = readAmuxPendingRecovery(identity.taskId);
    const remembered = pendingRecovery.current?.identity.taskId === identity.taskId ? pendingRecovery.current : null;
    let pending = stored.state === "pending" ? stored.pending : remembered;
    setPendingStorage(stored);
    if (pending) {
      pendingRecovery.current = pending; hostRequestId.current = pending.requestId;
      if (action) { setHost(unresolvedState(pending)); return; }
    } else if (stored.state !== "empty" || identity.attemptId === null) return;
    const displayed = host.state === "ready" ? host.data : undefined;
    const source = recoverySource(displayed);
    if (action === "request_inspection" && displayed?.riskAcceptance) return;
    if (action === "approve_attempt" && (!displayed || displayed.state !== "verified" ||
        !displayed.cost || !displayed.eligibility.approveAttempt ||
        !bindAmuxHostRecovery(displayed, identity, displayed.requestId))) return;
    if (action === "accept_unknown_prior_effects" && (!unknownRiskSourceEligible(displayed) ||
        !displayed.eligibility.acceptUnknownPriorEffects || displayed.riskAcceptance !== null ||
        !bindAmuxHostRecovery(displayed, identity, displayed.requestId))) return;
    if (action === "request_safe_stop" && (!safeStopSourceEligible(displayed) ||
        !displayed.eligibility.requestSafeStop ||
        !bindAmuxHostRecovery(displayed, identity, displayed.requestId))) return;
    const id = pending?.requestId ?? (action ? crypto.randomUUID() : hostRequestId.current);
    if (!id) return;
    if (action) {
      const proposed: AmuxPendingRecovery = { version: 1,
        identity: { ...identity, attemptId: identity.attemptId! }, requestId: id, action,
        expectedReceipt: action === "approve_attempt" ? displayed!.riskAcceptance && displayed!.launchProof ? {
          inspectionId: displayed!.inspectionId, evidenceId: displayed!.evidenceId,
          evidenceDigest: displayed!.evidenceDigest, costDigest: displayed!.cost!.costDigest,
          riskAcceptanceId: displayed!.riskAcceptance.id,
          riskAcceptanceDigest: displayed!.riskAcceptance.digest,
          launchProofId: displayed!.launchProof.id, launchProofDigest: displayed!.launchProof.digest,
          launchBindingId: displayed!.launchProof.launchBindingId,
          workerName: displayed!.launchProof.workerName, provider: displayed!.launchProof.provider,
          modelId: displayed!.launchProof.modelId, routeId: displayed!.launchProof.routeId,
          briefDigest: displayed!.launchProof.briefDigest,
          pricingVersion: displayed!.launchProof.pricingVersion,
          costReceiptDigest: displayed!.launchProof.costReceiptDigest,
        } : { inspectionId: displayed!.inspectionId,
          evidenceId: displayed!.evidenceId, evidenceDigest: displayed!.evidenceDigest,
          costDigest: displayed!.cost!.costDigest } :
          action === "request_safe_stop" || action === "accept_unknown_prior_effects" ? {
          sourceEvidenceId: source!.id, sourceEvidenceDigest: source!.digest,
          ...(action === "request_safe_stop" && displayed!.riskAcceptance ? {
            riskAcceptanceId: displayed!.riskAcceptance.id,
            riskAcceptanceDigest: displayed!.riskAcceptance.digest,
          } : {}),
        } : null };
      const saved = saveAmuxPendingRecovery(proposed);
      setPendingStorage(saved);
      if (saved.state !== "pending") return;
      pending = saved.pending; pendingRecovery.current = pending;
      if (pending.requestId !== id) { hostRequestId.current = pending.requestId; setHost(unresolvedState(pending)); return; }
    }
    hostRequestId.current = id;
    const controller = new AbortController(); active.current = controller;
    const current = ++requestId.current;
    const isCurrent = () => current === requestId.current && active.current === controller;
    setConfirmed(false); setRiskConfirmed(false); setSafeStopConfirmed(false); setHost({ state: "loading" });
    const next = await fetchAmuxHostRecovery({ identity: pending?.identity ?? identity, requestId: id, action, displayed,
      unknownWrite: Boolean(pending && !action), unknownAction: pending?.action,
      expectedReceipt: pending?.expectedReceipt ?? undefined,
      controller, isCurrent, fallback: m.host.unavailable, locale });
    if (!isCurrent()) return;
    if (pending && next) {
      const pendingReceipt = pending.expectedReceipt ?? undefined;
      const safeStopConfirmedResult = next.state === "ready" && safeStopReceipt(pendingReceipt) &&
        next.data.requestKind === "safe_stop" &&
        next.data.sourceEvidenceId === pendingReceipt.sourceEvidenceId &&
        next.data.sourceEvidenceDigest === pendingReceipt.sourceEvidenceDigest &&
        (!riskSafeStopReceipt(pendingReceipt) ||
          (next.data.riskAcceptance?.id === pendingReceipt.riskAcceptanceId &&
           next.data.riskAcceptance?.digest === pendingReceipt.riskAcceptanceDigest));
      const riskAcceptanceConfirmedResult = next.state === "ready" && safeStopReceipt(pendingReceipt) &&
        next.data.riskAcceptance?.ownerRequestId === pending.requestId &&
        next.data.riskAcceptance.sourceEvidenceId === pendingReceipt.sourceEvidenceId &&
        next.data.riskAcceptance.sourceEvidenceDigest === pendingReceipt.sourceEvidenceDigest;
      const confirmedResult = next.state === "ready" && next.data.state !== "not_visible" &&
        (pending.action === "approve_attempt" ? next.data.state === "approved" :
         pending.action === "accept_unknown_prior_effects" ? riskAcceptanceConfirmedResult :
         pending.action === "request_safe_stop" ? safeStopConfirmedResult :
           next.data.state !== "approved");
      const resume = pending.action === "accept_unknown_prior_effects" ? {
        version: 1 as const, taskId: pending.identity.taskId,
        priorAttemptId: pending.identity.attemptId } : null;
      const resumeStored = !resume || !confirmedResult || saveAmuxAcceptedRiskResume(resume);
      if (confirmedResult && resumeStored && clearAmuxPendingRecovery(pending)) {
        pendingRecovery.current = null; setPendingStorage({ state: "empty" });
        if (pending.action === "approve_attempt") clearAmuxAcceptedRiskResume({
          version: 1, taskId: pending.identity.taskId,
          priorAttemptId: pending.identity.attemptId });
        const sameIdentity = pending.identity.taskId === identity.taskId &&
          pending.identity.taskRevision === identity.taskRevision && pending.identity.attemptId === identity.attemptId;
        setHost(sameIdentity ? next : { state: "changed" });
      } else {
        setPendingStorage({ state: "pending", pending });
        setHost(unresolvedState(pending, next.state === "unavailable" ? next.failure : null));
      }
    } else if (next) setHost(next);
    active.current = null;
  };
  const date = (value: string) => new Intl.DateTimeFormat(adminIntlLocale(locale), {
    dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  const busy = state.state === "loading" || host.state === "loading";
  return <><AmuxRecoveryInspectionView m={m} state={state} busy={busy} onInspect={() => void inspect()}
    onReloadReview={onReloadReview} date={date} />
    <AmuxHostRecoveryView m={m} state={host} busy={busy} confirmed={confirmed} onConfirm={setConfirmed}
      riskConfirmed={riskConfirmed} onRiskConfirm={setRiskConfirmed}
      safeStopConfirmed={safeStopConfirmed} onSafeStopConfirm={setSafeStopConfirmed}
      writesBlocked={pendingStorage.state !== "empty"} storageBlocked={pendingStorage.state === "blocked"}
      onRequest={() => void recover("request_inspection")} onRefresh={() => void recover()}
      onAcceptRisk={() => { if (riskConfirmed) void recover("accept_unknown_prior_effects"); }}
      onSafeStop={() => { if (safeStopConfirmed) void recover("request_safe_stop"); }}
      onApprove={() => { if (confirmed) void recover("approve_attempt"); }}
      onReloadReview={onReloadReview} canRequest={identity.attemptId !== null} /></>;
}
