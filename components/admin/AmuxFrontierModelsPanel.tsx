"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { AmuxAnalysisBudgetPanel } from "@/components/admin/AmuxAnalysisBudgetPanel";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxAnalysisBudgetMessages } from "@/lib/adminMessages/amuxAnalysisBudget";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import {
  readAvailableFrontierModels,
  readCheckedFrontierSelection,
  type AvailableFrontierModel,
} from "@/lib/amux/ideaFrontierCatalogUiCore";
import {
  readPreparedIdeaTransferPreview, readPreviewReceipt, reservePreviewReceipt,
  type PreparedIdeaTransferPreview,
} from "@/lib/amux/ideaTransferPreviewUiCore";
import {
  AMUX_IDEA_BUILD_PREVIEW_REQUEST_TIMEOUT_MS, AMUX_IDEA_EXECUTION_APPROVAL_REQUEST_TIMEOUT_MS,
} from "@/lib/amux/ideaRequestTimeoutsCore";
import {
  classifyBuildPreviewAnswer, reserveBuildPreviewReceipt, takeBuildPreviewReceipt,
} from "@/lib/amux/ideaBuildPreviewUiCore";
import {
  clearRefusedConfirmationAttempt, readConfirmedIdeaTransfer, readConfirmationAttempt,
  readConfirmationAttemptForPreview, reserveConfirmationAttempt,
  type ConfirmedIdeaTransfer,
} from "@/lib/amux/ideaTransferConfirmationUiCore";

type PreviewState =
  | { kind: "idle" | "pending" | "unknown" | "expired" | "confirmed" | "recovery_unavailable" }
  | { kind: "prepared"; value: PreparedIdeaTransferPreview };
type ConfirmState =
  | { kind: "idle" | "pending" | "unknown" | "expired" | "refused" }
  | { kind: "confirmed"; value: ConfirmedIdeaTransfer };

const receiptStore = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

/** What the idea input hands over so this panel can build the preview in
 * one request (amux-intake.md v18 item 1): the draft, and the input panel's
 * own submission bookkeeping, so a lost answer recovers exactly as a lost
 * submission does. */
export type AmuxBuildPreviewHooks = {
  draft: { idea: string; repositories: string[]; pullRequests: Array<{ repository: string; number: number }> } | null;
  reserve: (requestId: string) => boolean;
  onBuilt: (built: { requestId: string; ideaId: string; hasExternalSources: boolean; planReady: boolean }) => void;
  onUnknown: (requestId: string) => void;
  onRefused: (requestId: string, code: string) => void;
};

export function AmuxFrontierModelsPanel({ available, previewAvailable, confirmAvailable,
  analysisBudgetAvailable, ideaId, planReady,
  declaredExternalSources, operatorId, chunkIndex = 0, build = null, buildRequestId = null }: {
  available: boolean;
  previewAvailable: boolean; confirmAvailable: boolean;
  analysisBudgetAvailable: boolean;
  ideaId: string | null;
  planReady: boolean; declaredExternalSources: boolean; operatorId: string;
  chunkIndex?: number;
  build?: AmuxBuildPreviewHooks | null;
  /** The saved idea's submission request id, which keys a build's receipt. */
  buildRequestId?: string | null;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const budgetMessages = useAdminMessages(adminAmuxAnalysisBudgetMessages);
  const { locale } = useAdminLocale();
  const [models, setModels] = useState<AvailableFrontierModel[] | null>(null);
  const [loading, setLoading] = useState(available);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [building, setBuilding] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [confirmation, setConfirmation] = useState<ConfirmState>({ kind: "idle" });
  // The approved, admissible analysis price that one execution approval
  // reserves against (amux-intake.md v18 item 1). Without one, only the
  // separate confirmation remains.
  // "none" is a read that found no admissible price; loading and a failed
  // read offer neither button, so a slow read never falls back to the
  // separate confirmation.
  const [readPrice, setExecutionPrice] = useState<
    { kind: "loading" | "none" | "error" } | { kind: "ready"; id: string }>({ kind: "loading" });
  // With the budget feature off there is nothing to reserve against: the
  // separate confirmation is the only path, as before.
  const executionPrice = analysisBudgetAvailable ? readPrice : { kind: "none" as const };
  const executionPriceId = executionPrice.kind === "ready" ? executionPrice.id : null;
  const [executionRefusal, setExecutionRefusal] = useState<string | null>(null);
  const selected = models?.find((model) => model.approvalId === selectedApprovalId);

  const readConfirmation = useCallback(async (pendingId: string,
    expectedIdeaId: string, expectedDigest: string, expectedDigestKeyId: string) => {
    const report = (next: ConfirmState) => setConfirmation((current) =>
      current.kind === "confirmed" ? current : next);
    try {
      const query = new URLSearchParams({ previewId: pendingId });
      const response = await adminFetch(`/api/admin/amux/ideas/transfer-confirmation?${query}`,
        { cache: "no-store" });
      if (!response.ok) { report({ kind: "unknown" }); return; }
      const body: unknown = await response.json();
      const parsed = readConfirmedIdeaTransfer(response.status, body, pendingId,
        expectedIdeaId, expectedDigest, expectedDigestKeyId);
      if (parsed) {
        report({ kind: "confirmed", value: parsed });
        setPreview((current) => current.kind === "prepared" ? current : { kind: "confirmed" });
      } else if (body && typeof body === "object" &&
                 (body as Record<string, unknown>).state === "expired") {
        report({ kind: "expired" });
      } else { report({ kind: "unknown" }); }
    } catch { report({ kind: "unknown" }); }
  }, []);

  const readBack = useCallback(async (pendingId: string, model: AvailableFrontierModel,
    effort: string) => {
    try {
      const query = new URLSearchParams({ previewId: pendingId });
      const response = await adminFetch(`/api/admin/amux/ideas/transfer-preview?${query}`,
        { cache: "no-store" });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response.clone(), {
          fallback: m.transferPreviewUnknown, locale,
        }));
        setPreview({ kind: "unknown" });
        return;
      }
      const body: unknown = await response.json();
      if (response.ok && body && typeof body === "object" &&
          (body as Record<string, unknown>).state === "expired") {
        setPreview({ kind: "expired" });
        return;
      }
      const parsed = readPreparedIdeaTransferPreview(response.status, body, pendingId, ideaId ?? "",
        model, effort, chunkIndex);
      if (parsed) {
        setPreview({ kind: "prepared", value: parsed });
        if (confirmAvailable) {
          const attempt = readConfirmationAttempt(receiptStore(), operatorId, pendingId,
            ideaId ?? "", parsed.payloadDigest, parsed.payloadDigestKeyId);
          if (attempt === "present") {
            setConfirmation({ kind: "pending" });
            await readConfirmation(pendingId, ideaId ?? "", parsed.payloadDigest,
              parsed.payloadDigestKeyId);
          } else if (attempt === "unavailable") {
            setConfirmation({ kind: "unknown" });
          }
        }
        return;
      }
      if (confirmAvailable && body && typeof body === "object" &&
          (body as Record<string, unknown>).state === "unavailable") {
        const attempt = readConfirmationAttemptForPreview(receiptStore(), operatorId,
          pendingId, ideaId ?? "");
        if (attempt.kind === "present") {
          setPreview({ kind: "unknown" });
          setConfirmation({ kind: "pending" });
          await readConfirmation(pendingId, ideaId ?? "", attempt.payloadDigest,
            attempt.payloadDigestKeyId);
        } else {
          setPreview({ kind: attempt.kind === "unavailable" ?
            "recovery_unavailable" : "unknown" });
        }
        return;
      }
      setPreview({ kind: "unknown" });
    } catch { setPreview({ kind: "unknown" }); }
  }, [chunkIndex, confirmAvailable, ideaId, locale, m.transferPreviewUnknown,
    operatorId, readConfirmation]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!available) return;
    try {
      const response = await adminFetch("/api/admin/amux/ideas/frontier-models?mode=available",
        { cache: "no-store", signal });
      if (!response.ok) {
        const reason = await readAdminApiFailure(response, { fallback: m.frontierModelsUnavailable, locale });
        if (!signal?.aborted) { setModels(null); setFailure(reason); }
        return;
      }
      const parsed = readAvailableFrontierModels(response.status, await response.json());
      if (!signal?.aborted) {
        if (parsed === null) {
          setModels(null);
          setFailure({ message: m.frontierModelsInvalid, tone: "error",
            requiresReauthentication: false, approvalId: null });
        } else { setFailure(null); setModels(parsed); }
      }
    } catch {
      if (!signal?.aborted) {
        setModels(null);
        setFailure({ message: m.frontierModelsUnavailable, tone: "error",
          requiresReauthentication: false, approvalId: null });
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [available, locale, m.frontierModelsUnavailable, m.frontierModelsInvalid]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!ideaId || !previewAvailable) return;
    const receipt = readPreviewReceipt(receiptStore(), operatorId, ideaId,
      chunkIndex);
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (receipt.kind === "present") {
        setPreview({ kind: "pending" });
        void readBack(receipt.previewId, receipt.model, receipt.effort);
      } else if (receipt.kind === "unavailable") {
        setPreview({ kind: "recovery_unavailable" });
      }
    });
    return () => { active = false; };
  }, [chunkIndex, ideaId, operatorId, previewAvailable, readBack]);

  // A build whose answer was lost: once the saved idea's plan reads back as
  // committed, the preview may have been prepared after it, so the receipt
  // recorded before the request becomes this idea's preview receipt and its
  // exact preview is read back. A plan read back absent is no evidence: the
  // build may still be running, so the receipt is kept until a plan exists.
  useEffect(() => {
    if (!ideaId || !planReady || !buildRequestId || !previewAvailable || chunkIndex !== 0) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const receipt = takeBuildPreviewReceipt(receiptStore(), operatorId, buildRequestId);
      if (!receipt || !reservePreviewReceipt(receiptStore(), operatorId, ideaId, receipt.previewId,
        receipt.model, receipt.effort, 0)) return;
      setPreview({ kind: "pending" });
      void readBack(receipt.previewId, receipt.model, receipt.effort);
    });
    return () => { active = false; };
  }, [buildRequestId, chunkIndex, ideaId, operatorId, planReady, previewAvailable, readBack]);

  const refresh = () => {
    setLoading(true);
    setFailure(null);
    setModels(null);
    setSelectedApprovalId("");
    setSelectedEffort("");
    setChecked(false);
    void load();
  };

  const checkSelection = async () => {
    if (!selected || !selected.allowedEfforts.includes(selectedEffort) || checking) return;
    setChecking(true);
    setChecked(false);
    setFailure(null);
    try {
      const params = new URLSearchParams({ mode: "check", provider: selected.provider,
        modelId: selected.modelId, reasoningEffort: selectedEffort });
      const response = await adminFetch(`/api/admin/amux/ideas/frontier-models?${params}`,
        { cache: "no-store" });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, {
          fallback: m.frontierSelectionUnavailable, locale,
        }));
        return;
      }
      const result = readCheckedFrontierSelection(response.status, await response.json(), selected);
      if (!result) {
        setFailure({ message: m.frontierModelsInvalid, tone: "error",
          requiresReauthentication: false, approvalId: null });
        return;
      }
      setChecked(true);
    } catch {
      setFailure({ message: m.frontierSelectionUnavailable, tone: "error",
        requiresReauthentication: false, approvalId: null });
    } finally { setChecking(false); }
  };

  const preparePreview = async () => {
    if (!ideaId || !previewAvailable || !planReady || declaredExternalSources ||
        !selected || !checked ||
        !selected.allowedEfforts.includes(selectedEffort) || preview.kind !== "idle") return;
    const model = selected;
    const effort = selectedEffort;
    const previewId = crypto.randomUUID();
    if (!reservePreviewReceipt(receiptStore(), operatorId, ideaId, previewId,
      model, effort, chunkIndex)) {
      setPreview({ kind: "recovery_unavailable" });
      return;
    }
    setPreview({ kind: "pending" });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/transfer-preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: chunkIndex === 0 ? 1 : 2, previewId, ideaId,
          ...(chunkIndex > 0 ? { chunkIndex } : {}),
          provider: model.provider, modelId: model.modelId,
          reasoningEffort: effort, approvalId: model.approvalId,
          approvalVersion: model.approvalVersion }),
      });
      const body: unknown = await response.json();
      const parsed = readPreparedIdeaTransferPreview(response.status, body,
        previewId, ideaId, model, effort, chunkIndex);
      if (parsed) { setPreview({ kind: "prepared", value: parsed }); return; }
      await readBack(previewId, model, effort);
    } catch { await readBack(previewId, model, effort); }
  };

  const recoverPreview = () => {
    if (!ideaId) return;
    const receipt = readPreviewReceipt(receiptStore(), operatorId, ideaId,
      chunkIndex);
    if (receipt.kind !== "present") {
      setPreview({ kind: "recovery_unavailable" });
      return;
    }
    setFailure(null);
    setPreview({ kind: "pending" });
    void readBack(receipt.previewId, receipt.model, receipt.effort);
  };

  useEffect(() => {
    if (!analysisBudgetAvailable || preview.kind !== "prepared") return;
    let active = true;
    void adminFetch("/api/admin/amux/ideas/analysis-prices?profile=first-live", { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = response.ok ? await response.json() : null;
        const latest = body && typeof body === "object" && !Array.isArray(body) ?
          (body as { latest?: unknown }).latest : null;
        const row = latest && typeof latest === "object" && !Array.isArray(latest) ?
          latest as Record<string, unknown> : null;
        if (!active) return;
        if (!response.ok || !body || typeof body !== "object" || Array.isArray(body) ||
            (body as { state?: unknown }).state !== "profile") {
          setExecutionPrice({ kind: "error" });
          return;
        }
        setExecutionPrice(row && typeof row.id === "string" && row.status === "approved" &&
            row.admissible === true ? { kind: "ready", id: row.id } : { kind: "none" });
      })
      .catch(() => { if (active) setExecutionPrice({ kind: "error" }); });
    return () => { active = false; };
  }, [analysisBudgetAvailable, preview.kind]);

  const buildPreview = async () => {
    if (!build?.draft || !selected || !selectedEffort || building || ideaId !== null) return;
    const requestId = crypto.randomUUID();
    const previewId = crypto.randomUUID();
    // The preview half is recorded before the request, keyed by the submission
    // request id; the input panel records the submission attempt itself.
    if (!reserveBuildPreviewReceipt(receiptStore(), operatorId, requestId,
      { previewId, model: selected, effort: selectedEffort })) {
      setFailure({ message: m.buildPreviewRecoveryUnavailable, tone: "error",
        requiresReauthentication: false, approvalId: null });
      return;
    }
    if (!build.reserve(requestId)) {
      takeBuildPreviewReceipt(receiptStore(), operatorId, requestId);
      return;
    }
    setBuilding(true);
    setFailure(null);
    try {
      // Three transactions one after the other (save, plan, preview): the deadline outlasts all three.
      const response = await adminFetch("/api/admin/amux/ideas/build-preview", {
        method: "POST", headers: { "content-type": "application/json" },
        timeoutMs: AMUX_IDEA_BUILD_PREVIEW_REQUEST_TIMEOUT_MS,
        body: JSON.stringify({ version: 1, requestId, previewId,
          input: { version: 1, ...build.draft },
          model: { provider: selected.provider, modelId: selected.modelId, reasoningEffort: selectedEffort,
            approvalId: selected.approvalId, approvalVersion: selected.approvalVersion } }),
      });
      const answer = classifyBuildPreviewAnswer(response.status, await response.json().catch(() => null));
      if (answer.kind === "saved") {
        // Saved, and the chain answered for every step after it: only a preview
        // that was prepared, or whose outcome is unknown, keeps its receipt,
        // recovered once this panel remounts for the saved idea.
        const receipt = takeBuildPreviewReceipt(receiptStore(), operatorId, requestId);
        if (answer.previewMayExist && receipt) {
          reservePreviewReceipt(receiptStore(), operatorId, answer.ideaId, receipt.previewId,
            receipt.model, receipt.effort, 0);
        }
        build.onBuilt({ requestId, ideaId: answer.ideaId, hasExternalSources: answer.hasExternalSources,
          planReady: answer.planReady });
        return;
      }
      if (answer.kind === "refused") {
        takeBuildPreviewReceipt(receiptStore(), operatorId, requestId);
        build.onRefused(requestId, answer.code);
        return;
      }
      // Unknown: the receipt stays, and the submission read-back links it.
      build.onUnknown(requestId);
    } catch {
      build.onUnknown(requestId);
    } finally {
      setBuilding(false);
    }
  };

  const approveExecution = async () => {
    if (!confirmAvailable || !ideaId || preview.kind !== "prepared" ||
        confirmation.kind !== "idle" || !executionPriceId) return;
    const value = preview.value;
    if (!reserveConfirmationAttempt(receiptStore(), operatorId, value.previewId,
      ideaId, value.payloadDigest, value.payloadDigestKeyId)) {
      setConfirmation({ kind: "unknown" });
      await readConfirmation(value.previewId, ideaId, value.payloadDigest,
        value.payloadDigestKeyId);
      return;
    }
    setConfirmation({ kind: "pending" });
    setFailure(null);
    setExecutionRefusal(null);
    try {
      // The approval transaction may run for 20 s after a 5 s wait; the deadline outlasts it.
      const response = await adminFetch("/api/admin/amux/ideas/execution-approval", {
        method: "POST", headers: { "content-type": "application/json" },
        timeoutMs: AMUX_IDEA_EXECUTION_APPROVAL_REQUEST_TIMEOUT_MS,
        body: JSON.stringify({ version: 1, previewId: value.previewId, ideaId,
          payloadDigest: value.payloadDigest, payloadDigestKeyId: value.payloadDigestKeyId,
          holdId: crypto.randomUUID(), priceVersionId: executionPriceId }),
      });
      // A 409 is a refusal inside the one transaction: nothing was recorded.
      // Its reason is shown, and the monthly budget one says what to change.
      if (response.status === 409) {
        const refusal: unknown = await response.clone().json().catch(() => null);
        const row = refusal && typeof refusal === "object" ? refusal as Record<string, unknown> : {};
        if (row.error === "budget_hold" && row.reason === "monthly_cap_exceeded") {
          setExecutionRefusal(budgetMessages.monthlyExceeded);
        } else {
          setFailure(await readAdminApiFailure(response, { fallback: m.transferConfirmRefused, locale }));
        }
        clearRefusedConfirmationAttempt(receiptStore(), operatorId, value.previewId,
          ideaId, value.payloadDigest, value.payloadDigestKeyId);
        setConfirmation((current) => current.kind === "confirmed" ? current : { kind: "refused" });
        return;
      }
      if ([400, 401, 403, 404, 413, 415, 428].includes(response.status)) {
        setFailure(await readAdminApiFailure(response, { fallback: m.transferConfirmRefused, locale }));
        clearRefusedConfirmationAttempt(receiptStore(), operatorId, value.previewId,
          ideaId, value.payloadDigest, value.payloadDigestKeyId);
        setConfirmation((current) => current.kind === "confirmed" ? current : { kind: "refused" });
        return;
      }
    } catch { /* A lost response must be read back by ID, not re-posted. */ }
    // Success, a refusal of the decision or a lost response: the exact-ID
    // read-back says what was recorded, and the budget panel then shows the hold.
    await readConfirmation(value.previewId, ideaId, value.payloadDigest,
      value.payloadDigestKeyId);
  };

  const confirmPreview = async () => {
    if (!confirmAvailable || !ideaId || preview.kind !== "prepared" ||
        confirmation.kind !== "idle") return;
    const value = preview.value;
    if (!reserveConfirmationAttempt(receiptStore(), operatorId, value.previewId,
      ideaId, value.payloadDigest, value.payloadDigestKeyId)) {
      setConfirmation({ kind: "unknown" });
      await readConfirmation(value.previewId, ideaId, value.payloadDigest,
        value.payloadDigestKeyId);
      return;
    }
    setConfirmation({ kind: "pending" });
    setFailure(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/transfer-confirmation", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, previewId: value.previewId, ideaId,
          payloadDigest: value.payloadDigest,
          payloadDigestKeyId: value.payloadDigestKeyId }),
      });
      if (response.status === 409) {
        await readConfirmation(value.previewId, ideaId, value.payloadDigest,
          value.payloadDigestKeyId);
        return;
      }
      if ([400, 401, 403, 404, 410, 413, 415, 428].includes(response.status)) {
        const refusal = await readAdminApiFailure(response, {
          fallback: m.transferConfirmRefused, locale,
        });
        setFailure(refusal);
        if (response.status !== 410) {
          clearRefusedConfirmationAttempt(receiptStore(), operatorId, value.previewId,
            ideaId, value.payloadDigest, value.payloadDigestKeyId);
        }
        setConfirmation((current) => current.kind === "confirmed" ? current :
          { kind: response.status === 410 ? "expired" : "refused" });
        return;
      }
      const body: unknown = await response.json();
      const parsed = readConfirmedIdeaTransfer(response.status, body, value.previewId,
        ideaId, value.payloadDigest, value.payloadDigestKeyId);
      if (parsed) { setConfirmation({ kind: "confirmed", value: parsed }); return; }
    } catch { /* A lost response must be read back by ID, not re-posted. */ }
    await readConfirmation(value.previewId, ideaId, value.payloadDigest,
      value.payloadDigestKeyId);
  };

  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      aria-labelledby="amux-v4-frontier-models-heading">
      <h3 id="amux-v4-frontier-models-heading" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        {m.executionCardTitle}
      </h3>
      {/* Without an approved price there is no budget reservation: only the separate confirmation. */}
      <p className="text-zinc-700 dark:text-zinc-300">
        {executionPrice.kind === "none" ? m.executionCardLeadConfirmOnly : m.executionCardLead}
      </p>
      <h4 className="pt-2 font-semibold text-zinc-900 dark:text-zinc-100">{m.executionStepModel}</h4>
      <p className="text-zinc-700 dark:text-zinc-300">{m.frontierModelsHint}</p>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {m.frontierSettingsMoved}{" "}
        <Link href="/admin/amux-settings?tab=analysis" className="font-medium underline">{m.frontierSettingsLink}</Link>
      </p>
      {!available ? <p>{m.frontierModelsUnavailable}</p> : null}
      {available ? <button type="button" onClick={refresh} disabled={loading || checking}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
        {m.frontierModelsRefresh}
      </button> : null}
      {loading ? <p role="status">{m.frontierModelsLoading}</p> : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
      {models?.length === 0 ? <p role="status">{m.frontierModelsEmpty}</p> : null}
      {models && models.length > 0 ? (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            {m.frontierSelectionModel}
            <select value={selectedApprovalId} disabled={checking}
              onChange={(event) => { setSelectedApprovalId(event.target.value); setSelectedEffort(""); setChecked(false); }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 dark:border-zinc-600 dark:bg-zinc-900">
              <option value="">{m.frontierSelectionChoose}</option>
              {models.map((model) => <option key={model.approvalId} value={model.approvalId}>
                {model.provider} / {model.modelId}
              </option>)}
            </select>
          </label>
          {selected ? <label className="flex flex-col gap-1">
            {m.frontierModelsEfforts}
            <select value={selectedEffort} disabled={checking}
              onChange={(event) => { setSelectedEffort(event.target.value); setChecked(false); }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 dark:border-zinc-600 dark:bg-zinc-900">
              <option value="">{m.frontierSelectionChoose}</option>
              {selected.allowedEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label> : null}
          <button type="button" onClick={() => void checkSelection()}
            disabled={!selected || !selectedEffort || checking}
            className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
            {m.frontierSelectionCheck}
          </button>
          {checked ? <p role="status">{m.frontierSelectionCurrent}</p> : null}
          {ideaId === null && build ? <div className="space-y-2">
            <p className="text-xs">{m.buildPreviewHint}</p>
            <button type="button" onClick={() => void buildPreview()}
              disabled={!build.draft || !selected || !selectedEffort || building || !previewAvailable}
              className="min-h-11 rounded-lg border border-blue-700 bg-blue-700 px-4 text-white disabled:opacity-50 dark:border-blue-400">
              {m.buildPreviewAction}
            </button>
            {building ? <p role="status">{m.buildPreviewPending}</p> : null}
          </div> : null}
          {ideaId ? <button type="button" onClick={() => void preparePreview()}
            disabled={!previewAvailable || !planReady || declaredExternalSources ||
              !checked || preview.kind !== "idle"}
            className="min-h-11 rounded-lg border border-blue-700 px-4 text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
            {m.transferPreviewPrepare}
          </button> : null}
        </div>
      ) : null}
      {ideaId && !previewAvailable ? <p>{m.transferPreviewUnavailable}</p> : null}
      {ideaId && previewAvailable && declaredExternalSources ?
        <p>{m.transferPreviewIdeaOnly}</p> : null}
      {ideaId && previewAvailable && !declaredExternalSources && !planReady ?
        <p>{m.transferPreviewPlanRequired}</p> : null}
      {preview.kind === "pending" ? <p role="status">{m.transferPreviewPreparing}</p> : null}
      {preview.kind === "recovery_unavailable" ? <p role="alert">{m.recoveryUnavailable}</p> : null}
      {preview.kind === "expired" ? <p role="status">{m.transferPreviewExpired}</p> : null}
      {preview.kind === "unknown" && confirmation.kind === "idle" ? <div className="space-y-2">
        <p role="alert">{m.transferPreviewUnknown}</p>
        <button type="button" onClick={recoverPreview} className="min-h-11 rounded-lg border border-zinc-400 px-4 dark:border-zinc-600">
          {m.transferPreviewReadBack}
        </button>
      </div> : null}
      {preview.kind === "prepared" ? (
        <div className="space-y-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
          <h4 className="pt-2 font-semibold text-zinc-900 dark:text-zinc-100">{m.executionStepTransfer}</h4>
          <p role="status">{m.transferPreviewPrepared}</p>
          <p className="break-all text-xs">{preview.value.provider} / {preview.value.modelId}
            {` · ${preview.value.reasoningEffort} · ${preview.value.previewId}`}</p>
          <p className="text-xs">{m.transferPreviewExpires}: {preview.value.expiresAt}</p>
          <p className="break-all text-xs">{m.transferPreviewDigest}: {preview.value.payloadDigest}</p>
          <details className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
            <summary className="min-h-11 cursor-pointer content-center font-medium">{m.executionTransferShow}</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
              {preview.value.prompt}
            </pre>
          </details>
          <h4 className="pt-2 font-semibold text-zinc-900 dark:text-zinc-100">{m.executionStepApprove}</h4>
          <p>{confirmation.kind === "confirmed" ? m.transferConfirmRecordedBoundary :
            m.transferPreviewBoundary}</p>
          {confirmAvailable && confirmation.kind === "idle" && executionPrice.kind === "loading" ?
            <p role="status">{m.executionApprovalPriceLoading}</p> : null}
          {confirmAvailable && confirmation.kind === "idle" && executionPrice.kind === "error" ?
            <p role="alert">{m.executionApprovalPriceUnavailable}</p> : null}
          {confirmAvailable && confirmation.kind === "idle" && executionPriceId ? <>
            <p>{budgetMessages.price}</p>
            <p className="text-xs">{m.executionApprovalBoundary}</p>
            <button type="button" onClick={() => void approveExecution()}
              className="min-h-11 rounded-lg border border-blue-700 bg-blue-700 px-4 text-white dark:border-blue-400">
              {m.executionApprovalAction}
            </button>
          </> : null}
          {confirmAvailable && confirmation.kind === "idle" && executionPrice.kind === "none" ? <button type="button"
            onClick={() => void confirmPreview()}
            className="min-h-11 rounded-lg border border-blue-700 px-4 text-blue-800 dark:border-blue-400 dark:text-blue-200">
            {m.transferConfirmAction}
          </button> : null}
        </div>
      ) : null}
      {confirmation.kind === "pending" ? <p role="status">{m.transferConfirmPending}</p> : null}
      {executionRefusal ? <p role="alert">{executionRefusal}</p> : null}
      {confirmation.kind === "confirmed" ? <p role="status">{m.transferConfirmRecorded}</p> : null}
      {confirmation.kind === "confirmed" ? <AmuxAnalysisBudgetPanel
        key={confirmation.value.previewId} confirmed={confirmation.value}
        available={analysisBudgetAvailable} /> : null}
      {confirmation.kind === "expired" ? <p role="status">{m.transferConfirmExpired}</p> : null}
      {confirmation.kind === "refused" && !failure ?
        <p role="alert">{m.transferConfirmRefused}</p> : null}
      {confirmation.kind === "unknown" ? <div className="space-y-2">
        <p role="alert">{m.transferConfirmUnknown}</p>
        <button type="button" onClick={() => {
          const receipt = ideaId ? readPreviewReceipt(receiptStore(), operatorId,
            ideaId, chunkIndex) : null;
          const attempt = receipt?.kind === "present" && ideaId ?
            readConfirmationAttemptForPreview(receiptStore(), operatorId,
              receipt.previewId, ideaId) : null;
          if (receipt?.kind === "present" && attempt?.kind === "present" && ideaId) {
            void readConfirmation(receipt.previewId, ideaId,
              attempt.payloadDigest, attempt.payloadDigestKeyId);
          } else { setPreview({ kind: "recovery_unavailable" }); }
        }} className="min-h-11 rounded-lg border border-zinc-400 px-4 dark:border-zinc-600">
          {m.transferConfirmReadBack}
        </button>
      </div> : null}
    </section>
  );
}
