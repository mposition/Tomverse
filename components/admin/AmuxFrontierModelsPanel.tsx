"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { AmuxAnalysisBudgetPanel } from "@/components/admin/AmuxAnalysisBudgetPanel";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminAmuxAnalysisBudgetMessages } from "@/lib/adminMessages/amuxAnalysisBudget";
import {
  readAvailableFrontierModels,
  readCheckedFrontierSelection,
  type AvailableFrontierModel,
} from "@/lib/amux/ideaFrontierCatalogUiCore";
import {
  clearRefusedPreviewReceipt,
  readPreparedIdeaTransferPreview, readPreviewReceipt, readPreviewWriteReply,
  replacePreviewReceipt,
  reservePreviewReceipt,
  type PreparedIdeaTransferPreview,
} from "@/lib/amux/ideaTransferPreviewUiCore";
import {
  clearRefusedConfirmationAttempt, readConfirmedIdeaTransfer, readConfirmationAttempt,
  readConfirmationAttemptForPreview, readConfirmationWriteReply,
  readExpiredIdeaTransferConfirmation, reserveConfirmationAttempt,
  type ConfirmedIdeaTransfer,
} from "@/lib/amux/ideaTransferConfirmationUiCore";

type PreviewState =
  | { kind: "idle" | "pending" | "unknown" | "expired" | "confirmed" | "recovery_unavailable" }
  | { kind: "prepared"; value: PreparedIdeaTransferPreview };
type ConfirmState =
  | { kind: "idle" | "pending" | "unknown" | "expired" | "refused" }
  | { kind: "confirmed"; value: ConfirmedIdeaTransfer };

export type CheckedCollectionModel = AvailableFrontierModel & { reasoningEffort: string };

const receiptStore = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

export function AmuxFrontierModelsPanel({ available, previewAvailable, confirmAvailable,
  analysisBudgetAvailable, catalogWriteAvailable, ideaId, planReady, continuationSelection,
  declaredExternalSources, operatorId, onCheckedCollectionModel }: {
  available: boolean; previewAvailable: boolean; confirmAvailable: boolean;
  analysisBudgetAvailable: boolean;
  catalogWriteAvailable: boolean;
  ideaId: string | null;
  continuationSelection?: { chunkIndex: number; pinnedTargetRefs: string[] } | null;
  planReady: boolean; declaredExternalSources: boolean; operatorId: string;
  onCheckedCollectionModel?: (model: CheckedCollectionModel | null) => void;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const cost = useAdminMessages(adminAmuxAnalysisBudgetMessages);
  const { locale } = useAdminLocale();
  const [models, setModels] = useState<AvailableFrontierModel[] | null>(null);
  const [loading, setLoading] = useState(available);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [checking, setChecking] = useState(false);
  const [catalogConfirm, setCatalogConfirm] = useState(false);
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogUnknownId, setCatalogUnknownId] = useState<string | null>(null);
  const [catalogApproved, setCatalogApproved] = useState(false);
  const [checked, setChecked] = useState(false);
  const selectionVersion = useRef(0);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [confirmation, setConfirmation] = useState<ConfirmState>({ kind: "idle" });
  const selected = models?.find((model) => model.approvalId === selectedApprovalId);
  const opusApproved = models?.some((model) => model.provider === "anthropic" &&
    model.modelId === "claude-opus-5-5" && model.allowedEfforts.includes("high"));
  const receiptScopeId = ideaId && continuationSelection ?
    `${ideaId}:c${continuationSelection.chunkIndex}` : ideaId;

  useEffect(() => {
    queueMicrotask(() => {
      setPreview({ kind: "idle" });
      setConfirmation({ kind: "idle" });
    });
  }, [continuationSelection?.chunkIndex]);

  useEffect(() => {
    selectionVersion.current += 1;
    onCheckedCollectionModel?.(null);
    return () => { selectionVersion.current += 1; };
  }, [ideaId, onCheckedCollectionModel]);

  const readConfirmation = useCallback(async (pendingId: string,
    expectedIdeaId: string, expectedDigest: string, expectedDigestKeyId: string):
    Promise<"confirmed" | "not_confirmed" | "expired_unconfirmed" |
      "expired_confirmed" | "unknown"> => {
    const report = (next: ConfirmState) => setConfirmation((current) =>
      current.kind === "confirmed" ? current : next);
    try {
      const query = new URLSearchParams({ previewId: pendingId });
      const response = await adminFetch(`/api/admin/amux/ideas/transfer-confirmation?${query}`,
        { cache: "no-store" });
      if (!response.ok) { report({ kind: "unknown" }); return "unknown"; }
      const body: unknown = await response.json();
      const parsed = readConfirmedIdeaTransfer(response.status, body, pendingId,
        expectedIdeaId, expectedDigest, expectedDigestKeyId);
      if (parsed) {
        report({ kind: "confirmed", value: parsed });
        setPreview((current) => current.kind === "prepared" ? current : { kind: "confirmed" });
        return "confirmed";
      }
      const expired = readExpiredIdeaTransferConfirmation(response.status, body,
        pendingId, expectedIdeaId);
      if (expired !== null) {
        report({ kind: "expired" });
        return expired === "confirmed" ? "expired_confirmed" : "expired_unconfirmed";
      }
      if (body && typeof body === "object" &&
                 (body as Record<string, unknown>).state === "not_confirmed") {
        report({ kind: "unknown" });
        return "not_confirmed";
      } else { report({ kind: "unknown" }); return "unknown"; }
    } catch { report({ kind: "unknown" }); return "unknown"; }
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
        model, effort);
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
  }, [confirmAvailable, ideaId, locale, m.transferPreviewUnknown, operatorId, readConfirmation]);

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
    const receipt = readPreviewReceipt(receiptStore(), operatorId, receiptScopeId ?? ideaId);
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
  }, [ideaId, operatorId, previewAvailable, readBack, receiptScopeId]);

  const refresh = () => {
    selectionVersion.current += 1;
    onCheckedCollectionModel?.(null);
    setChecking(false);
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
    const version = selectionVersion.current;
    setChecking(true);
    setChecked(false);
    onCheckedCollectionModel?.(null);
    setFailure(null);
    try {
      const params = new URLSearchParams({ mode: "check", provider: selected.provider,
        modelId: selected.modelId, reasoningEffort: selectedEffort });
      const response = await adminFetch(`/api/admin/amux/ideas/frontier-models?${params}`,
        { cache: "no-store" });
      if (!response.ok) {
        const reason = await readAdminApiFailure(response, {
          fallback: m.frontierSelectionUnavailable, locale,
        });
        if (version === selectionVersion.current) setFailure(reason);
        return;
      }
      const result = readCheckedFrontierSelection(response.status, await response.json(), selected);
      if (version !== selectionVersion.current) return;
      if (!result) {
        setFailure({ message: m.frontierModelsInvalid, tone: "error",
          requiresReauthentication: false, approvalId: null });
        return;
      }
      setChecked(true);
      onCheckedCollectionModel?.({ ...selected, reasoningEffort: selectedEffort });
    } catch {
      if (version === selectionVersion.current) {
        setFailure({ message: m.frontierSelectionUnavailable, tone: "error",
          requiresReauthentication: false, approvalId: null });
      }
    } finally { if (version === selectionVersion.current) setChecking(false); }
  };

  const preparePreview = async () => {
    if (!ideaId || !previewAvailable || !planReady || declaredExternalSources ||
        !selected || !checked ||
        !selected.allowedEfforts.includes(selectedEffort) ||
        (preview.kind !== "idle" && preview.kind !== "expired")) return;
    const model = selected;
    const effort = selectedEffort;
    const previewId = crypto.randomUUID();
    const previous = preview.kind === "expired"
      ? readPreviewReceipt(receiptStore(), operatorId, receiptScopeId ?? ideaId) : null;
    if (previous?.kind === "present" &&
        readConfirmationAttemptForPreview(receiptStore(), operatorId,
          previous.previewId, ideaId).kind !== "absent") {
      setPreview({ kind: "unknown" });
      return;
    }
    const receiptReady = previous?.kind === "present"
      ? replacePreviewReceipt(receiptStore(), operatorId, receiptScopeId ?? ideaId,
        previous.previewId, previewId, model, effort)
      : previous === null && reservePreviewReceipt(receiptStore(), operatorId,
        receiptScopeId ?? ideaId, previewId, model, effort);
    if (!receiptReady) {
      setPreview({ kind: "recovery_unavailable" });
      return;
    }
    setPreview({ kind: "pending" });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/transfer-preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, previewId, ideaId,
          ...(continuationSelection ? { chunkIndex: continuationSelection.chunkIndex,
            ...(continuationSelection.pinnedTargetRefs.length ? {
              pinnedTargetRefs: continuationSelection.pinnedTargetRefs } : {}) } : {}),
          ...(previous?.kind === "present"
            ? { replacesPreviewId: previous.previewId } : {}),
          provider: model.provider, modelId: model.modelId,
          reasoningEffort: effort, approvalId: model.approvalId,
          approvalVersion: model.approvalVersion }),
      });
      const { body, refusalResponse, definitiveRefusal } = await readPreviewWriteReply(response);
      const parsed = readPreparedIdeaTransferPreview(response.status, body,
        previewId, ideaId, model, effort);
      if (parsed) { setPreview({ kind: "prepared", value: parsed }); return; }
      if (definitiveRefusal) {
        const released = previous?.kind === "present"
          ? replacePreviewReceipt(receiptStore(), operatorId, receiptScopeId ?? ideaId,
            previewId, previous.previewId, previous.model, previous.effort)
          : clearRefusedPreviewReceipt(receiptStore(), operatorId,
            receiptScopeId ?? ideaId, previewId);
        if (!released) {
          setPreview({ kind: "unknown" });
          return;
        }
        setFailure(await readAdminApiFailure(refusalResponse, {
          fallback: m.transferPreviewUnknown, locale,
        }));
        if (previous?.kind === "present") {
          // The refused replacement proves nothing about the old preview's
          // current state; restore its receipt and read that exact ID back.
          setPreview({ kind: "pending" });
          await readBack(previous.previewId, previous.model, previous.effort);
        } else {
          setPreview({ kind: "idle" });
        }
        return;
      }
      await readBack(previewId, model, effort);
    } catch { await readBack(previewId, model, effort); }
  };

  const recoverPreview = () => {
    if (!ideaId) return;
    const receipt = readPreviewReceipt(receiptStore(), operatorId, receiptScopeId ?? ideaId);
    if (receipt.kind !== "present") {
      setPreview({ kind: "recovery_unavailable" });
      return;
    }
    setFailure(null);
    setPreview({ kind: "pending" });
    void readBack(receipt.previewId, receipt.model, receipt.effort);
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
      const { body, refusalResponse, definitiveRefusal } = await readConfirmationWriteReply(response);
      const parsed = readConfirmedIdeaTransfer(response.status, body, value.previewId,
        ideaId, value.payloadDigest, value.payloadDigestKeyId);
      if (parsed) { setConfirmation({ kind: "confirmed", value: parsed }); return; }
      if (definitiveRefusal) {
        const observed = response.status === 409
          ? await readConfirmation(value.previewId, ideaId, value.payloadDigest,
            value.payloadDigestKeyId) : null;
        if (response.status === 409 && observed !== "not_confirmed" &&
            observed !== "expired_unconfirmed") return;
        const refusal = await readAdminApiFailure(refusalResponse, {
          fallback: m.transferConfirmRefused, locale,
        });
        if (!clearRefusedConfirmationAttempt(receiptStore(), operatorId, value.previewId,
          ideaId, value.payloadDigest, value.payloadDigestKeyId)) {
          setConfirmation({ kind: "unknown" });
          return;
        }
        setFailure(refusal);
        // Only this POST code proves an unconfirmed prepared preview expired.
        // A GET "expired" may instead describe an already-confirmed receipt.
        const expired = (body as Record<string, unknown>).error === "expired";
        if (expired) setPreview({ kind: "expired" });
        setConfirmation((current) => current.kind === "confirmed" ? current :
          { kind: expired ? "expired" : [428, 429].includes(response.status) ? "idle" : "refused" });
        return;
      }
    } catch { /* A lost response must be read back by ID, not re-posted. */ }
    await readConfirmation(value.previewId, ideaId, value.payloadDigest,
      value.payloadDigestKeyId);
  };

  const approveOpus = async () => {
    if (!catalogWriteAvailable || !available || opusApproved || !catalogConfirm ||
        catalogPending || catalogUnknownId) return;
    const approvalId = crypto.randomUUID();
    setCatalogUnknownId(approvalId);
    setCatalogPending(true);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/frontier-models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, action: "approve", approvalId,
          provider: "anthropic", modelId: "claude-opus-5-5",
          allowedEfforts: ["high"], expectedPreviousVersion: 0,
          ownerConfirmedFrontierEligibility: true }),
      });
      const body: unknown = response.ok ? await response.json() : null;
      if (!body || typeof body !== "object" ||
          (body as Record<string, unknown>).approvalId !== approvalId ||
          (body as Record<string, unknown>).status !== "approved") return;
      await load(); setCatalogApproved(true); setCatalogUnknownId(null);
    } catch { /* Lost response: only read back this ID. */ }
    finally { setCatalogPending(false); }
  };

  const readCatalogApproval = async () => {
    if (!catalogUnknownId || catalogPending) return;
    setCatalogPending(true);
    try {
      const query = new URLSearchParams({ approvalId: catalogUnknownId });
      const response = await adminFetch(`/api/admin/amux/ideas/frontier-models?${query}`,
        { cache: "no-store" });
      const body: unknown = response.ok ? await response.json() : null;
      if (!body || typeof body !== "object" ||
          (body as Record<string, unknown>).state !== "found") return;
      const approval = (body as Record<string, unknown>).approval;
      if (!approval || typeof approval !== "object" ||
          (approval as Record<string, unknown>).id !== catalogUnknownId ||
          (approval as Record<string, unknown>).status !== "approved") return;
      await load(); setCatalogApproved(true); setCatalogUnknownId(null);
    } catch { /* Preserve the unknown state and require another read. */ }
    finally { setCatalogPending(false); }
  };

  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      aria-labelledby="amux-v4-frontier-models-heading">
      <h3 id="amux-v4-frontier-models-heading" className="font-semibold text-zinc-900 dark:text-zinc-100">
        {m.frontierModelsTitle}
      </h3>
      <p className="text-zinc-700 dark:text-zinc-300">{m.frontierModelsHint}</p>
      {continuationSelection ? <p role="status">{m.analysisResultPinPreviewHint}
        {` #${continuationSelection.chunkIndex + 1} · `}
        {continuationSelection.pinnedTargetRefs.join(", ") || "—"}</p> : null}
      {!available ? <p>{m.frontierModelsUnavailable}</p> : null}
      {available ? <button type="button" onClick={refresh} disabled={loading || checking}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
        {m.frontierModelsRefresh}
      </button> : null}
      {loading ? <p role="status">{m.frontierModelsLoading}</p> : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
      {models?.length === 0 ? <p role="status">{m.frontierModelsEmpty}</p> : null}
      {available && catalogWriteAvailable && models && !opusApproved && !catalogUnknownId ?
        <div className="space-y-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
          <label className="flex items-center gap-2"><input type="checkbox"
            checked={catalogConfirm} onChange={(event) => setCatalogConfirm(event.target.checked)} />
            {cost.modelConfirm}</label>
          <button type="button" onClick={() => void approveOpus()}
            disabled={!catalogConfirm || catalogPending}
            className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">
            {cost.modelApprove}
          </button>
        </div> : null}
      {catalogUnknownId ? <div className="space-y-2"><p role="alert">{cost.unknown}</p>
        <button type="button" onClick={() => void readCatalogApproval()}
          disabled={catalogPending} className="min-h-11 rounded-lg border border-zinc-500 px-4">
          {cost.check}
        </button></div> : null}
      {catalogApproved ? <p role="status">{cost.modelApproved}</p> : null}
      {models && models.length > 0 ? (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            {m.frontierSelectionModel}
            <select value={selectedApprovalId} disabled={checking}
              onChange={(event) => { selectionVersion.current += 1; onCheckedCollectionModel?.(null); setSelectedApprovalId(event.target.value); setSelectedEffort(""); setChecked(false); }}
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
              onChange={(event) => { selectionVersion.current += 1; onCheckedCollectionModel?.(null); setSelectedEffort(event.target.value); setChecked(false); }}
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
          {ideaId ? <button type="button" onClick={() => void preparePreview()}
            disabled={!previewAvailable || !planReady || declaredExternalSources ||
              !checked || (preview.kind !== "idle" && preview.kind !== "expired")}
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
          <p role="status">{m.transferPreviewPrepared}</p>
          <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
            {m.transferPreviewIncludedIdeaOnly}
          </p>
          <p className="text-xs text-zinc-700 dark:text-zinc-300">
            {m.transferPreviewExcludedGitHub}
          </p>
          <p className="break-all text-xs">{preview.value.provider} / {preview.value.modelId}
            {` · ${preview.value.reasoningEffort} · ${preview.value.previewId}`}</p>
          <p className="text-xs">{m.transferPreviewExpires}: {preview.value.expiresAt}</p>
          <p className="break-all text-xs">{m.transferPreviewDigest}: {preview.value.payloadDigest}</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
            {preview.value.prompt}
          </pre>
          <p>{confirmation.kind === "confirmed" ? m.transferConfirmRecordedBoundary :
            m.transferPreviewBoundary}</p>
          {confirmAvailable && confirmation.kind === "idle" ? <button type="button"
            onClick={() => void confirmPreview()}
            className="min-h-11 rounded-lg border border-blue-700 px-4 text-blue-800 dark:border-blue-400 dark:text-blue-200">
            {m.transferConfirmAction}
          </button> : null}
        </div>
      ) : null}
      {confirmation.kind === "pending" ? <p role="status">{m.transferConfirmPending}</p> : null}
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
          const receipt = receiptScopeId ? readPreviewReceipt(receiptStore(), operatorId,
            receiptScopeId) : null;
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
