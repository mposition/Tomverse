"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import type { CheckedCollectionModel } from "@/components/admin/AmuxFrontierModelsPanel";
import type { ApprovedCollectionScope } from "@/components/admin/AmuxSourceScopeApprovalPanel";
import { readAdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  canReplaceTerminalCollectionRequest, collectionPreviewDisplayDeadline,
  formatCollectionTimestamp, oneRepositoryFile, readCollectionExactPreview,
  readCollectionRequestReceipt, readCollectionRequestReply,
  replaceTerminalCollectionRequestReceipt, reserveCollectionRequestReceipt,
  type CollectionRequestReceipt,
  type CollectionExactPreview,
} from "@/lib/amux/ideaCollectionRequestUiCore";

type State =
  | { kind: "idle" | "pending" | "storage_unavailable" | "scope_expired" }
  | { kind: "recorded"; receipt: CollectionRequestReceipt; id: string;
      state: string; expiresAt: string; verifiedAtMs: number | null }
  | { kind: "outcome_unknown"; receipt: CollectionRequestReceipt;
      reauthRequired?: boolean; failureMessage?: string };
type PreviewState = { kind: "idle" | "pending" | "unavailable" | "expired" } |
  { kind: "ready"; value: CollectionExactPreview };

const receiptStore = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

/** Requests one bounded GitHub read; this panel neither fetches it nor sends it to a model. */
export function AmuxCollectionRequestPanel({ ideaId, operatorId, canonicalScopeJson,
  approvedScope, model, available, previewReadAvailable }: {
  ideaId: string; operatorId: string; canonicalScopeJson: string;
  approvedScope: ApprovedCollectionScope;
  model: CheckedCollectionModel; available: boolean; previewReadAvailable: boolean;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const { locale } = useAdminLocale();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const previewVersion = useRef(0);
  const source = oneRepositoryFile(canonicalScopeJson);
  const sameSelection = (receipt: CollectionRequestReceipt) =>
    receipt.ideaId === ideaId && receipt.scopeApprovalId === approvedScope.approvalId &&
    receipt.scopeDigest === approvedScope.scopeDigest &&
    receipt.frontierApprovalId === model.approvalId &&
    receipt.frontierVersion === model.approvalVersion &&
    receipt.provider === model.provider && receipt.modelId === model.modelId &&
    receipt.reasoningEffort === model.reasoningEffort;
  const canReplace = state.kind === "recorded" && state.verifiedAtMs !== null &&
    canReplaceTerminalCollectionRequest(state.receipt, {
      kind: "committed", id: state.id, state: state.state, expiresAt: state.expiresAt,
    }, approvedScope.approvalId, state.verifiedAtMs);
  const stateLabels: Record<string, string> = {
    pending: m.collectionRequestStatusPending,
    claimed: m.collectionRequestStatusClaimed,
    preview_ready: m.collectionRequestStatusPreviewReady,
    hold: m.collectionRequestStatusHold,
    expired: m.collectionRequestStatusExpired,
    outcome_unknown: m.collectionRequestStatusOutcomeUnknown,
  };
  const visiblePreview = preview.kind === "ready" && state.kind === "recorded" &&
    sameSelection(state.receipt);

  useEffect(() => {
    if (preview.kind !== "ready") return;
    const deadline = collectionPreviewDisplayDeadline(preview.value);
    if (!visiblePreview || deadline === null || deadline <= Date.now()) {
      queueMicrotask(() => setPreview((current) => current === preview ?
        { kind: "expired" } : current));
      return;
    }
    const timer = window.setTimeout(() => setPreview((current) => current === preview ?
      { kind: "expired" } : current), deadline - Date.now());
    return () => window.clearTimeout(timer);
  }, [preview, visiblePreview]);

  const readBack = useCallback(async (receipt: CollectionRequestReceipt) => {
    if (!available || inFlight.current) return;
    previewVersion.current += 1;
    inFlight.current = true;
    setState({ kind: "pending" });
    setPreview({ kind: "idle" });
    try {
      const query = new URLSearchParams({ requestId: receipt.requestId });
      const response = await adminFetch(`/api/admin/amux/ideas/collection-requests?${query}`,
        { cache: "no-store" });
      const failure = response.ok ? null : await readAdminApiFailure(response.clone(), {
        fallback: m.collectionRequestUnavailable, locale,
      });
      const reply: unknown = await response.json();
      if (!mounted.current) return;
      const decision = readCollectionRequestReply(response.status, reply, receipt, "read");
      setState(decision.kind === "committed"
        ? { kind: "recorded", receipt, id: decision.id,
          state: decision.state, expiresAt: decision.expiresAt,
          verifiedAtMs: Date.now() }
        : { kind: "outcome_unknown", receipt,
          reauthRequired: failure?.requiresReauthentication,
          failureMessage: failure?.message });
    } catch {
      if (mounted.current) setState({ kind: "outcome_unknown", receipt });
    } finally { inFlight.current = false; }
  }, [available, locale, m.collectionRequestUnavailable]);

  useEffect(() => {
    mounted.current = true;
    const recovered = readCollectionRequestReceipt(receiptStore(), operatorId, ideaId);
    queueMicrotask(() => {
      if (!mounted.current) return;
      if (recovered.kind === "unavailable") setState({ kind: "storage_unavailable" });
      else if (recovered.kind === "present") {
        setState({ kind: "outcome_unknown", receipt: recovered.receipt });
        void readBack(recovered.receipt);
      } else setState({ kind: "idle" });
    });
    return () => { mounted.current = false; };
  }, [ideaId, operatorId, readBack]);

  const submit = async () => {
    if (!available || !source || (state.kind !== "idle" && !canReplace) || inFlight.current ||
        approvedScope.ideaId !== ideaId ||
        !model.allowedEfforts.includes(model.reasoningEffort)) return;
    if (!Number.isFinite(Date.parse(approvedScope.expiresAt)) ||
        Date.now() >= Date.parse(approvedScope.expiresAt)) {
      setState({ kind: "scope_expired" });
      return;
    }
    let requestId: string;
    let previewId: string;
    try { requestId = crypto.randomUUID(); previewId = crypto.randomUUID(); }
    catch { setState({ kind: "storage_unavailable" }); return; }
    const receipt: CollectionRequestReceipt = {
      requestId, previewId, ideaId,
      scopeApprovalId: approvedScope.approvalId, scopeDigest: approvedScope.scopeDigest,
      frontierApprovalId: model.approvalId, frontierVersion: model.approvalVersion,
      provider: model.provider, modelId: model.modelId,
      reasoningEffort: model.reasoningEffort,
    };
    const stored = state.kind === "recorded" && canReplace && state.verifiedAtMs !== null
      ? replaceTerminalCollectionRequestReceipt(receiptStore(), operatorId,
        state.receipt, { kind: "committed", id: state.id, state: state.state,
          expiresAt: state.expiresAt }, receipt, state.verifiedAtMs)
      : reserveCollectionRequestReceipt(receiptStore(), operatorId, receipt);
    if (!stored) {
      setState({ kind: "storage_unavailable" });
      return;
    }
    inFlight.current = true;
    setState({ kind: "pending" });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/collection-requests", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, requestId, previewId, ideaId,
          scopeApprovalId: approvedScope.approvalId,
          frontierApprovalId: model.approvalId,
          frontierVersion: model.approvalVersion,
          provider: model.provider, modelId: model.modelId,
          reasoningEffort: model.reasoningEffort, sourceIndex: 0 }),
      });
      const failure = response.ok ? null : await readAdminApiFailure(response.clone(), {
        fallback: m.collectionRequestUnavailable, locale,
      });
      const reply: unknown = await response.json();
      if (!mounted.current) return;
      const decision = readCollectionRequestReply(response.status, reply, receipt, "write");
      if (decision.kind === "committed") {
        setState({ kind: "recorded", receipt, id: decision.id, state: decision.state,
          expiresAt: decision.expiresAt, verifiedAtMs: null });
        return;
      }
      setState({ kind: "outcome_unknown", receipt,
        reauthRequired: failure?.requiresReauthentication,
        failureMessage: failure?.message });
    } catch {
      if (mounted.current) setState({ kind: "outcome_unknown", receipt });
    } finally {
      inFlight.current = false;
    }
    // A POST timeout/refusal may have committed. The retained ID is the only recovery path.
    if (mounted.current) void readBack(receipt);
  };

  const showExactPreview = async () => {
    if (!previewReadAvailable || !source || state.kind !== "recorded" ||
        state.state !== "preview_ready" || preview.kind === "pending") return;
    const receipt = state.receipt;
    const collectionRequestId = state.id;
    const version = ++previewVersion.current;
    setPreview({ kind: "pending" });
    try {
      const query = new URLSearchParams({ requestId: receipt.requestId });
      const response = await adminFetch(`/api/admin/amux/ideas/collection-preview?${query}`,
        { cache: "no-store" });
      const body: unknown = await response.json();
      if (!mounted.current || version !== previewVersion.current) return;
      const result = readCollectionExactPreview(response.status, body, receipt,
        collectionRequestId, source);
      const deadline = result ? collectionPreviewDisplayDeadline(result) : null;
      setPreview(result && deadline !== null && deadline > Date.now()
        ? { kind: "ready", value: result } : { kind: "unavailable" });
    } catch {
      if (mounted.current && version === previewVersion.current) {
        setPreview({ kind: "unavailable" });
      }
    }
  };

  return <section className="space-y-3 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
    aria-labelledby="amux-v4-collection-request-heading">
    <h3 id="amux-v4-collection-request-heading" className="font-semibold">
      {m.collectionRequestTitle}
    </h3>
    <p>{m.collectionRequestBoundary}</p>
    {source ? <div className="break-all rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
      <p>{source.repository} · {source.path}</p><p>{source.commitSha}</p>
      <p>{model.provider} / {model.modelId} · {model.reasoningEffort}</p>
    </div> : <p role="status">{m.collectionRequestUnsupported}</p>}
    {!available ? <p role="status">{m.collectionRequestUnavailable}</p> : null}
    {state.kind === "idle" && source ? <button type="button" onClick={() => void submit()}
      disabled={!available}
      className="min-h-11 rounded-lg border border-blue-700 px-4 font-medium text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
      {m.collectionRequestAction}
    </button> : null}
    {canReplace && source ? <button type="button" onClick={() => void submit()}
      disabled={!available}
      className="min-h-11 rounded-lg border border-blue-700 px-4 font-medium text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
      {m.collectionRequestNewApprovalAction}
    </button> : null}
    {state.kind === "scope_expired" ? <p role="alert">{m.collectionRequestScopeExpired}</p> : null}
    {state.kind === "pending" ? <p role="status">{m.collectionRequestPending}</p> : null}
    {state.kind === "recorded" ? <div role="status" className="space-y-1">
      <p>{m.collectionRequestRecorded(state.receipt.requestId)}</p>
      <p>{m.collectionRequestState(stateLabels[state.state] ?? m.collectionRequestStatusOutcomeUnknown,
        formatCollectionTimestamp(state.expiresAt, locale))}</p>
      {!sameSelection(state.receipt) ? <p>{m.collectionRequestSelectionChanged}</p> : null}
      <button type="button" onClick={() => void readBack(state.receipt)}
        disabled={!available}
        className="min-h-11 rounded-lg border border-zinc-400 px-3 disabled:opacity-50 dark:border-zinc-600">
        {m.collectionRequestReadBack}
      </button>
      {state.state === "preview_ready" ? <button type="button"
        onClick={() => void showExactPreview()} disabled={!previewReadAvailable || !source}
        className="min-h-11 rounded-lg border border-blue-700 px-3 text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
        {m.collectionPreviewOpen}
      </button> : null}
    </div> : null}
    {state.kind === "recorded" && state.state === "preview_ready" && !previewReadAvailable ?
      <p role="status">{m.collectionPreviewDisabled}</p> : null}
    {preview.kind === "pending" ? <p role="status">{m.collectionPreviewLoading}</p> : null}
    {preview.kind === "unavailable" ? <p role="alert">{m.collectionPreviewUnavailable}</p> : null}
    {preview.kind === "expired" ? <p role="status">{m.collectionPreviewExpired}</p> : null}
    {visiblePreview && preview.kind === "ready" ? <div className="space-y-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
      <p role="status" className="font-semibold">{m.collectionPreviewNotSent}</p>
      <p>{m.collectionPreviewIncluded(preview.value.selectedSourceIndices.length,
        preview.value.unselectedSourceCount)}</p>
      <p className="break-all">{preview.value.model.provider} / {preview.value.model.modelId} · {preview.value.model.reasoningEffort}</p>
      <p className="break-all">{m.collectionPreviewProvenance}: {preview.value.provenance}</p>
      <p className="break-all">{preview.value.source.repository} / {preview.value.source.path}</p>
      <p className="break-all">{preview.value.source.refName} · {preview.value.source.commitSha} · {preview.value.source.blobSha}</p>
      <p className="break-all">SHA-256: {preview.value.source.fileSha256} · {preview.value.source.startByte}–{preview.value.source.endByte}</p>
      <p className="break-all">{m.collectionPreviewDigest}: {preview.value.resultDigest}</p>
      <p>{m.collectionPreviewExpires}: {formatCollectionTimestamp(preview.value.expiresAt, locale)}</p>
      <p>{m.collectionPreviewPurge}: {formatCollectionTimestamp(preview.value.resultPurgeAfter, locale)}</p>
      <p>{m.collectionPreviewPromptVersion}: {preview.value.promptVersion}</p>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
        {preview.value.prompt}
      </pre>
      <p>{m.collectionPreviewBoundary}</p>
    </div> : null}
    {state.kind === "outcome_unknown" ? <div role="alert" className="space-y-2">
      <p>{m.collectionRequestUnknown(state.receipt.requestId)}</p>
      {state.failureMessage ? <p>{state.failureMessage}</p> : null}
      {!sameSelection(state.receipt) ? <p>{m.collectionRequestSelectionChanged}</p> : null}
      {state.reauthRequired ? <a className="block underline"
        href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>{m.stepUp}</a> : null}
      <button type="button" onClick={() => void readBack(state.receipt)} disabled={!available}
        className="min-h-11 rounded-lg border border-zinc-400 px-3 disabled:opacity-50 dark:border-zinc-600">
        {m.collectionRequestReadBack}
      </button>
    </div> : null}
    {state.kind === "storage_unavailable" ? <p role="alert">
      {m.collectionRequestStorageUnavailable}</p> : null}
  </section>;
}
