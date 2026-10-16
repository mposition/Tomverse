"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxInitialPlanPanel } from "@/components/admin/AmuxInitialPlanPanel";
import { AmuxFrontierModelsPanel, type AmuxBuildPreviewHooks } from "@/components/admin/AmuxFrontierModelsPanel";
import { AmuxIdeaAnalysisResultPanel } from "@/components/admin/AmuxIdeaAnalysisResultPanel";
import { AmuxIdeaList, type AmuxIdeaProgressRows } from "@/components/admin/AmuxIdeaProgressPanel";
import { AmuxIdeaBusyDialog, type AmuxBusyTone } from "@/components/admin/AmuxIdeaBusyDialog";
import { AmuxIdeaRequestStatusCard, type AmuxIdeaRequestCardState } from "@/components/admin/AmuxIdeaRequestStatusCard";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  canSetAsidePreviousIdea,
  canStartAnotherIdea,
  canOpenSavedIdea,
  classifyIdeaSubmissionPost,
  classifyIdeaSubmissionReadBack,
} from "@/lib/amux/ideaSubmissionUiCore";
import {
  clearConfirmedIdeaRequest,
  clearPendingIdeaRequest,
  forgetIdeaRequestReceipts,
  readConfirmedIdeaRequest,
  readPendingIdeaRequest,
  rememberConfirmedIdeaRequest,
  reservePendingIdeaRequest,
} from "@/lib/amux/ideaSubmissionRecoveryCore";
import { classifySourceScopePreview } from "@/lib/amux/ideaSourceScopePreviewUiCore";
import { setAmuxIdeaUnsavedDraft } from "@/lib/amux/ideaDraftGuard";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas");
const receiptStore = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

type InputPreviewResult = {
  outcome?: "input_checked";
  error?: string;
  ideaWrites?: number;
  transferReady?: boolean;
  ideaBytes?: number;
  repositoryCount?: number;
  pullRequestCount?: number;
};

type SourceScopeResult =
  | { kind: "idle" }
  | { kind: "checked"; canonicalScopeJson: string }
  | { kind: "error"; code: string };

type SubmissionState =
  | { kind: "idle" }
  | { kind: "pending"; requestId: string }
  | { kind: "submitted"; requestId: string; ideaId: string; hasExternalSources: boolean }
  | { kind: "outcome_unknown"; requestId: string }
  | { kind: "recovery_unavailable" }
  | { kind: "refused"; code: string };

const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

function parsePullRequests(value: string): Array<{ repository: string; number: number }> | null {
  const result: Array<{ repository: string; number: number }> = [];
  for (const line of lines(value)) {
    const match = /^([^#]+)#([1-9]\d*)$/.exec(line);
    if (!match) return null;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number)) return null;
    result.push({ repository: match[1], number });
  }
  return result;
}

export function AmuxIdeaInputPanel({ submissionAvailable, sourceScopePreviewAvailable,
  initialPlanAvailable, frontierModelsAvailable, transferPreviewAvailable,
  transferConfirmAvailable, analysisResultAvailable, analysisBudgetAvailable, operatorId,
  openRequestId = null, progressRows }: {
  submissionAvailable: boolean; sourceScopePreviewAvailable: boolean;
  initialPlanAvailable: boolean; frontierModelsAvailable: boolean;
  transferPreviewAvailable: boolean; transferConfirmAvailable: boolean;
  analysisResultAvailable: boolean; analysisBudgetAvailable: boolean; operatorId: string;
  /** The idea a list row opened (`?idea=<requestId>`); read back like a saved request. */
  openRequestId?: string | null;
  /** The Ideas main shows the list of ideas beside the input; omitted, the list is not drawn here. */
  progressRows?: AmuxIdeaProgressRows;
}) {
  const messages = useAdminMessages(adminAmuxIdeaInputMessages);
  const [idea, setIdea] = useState("");
  const [repositories, setRepositories] = useState("");
  const [pullRequests, setPullRequests] = useState("");
  const hasUnsavedInput = !!(idea.trim() || repositories.trim() || pullRequests.trim());
  const [pending, setPending] = useState(false);
  const [readBackPending, setReadBackPending] = useState(false);
  // The idea whose execution approval was recorded in this browser: its analysis result is then watched on its own.
  // Each recorded execution approval (one per analysis page) starts a new watch of the result.
  const [analysisWatch, setAnalysisWatch] = useState<{ ideaId: string; token: number } | null>(null);
  // The idea cannot be edited while the one button's chain runs (input check, eligibility, build).
  const [chainRunning, setChainRunning] = useState(false);
  // The blocking dialog of the build-preview request (save, plan, preview in one request): working while
  // it is in flight, then its answer until it is closed. It lives here, not in the frontier panel, because
  // that panel is remounted for the saved idea the moment the request succeeds.
  const [buildDialog, setBuildDialog] = useState<{
    tone: AmuxBusyTone; reason: string | null; requestId: string;
    /** What a saved idea got to: the preview, a stop after the save, or only the save (sources). */
    saved: null | { ideaId: string; previewPrepared: boolean; hasExternalSources: boolean;
      stoppedAt: "plan" | "preview" | null; error: string | null };
  } | null>(null);
  const [savedRequestId, setSavedRequestId] = useState("");
  const [savedRequestError, setSavedRequestError] = useState(false);
  const [savedRequestReauth, setSavedRequestReauth] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [result, setResult] = useState<InputPreviewResult | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });
  const [planReadyIdeaId, setPlanReadyIdeaId] = useState<string | null>(null);
  const [continuationChunkIndex, setContinuationChunkIndex] = useState(0);
  const onInitialPlanCommitted = useCallback((committedIdeaId: string) => {
    setPlanReadyIdeaId(committedIdeaId);
  }, []);
  const [sourceRepository, setSourceRepository] = useState("");
  const [sourceCommitSha, setSourceCommitSha] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [sourceScopePending, setSourceScopePending] = useState(false);
  const [sourceScopeResult, setSourceScopeResult] = useState<SourceScopeResult>({ kind: "idle" });
  const inputRevision = useRef(0);
  const inFlight = useRef(false);

  const invalidateResult = () => {
    inputRevision.current += 1;
    setResult(null);
    setSubmission({ kind: "idle" });
  };

  const [setAsideAcknowledged, setSetAsideAcknowledged] = useState(false);
  // Leaving for another idea would lose an unsaved draft: the progress list asks first.
  const draftAtRisk = hasUnsavedInput && (submission.kind === "idle" || submission.kind === "refused");
  useEffect(() => {
    setAmuxIdeaUnsavedDraft(draftAtRisk);
    return () => setAmuxIdeaUnsavedDraft(false);
  }, [draftAtRisk]);
  const [setAside, setSetAside] = useState<{ kind: "set_aside"; requestId: string } | { kind: "unavailable" } | null>(null);
  const resetInput = () => {
    inputRevision.current += 1;
    inFlight.current = false;
    setIdea("");
    setRepositories("");
    setPullRequests("");
    setResult(null);
    setSourceRepository("");
    setSourceCommitSha("");
    setSourcePath("");
    setSourceScopeResult({ kind: "idle" });
    setSubmission({ kind: "idle" });
  };
  const startAnotherIdea = () => {
    if (!canStartAnotherIdea(submission.kind, pending || readBackPending || sourceScopePending)) return;
    if (submission.kind === "submitted") {
      clearConfirmedIdeaRequest(receiptStore(), operatorId, submission.requestId);
    }
    setSetAside(null);
    resetInput();
  };
  // An unknown or unrecoverable previous request no longer locks the input
  // for good: the operator may set it aside explicitly. Nothing is retried;
  // the old request keeps its id and can still be opened by it.
  const setAsidePreviousIdea = () => {
    if (!canSetAsidePreviousIdea(submission.kind, pending || readBackPending || sourceScopePending,
      setAsideAcknowledged)) return;
    const previous = submission.kind === "outcome_unknown" ? submission.requestId : null;
    if (!forgetIdeaRequestReceipts(receiptStore(), operatorId)) {
      setSetAside({ kind: "unavailable" });
      return;
    }
    setSetAsideAcknowledged(false);
    setSetAside(previous ? { kind: "set_aside", requestId: previous } : null);
    resetInput();
  };

  const checkSourceScope = async () => {
    if (submission.kind !== "submitted" || !sourceScopePreviewAvailable || sourceScopePending ||
        !sourceRepository.trim() || !sourceCommitSha.trim() || !sourcePath.trim()) return;
    const ideaId = submission.ideaId;
    const requested = { repository: sourceRepository.trim(),
      commitSha: sourceCommitSha.trim(), path: sourcePath.trim() };
    setSourceScopePending(true);
    setSourceScopeResult({ kind: "idle" });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/source-scope-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, ideaId, scopeJson: JSON.stringify({
          version: 1,
          sources: [{ kind: "repository_file", ...requested }],
        }) }),
      });
      setSourceScopeResult(classifySourceScopePreview(
        { status: response.status, body: await response.json() }, ideaId, requested));
    } catch {
      setSourceScopeResult({ kind: "error", code: "preview_unavailable" });
    } finally {
      setSourceScopePending(false);
    }
  };

  const readBack = useCallback(async (requestId: string) => {
    setReadBackPending(true);
    try {
      const query = new URLSearchParams({ requestId }).toString();
      const response = await adminFetch(
        `/api/admin/amux/ideas/submissions?${query}`,
        { cache: "no-store" },
      );
      const decision = classifyIdeaSubmissionReadBack({
        status: response.status,
        body: await response.json(),
      }, requestId);
      if (decision.kind === "submitted") {
        rememberConfirmedIdeaRequest(receiptStore(), operatorId, requestId);
        setContinuationChunkIndex(0);
        setSubmission({ kind: "submitted", requestId, ideaId: decision.ideaId,
          hasExternalSources: decision.hasExternalSources });
      } else {
        setSubmission({ kind: "outcome_unknown", requestId });
      }
    } catch {
      setSubmission({ kind: "outcome_unknown", requestId });
    } finally {
      setReadBackPending(false);
    }
  }, [operatorId]);

  // Opens an exact saved request by its id: a read-back only, never a write.
  const openRequest = useCallback(async (requestId: string) => {
    setReadBackPending(true); setSavedRequestError(false); setSavedRequestReauth(false);
    try {
      const response = await adminFetch(`/api/admin/amux/ideas/submissions?${
        new URLSearchParams({ requestId })}`, { cache: "no-store" });
      const decision = classifyIdeaSubmissionReadBack({ status: response.status,
        body: await response.json() }, requestId);
      if (decision.kind !== "submitted") {
        setSavedRequestError(true); setSavedRequestReauth(response.status === 428);
        return;
      }
      rememberConfirmedIdeaRequest(receiptStore(), operatorId, requestId);
      setIdea(""); setRepositories(""); setPullRequests(""); setResult(null);
      setPlanReadyIdeaId(null); setContinuationChunkIndex(0);
      setSourceRepository(""); setSourceCommitSha(""); setSourcePath("");
      setSourceScopeResult({ kind: "idle" });
      setSubmission({ kind: "submitted", requestId, ideaId: decision.ideaId,
        hasExternalSources: decision.hasExternalSources });
    } catch { setSavedRequestError(true); }
    finally { setReadBackPending(false); }
  }, [operatorId]);
  const openSavedIdea = async () => {
    const requestId = savedRequestId.trim().toLowerCase();
    if (!recoveryChecked || !canOpenSavedIdea(submission.kind,
      pending || readBackPending || sourceScopePending ||
        (submission.kind !== "submitted" && hasUnsavedInput), requestId)) return;
    await openRequest(requestId);
  };

  // The browser receipts decide what the panel shows first: a request left
  // pending or confirmed is read back, unreadable storage locks saving.
  const recoverFromReceipts = useCallback(() => {
    const recovered = readPendingIdeaRequest(receiptStore(), operatorId);
    const confirmed = recovered.kind === "none"
      ? readConfirmedIdeaRequest(receiptStore(), operatorId) : null;
    if (recovered.kind === "unavailable") {
      setSubmission({ kind: "recovery_unavailable" });
    } else if (recovered.kind === "pending") {
      inFlight.current = true;
      setSubmission({ kind: "outcome_unknown", requestId: recovered.requestId });
      void readBack(recovered.requestId);
    } else if (openRequestId && canOpenSavedIdea("idle", false, openRequestId)) {
      void openRequest(openRequestId);
    } else if (confirmed?.kind === "confirmed") {
      inFlight.current = true;
      setSubmission({ kind: "outcome_unknown", requestId: confirmed.requestId });
      void readBack(confirmed.requestId);
    } else if (confirmed?.kind === "unavailable") {
      setSubmission({ kind: "recovery_unavailable" });
    } else {
      inFlight.current = false;
      setSubmission({ kind: "idle" });
    }
  }, [openRequest, openRequestId, operatorId, readBack]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      recoverFromReceipts();
      setRecoveryChecked(true);
    });
    return () => { active = false; };
  }, [recoverFromReceipts]);

  const submit = async () => {
    if (!submissionAvailable || !recoveryChecked || inFlight.current ||
        result?.outcome !== "input_checked" ||
        submission.kind === "pending" || submission.kind === "outcome_unknown" ||
        submission.kind === "submitted") return;
    const refs = parsePullRequests(pullRequests);
    if (!refs) return;
    const requestId = crypto.randomUUID();
    if (!reservePendingIdeaRequest(receiptStore(), operatorId, requestId)) {
      setSubmission({ kind: "recovery_unavailable" });
      return;
    }
    inFlight.current = true;
    setSubmission({ kind: "pending", requestId });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1, requestId,
          input: { version: 1, idea, repositories: lines(repositories), pullRequests: refs },
        }),
      });
      const decision = classifyIdeaSubmissionPost({
        status: response.status,
        body: await response.json(),
      }, requestId);
      if (decision.kind === "submitted") {
        rememberConfirmedIdeaRequest(receiptStore(), operatorId, requestId);
        setContinuationChunkIndex(0);
        setSubmission({ kind: "submitted", requestId, ideaId: decision.ideaId,
          hasExternalSources: decision.hasExternalSources });
      } else if (decision.kind === "refused") {
        clearPendingIdeaRequest(receiptStore(), operatorId, requestId);
        inFlight.current = false;
        setSubmission({ kind: "refused", code: decision.code });
      } else {
        await readBack(requestId);
      }
    } catch {
      await readBack(requestId);
    }
  };

  /** The existing input check (inspection, writes nothing). Resolves true only for a passed check. */
  const checkInput = async (): Promise<boolean> => {
    const refs = parsePullRequests(pullRequests);
    if (!refs) {
      setResult({ error: "schema_rejected", ideaWrites: 0 });
      return false;
    }
    const requestRevision = inputRevision.current;
    setPending(true);
    setResult(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/input-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, idea, repositories: lines(repositories), pullRequests: refs }),
      });
      const next = (await response.json()) as InputPreviewResult;
      if (requestRevision === inputRevision.current) setResult(next);
      return requestRevision === inputRevision.current && next.outcome === "input_checked";
    } catch {
      if (requestRevision === inputRevision.current) setResult({ error: "preview_failed", ideaWrites: 0 });
      return false;
    } finally {
      setPending(false);
    }
  };

  // amux-intake.md v18 item 1: the frontier panel can save the idea, prepare
  // its plan and its preview in one request. The submission bookkeeping stays
  // here, so a lost answer recovers exactly as a lost submission does.
  const buildRefs = parsePullRequests(pullRequests);
  const buildHooks: AmuxBuildPreviewHooks = {
    draft: submissionAvailable && recoveryChecked && submission.kind === "idle" &&
      idea.trim() !== "" && buildRefs !== null
      ? { idea, repositories: lines(repositories), pullRequests: buildRefs } : null,
    beforeBuild: () => checkInput(),
    onChain: setChainRunning,
    reserve: (requestId) => {
      if (inFlight.current || !reservePendingIdeaRequest(receiptStore(), operatorId, requestId)) return false;
      inFlight.current = true;
      setSubmission({ kind: "pending", requestId });
      setBuildDialog({ tone: "working", reason: null, requestId, saved: null });
      return true;
    },
    onBuilt: ({ requestId, ideaId, hasExternalSources, planReady, previewPrepared, previewMayExist, stoppedAt, error }) => {
      // The idea is saved either way, but only a prepared preview finishes the chain: a stop after the save is
      // said as a stop, and an unknown step is said as unknown, never as "ready".
      setBuildDialog((current) => current && { ...current, saved: { ideaId, previewPrepared, hasExternalSources, stoppedAt, error },
        tone: previewPrepared ? "success" : error === "outcome_unknown" || previewMayExist ? "unknown" : "partial" });
      rememberConfirmedIdeaRequest(receiptStore(), operatorId, requestId);
      setContinuationChunkIndex(0);
      if (planReady) setPlanReadyIdeaId(ideaId);
      setSubmission({ kind: "submitted", requestId, ideaId, hasExternalSources });
    },
    onUnknown: (requestId) => {
      setBuildDialog((current) => current && { ...current, tone: "unknown", requestId });
      void readBack(requestId);
    },
    onRefused: (requestId, code) => {
      setBuildDialog((current) => current && { ...current, tone: "refused",
        reason: messages.submitErrors[code as keyof typeof messages.submitErrors] ?? messages.submitErrors.submit_failed });
      clearPendingIdeaRequest(receiptStore(), operatorId, requestId);
      inFlight.current = false;
      setSubmission({ kind: "refused", code });
    },
  };

  const ideaBytes = new TextEncoder().encode(idea.trim()).length;
  const frozen = chainRunning || readBackPending || submission.kind === "pending" || submission.kind === "outcome_unknown" ||
    submission.kind === "submitted" || submission.kind === "recovery_unavailable";
  const refusedForStepUp = result?.error === "ADMIN_REAUTHENTICATION_REQUIRED" ||
    (submission.kind === "refused" && submission.code === "ADMIN_REAUTHENTICATION_REQUIRED") ||
    (sourceScopeResult.kind === "error" && sourceScopeResult.code === "ADMIN_REAUTHENTICATION_REQUIRED");
  const errorMessage = result?.error
    ? (messages.errors[result.error as keyof typeof messages.errors] ?? messages.errors.preview_failed)
    : null;

  const busy = pending || readBackPending || sourceScopePending;
  const card: AmuxIdeaRequestCardState | null =
    submission.kind === "pending" ? { kind: "saving", requestId: submission.requestId } :
      submission.kind === "outcome_unknown" ? (readBackPending
        ? { kind: "checking", requestId: submission.requestId }
        : { kind: "unknown", requestId: submission.requestId }) :
        submission.kind === "submitted"
          ? { kind: "saved", requestId: submission.requestId, ideaId: submission.ideaId } :
          submission.kind === "recovery_unavailable" ? { kind: "locked" } : null;
  const setAsideControls = submission.kind === "outcome_unknown" || submission.kind === "recovery_unavailable" ? (
    <div className="w-full space-y-2 border-t pt-3 border-zinc-700" data-testid="amux-idea-set-aside">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1 size-4" checked={setAsideAcknowledged}
          onChange={(event) => setSetAsideAcknowledged(event.target.checked)} />
        <span>{messages.setAsideAcknowledge}</span>
      </label>
      <button type="button" onClick={setAsidePreviousIdea}
        disabled={!canSetAsidePreviousIdea(submission.kind, busy, setAsideAcknowledged)}
        className="min-h-11 rounded-lg border px-4 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 border-zinc-600">
        {messages.setAsideAction}
      </button>
      {setAside?.kind === "unavailable" ? <p role="alert">{messages.setAsideUnavailable}</p> : null}
    </div>
  ) : null;

  // One frontier panel serves the whole path: as the model line and the one button of the new idea (placed in
  // the card's column), then, once the idea is saved, as the execution approval below. It is rendered in one
  // place at a time and keeps its instance while a build is in flight.
  const composePanel = (
    <AmuxFrontierModelsPanel
      key={submission.kind === "submitted" ?
        `${submission.ideaId}:${continuationChunkIndex}` : "none"}
      available={frontierModelsAvailable}
      previewAvailable={transferPreviewAvailable}
      confirmAvailable={transferConfirmAvailable}
      analysisBudgetAvailable={analysisBudgetAvailable}
      ideaId={submission.kind === "submitted" ? submission.ideaId : null}
      ideaText={submission.kind === "submitted" ? idea.trim() : ""}
      planReady={submission.kind === "submitted" && planReadyIdeaId === submission.ideaId}
      declaredExternalSources={submission.kind === "submitted" && submission.hasExternalSources}
      operatorId={operatorId}
      chunkIndex={continuationChunkIndex}
      build={submission.kind === "submitted" ? null : buildHooks}
      buildRequestId={submission.kind === "submitted" ? submission.requestId : null}
      onExecutionApproved={() => setAnalysisWatch((current) => submission.kind === "submitted"
        ? { ideaId: submission.ideaId, token: (current?.token ?? 0) + 1 } : current)}
    />
  );

  // A lost answer that the read-back then confirms as saved is a success of the save, said as such.
  const savedAfterUnknown = buildDialog?.tone === "unknown" && buildDialog.saved === null && submission.kind === "submitted";
  const buildDialogTone: AmuxBusyTone | null = buildDialog === null ? null
    : savedAfterUnknown ? "partial" : buildDialog.tone;
  const stopped = buildDialog?.saved ?? null;
  const buildDialogView = buildDialog && buildDialogTone ? (
    <AmuxIdeaBusyDialog open tone={buildDialogTone}
      title={buildDialogTone === "working" ? messages.busyPreviewTitle
        : buildDialogTone === "success" ? messages.busyPreviewDoneTitle
          : buildDialogTone === "partial" ? (savedAfterUnknown ? messages.statusSavedTitle : messages.busyPreviewPartialTitle)
            : buildDialogTone === "refused" ? messages.busyRefusedTitle : messages.busyUnknownTitle}
      message={messages.busyPreviewBody}
      onClose={readBackPending ? undefined : () => setBuildDialog(null)}>
      {buildDialogTone === "success" ? <p>{messages.busyPreviewDoneBody}</p> : null}
      {buildDialogTone === "partial" ? <p>{savedAfterUnknown ? messages.statusSavedBody
        : messages.busyPreviewPartialBody(stopped?.hasExternalSources ? "sources" : stopped?.stoppedAt ?? "preview",
          stopped?.error ?? "unknown")}</p> : null}
      {buildDialogTone === "refused" ? <>
        <p>{messages.busyRefusedBody}</p>
        {buildDialog.reason ? <p role="alert" className="text-amber-200">{buildDialog.reason}</p> : null}
      </> : null}
      {buildDialogTone === "unknown" && stopped ? <>
        {/* The idea is saved; only a later step is unknown, and that step is read back in its own panel. */}
        <p>{messages.statusSavedTitle}</p>
        <p>{stopped.stoppedAt === "plan" ? messages.initialPlanUnknown(stopped.ideaId) : messages.transferPreviewUnknown}</p>
      </> : null}
      {buildDialogTone === "unknown" && !stopped ? <>
        <p>{messages.busyUnknownBody}</p>
        {readBackPending ? <p role="status" aria-live="polite" className="text-blue-200">{messages.busyChecking}</p> : null}
        <button type="button" onClick={() => void readBack(buildDialog.requestId)} disabled={readBackPending}
          aria-busy={readBackPending}
          className="min-h-11 w-full rounded-lg border border-amber-500/40 px-3 font-medium text-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:opacity-50">
          {messages.checkSubmissionStatus}
        </button>
      </> : null}
    </AmuxIdeaBusyDialog>
  ) : null;


  const openSavedRequest = (
    <details className="space-y-2 rounded-lg border p-3 text-sm border-zinc-800" data-testid="amux-open-saved">
      <summary className="min-h-11 cursor-pointer content-center font-medium text-blue-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300">
        {messages.openSavedTitle} →
      </summary>
      <p className="text-zinc-300">{messages.openSavedHint}</p>
      <label className="block text-zinc-200" htmlFor="amux-saved-request-id">{messages.openSavedId}</label>
      <input id="amux-saved-request-id" value={savedRequestId} maxLength={36}
        onChange={(event) => setSavedRequestId(event.target.value)}
        disabled={readBackPending}
        className="min-h-11 w-full rounded border border-zinc-600 bg-zinc-900 px-2 font-mono text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300" />
      <button type="button" onClick={() => void openSavedIdea()}
        disabled={!recoveryChecked || !canOpenSavedIdea(submission.kind,
          pending || readBackPending || sourceScopePending ||
            (submission.kind !== "submitted" && hasUnsavedInput), savedRequestId.trim().toLowerCase())}
        className="min-h-11 rounded border border-zinc-600 px-3 text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 disabled:opacity-50">
        {messages.openSavedButton}</button>
      {savedRequestError ? <p role="alert" className="text-red-200">{messages.openSavedFailed}</p> : null}
      {savedRequestReauth ? <a className="text-blue-300 underline" href={STEP_UP_HREF}>{messages.stepUp}</a> : null}
    </details>
  );

  return (
    <section className="flex w-full min-w-0 flex-col gap-5" data-testid="amux-v4-idea-input">
      {buildDialogView}
      {/* Ideas main (approved v49 mockup): the new-idea card on the left and the
          ideas in progress on the right, one column on a narrow screen. The
          flow panels of the saved idea follow below at full width. */}
      <div className={progressRows === undefined ? "flex min-w-0 flex-col gap-4"
        : "grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_23.75rem] lg:items-start"}
      data-testid="amux-idea-main-grid">
        <div className="flex min-w-0 flex-col gap-4">
          {card ? (
            <AmuxIdeaRequestStatusCard state={card}>
              {card.kind === "unknown" ? <>
                <button type="button" onClick={() => void readBack(card.requestId)} disabled={readBackPending}
                  className="min-h-11 rounded-lg border border-amber-500/40 px-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:opacity-50">
                  {messages.checkSubmissionStatus}
                </button>
                <a href={STEP_UP_HREF} className="font-medium underline">{messages.stepUp}</a>
              </> : null}
              {card.kind === "saved" ? (
                <button type="button" onClick={startAnotherIdea}
                  disabled={!canStartAnotherIdea(submission.kind, busy)}
                  className="min-h-11 rounded-lg border border-zinc-600 px-4 text-sm font-medium text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 disabled:opacity-50">
                  {messages.startAnotherIdea}
                </button>
              ) : null}
              {card.kind === "locked" ? (
                <button type="button" onClick={recoverFromReceipts} disabled={busy}
                  className="min-h-11 rounded-lg border border-zinc-600 px-4 font-medium disabled:opacity-50">
                  {messages.statusRecheckStorage}
                </button>
              ) : null}
              {setAsideControls}
            </AmuxIdeaRequestStatusCard>
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border p-4 text-sm border-zinc-800 bg-zinc-900/60 text-zinc-100">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{messages.title}</h2>
                <span data-testid="amux-idea-save-chip" className={`rounded-md border px-2 py-0.5 text-xs font-medium ${submissionAvailable
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : "border-zinc-700 bg-zinc-800 text-zinc-300"}`}>
                  {submissionAvailable ? messages.saveOpen : messages.saveClosed}
                </span>
              </div>
              <label htmlFor="amux-v4-idea" className="font-medium">{messages.ideaLabel}</label>
              <textarea
                id="amux-v4-idea"
                value={idea}
                onChange={(event) => { setIdea(event.target.value); invalidateResult(); }}
                disabled={pending || frozen}
                maxLength={8192}
                className="min-h-56 w-full rounded-lg border p-3 text-base font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 border-zinc-700 bg-zinc-900 text-zinc-100"
                aria-describedby="amux-v4-idea-hint amux-v4-idea-count"
              />
              <p className="flex flex-wrap justify-between gap-2 text-xs text-zinc-400">
                <span id="amux-v4-idea-hint">{messages.ideaHint}</span>
                <span id="amux-v4-idea-count">{messages.byteCount(ideaBytes)}</span>
              </p>
              <details className="rounded-lg border p-3 border-zinc-800">
                <summary className="min-h-11 cursor-pointer content-center font-medium text-blue-300">{messages.sourceSection}</summary>
                <p className="mt-2 text-xs leading-5 text-zinc-400">{messages.sourceSectionHint}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-2 font-medium" htmlFor="amux-v4-repositories">
                    {messages.repositoriesLabel}
                    <textarea
                      id="amux-v4-repositories"
                      value={repositories}
                      onChange={(event) => { setRepositories(event.target.value); invalidateResult(); }}
                      disabled={pending || frozen}
                      className="min-h-24 w-full rounded-lg border p-3 text-sm font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 border-zinc-700 bg-zinc-900 text-zinc-100"
                    />
                  </label>
                  <label className="flex flex-col gap-2 font-medium" htmlFor="amux-v4-pull-requests">
                    {messages.pullRequestsLabel}
                    <textarea
                      id="amux-v4-pull-requests"
                      value={pullRequests}
                      onChange={(event) => { setPullRequests(event.target.value); invalidateResult(); }}
                      disabled={pending || frozen}
                      className="min-h-24 w-full rounded-lg border p-3 text-sm font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 border-zinc-700 bg-zinc-900 text-zinc-100"
                    />
                  </label>
                </div>
              </details>
              {/* The default path is the one button of the model line right below this card: it runs the input
                  check, the model's eligibility check and the build-preview request. These separate steps stay
                  for recovery only. */}
              <details className="rounded-lg border p-3 border-zinc-800" data-testid="amux-idea-stepwise">
                <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-zinc-300">{messages.stepwiseTitle}</summary>
                <p className="mt-2 text-xs text-zinc-400">{messages.stepwiseHint}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void checkInput()}
                    disabled={pending || frozen || idea.trim().length === 0 || ideaBytes > 8192}
                    className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 disabled:opacity-50"
                  >
                    {messages.preview}
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!submissionAvailable || !recoveryChecked || result?.outcome !== "input_checked" || frozen}
                    className="min-h-11 rounded-lg border border-blue-400 px-4 text-sm font-medium text-blue-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 disabled:opacity-50"
                  >
                    {messages.submit}
                  </button>
                  <span className="text-xs text-zinc-400">
                    {submissionAvailable ? messages.submitBoundary : messages.submitUnavailable}
                  </span>
                </div>
              </details>
              <details className="rounded-lg bg-zinc-800/60 p-3 text-xs text-zinc-300">
                <summary className="min-h-11 cursor-pointer content-center">
                  {messages.boundaryCurrentDetail}{" "}
                  <span className="font-medium text-blue-300 underline">{messages.boundaryDetails}</span>
                </summary>
                <p className="mt-2 font-semibold">{messages.boundaryTitle}</p>
                <p className="mt-1">{messages.boundaryCurrent}</p>
                <p className="mt-1 font-semibold">{messages.boundaryNext}</p>
                <p className="mt-1">{messages.boundaryNextDetail}</p>
              </details>
            </div>
          )}

          {/* The model line and the one button. It stays mounted while a request is in flight (the status card
              replaces the idea card then, and this strip is only hidden), and moves below as the execution
              approval once the idea is saved. */}
          {submission.kind !== "submitted" ? (
            <div className={card === null ? "block" : "hidden"} data-testid="amux-idea-compose-slot">{composePanel}</div>
          ) : null}
          {refusedForStepUp ? (
            <a href={STEP_UP_HREF} className="text-sm font-medium underline text-zinc-100">{messages.stepUp}</a>
          ) : null}
          {submission.kind === "refused" ? (
            <p role="alert" className="text-sm text-red-300">
              {messages.submitErrors[submission.code as keyof typeof messages.submitErrors] ?? messages.submitErrors.submit_failed}
            </p>
          ) : null}
          {setAside?.kind === "set_aside" && submission.kind === "idle" ? (
            <p role="status" className="text-sm text-zinc-300">
              {messages.setAsideNotice(setAside.requestId)}
            </p>
          ) : null}
          {result ? (
            <div className="rounded-md border p-4 text-sm border-zinc-700 text-zinc-100" role="status">
              {errorMessage ? <p>{errorMessage}</p> : null}
              {result.outcome === "input_checked" ? (
                <>
                  <p>{messages.result(result.ideaBytes ?? 0, result.repositoryCount ?? 0, result.pullRequestCount ?? 0)}</p>
                  <p className="mt-2">{messages.excluded}</p>
                </>
              ) : null}
              {submission.kind === "idle" || submission.kind === "refused" ? (
                <p className="mt-2 text-zinc-400">{messages.noWrite}</p>
              ) : null}
            </div>
          ) : null}
          {progressRows === undefined ? openSavedRequest : null}
        </div>
        {progressRows !== undefined ? (
          <AmuxIdeaList rows={progressRows} activeRequestId={openRequestId}>{openSavedRequest}</AmuxIdeaList>
        ) : null}
      </div>

      {submission.kind === "submitted" ? <AmuxInitialPlanPanel
        key={submission.ideaId}
        ideaId={submission.ideaId}
        operatorId={operatorId} available={initialPlanAvailable}
        declaredExternalSources={submission.hasExternalSources}
        onCommitted={onInitialPlanCommitted}
      /> : null}
      {submission.kind === "submitted" ? composePanel : null}
      {analysisResultAvailable && submission.kind === "submitted" ?
        <AmuxIdeaAnalysisResultPanel key={submission.ideaId}
          ideaId={submission.ideaId}
          watchToken={analysisWatch?.ideaId === submission.ideaId ? analysisWatch.token : 0}
          watchChunk={continuationChunkIndex}
          onContinuationReady={setContinuationChunkIndex} /> : null}
      {submission.kind === "submitted" ? (
        <section className="space-y-3 rounded-xl border p-4 border-zinc-800" aria-labelledby="amux-v4-source-scope-heading">
          <h3 id="amux-v4-source-scope-heading" className="text-base font-semibold text-zinc-100">{messages.sourceScopeTitle}</h3>
          <p className="text-sm text-zinc-300">{messages.sourceScopeHint}</p>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm text-zinc-100">
              {messages.sourceRepositoryLabel}
              <input value={sourceRepository} maxLength={165} spellCheck={false} onChange={(event) => { setSourceRepository(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                disabled={sourceScopePending} className="min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2 border-zinc-700 bg-zinc-900 focus-visible:outline-blue-300" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-zinc-100">
              {messages.sourceCommitLabel}
              <input value={sourceCommitSha} maxLength={64} spellCheck={false} onChange={(event) => { setSourceCommitSha(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                disabled={sourceScopePending} className="min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2 border-zinc-700 bg-zinc-900 focus-visible:outline-blue-300" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-zinc-100">
              {messages.sourcePathLabel}
              <input value={sourcePath} maxLength={256} spellCheck={false} onChange={(event) => { setSourcePath(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                disabled={sourceScopePending} className="min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2 border-zinc-700 bg-zinc-900 focus-visible:outline-blue-300" />
            </label>
          </div>
          <button type="button" onClick={checkSourceScope}
            disabled={!sourceScopePreviewAvailable || sourceScopePending || !sourceRepository.trim() || !sourceCommitSha.trim() || !sourcePath.trim()}
            className="min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 border-blue-400 text-blue-200 focus-visible:outline-blue-300">
            {sourceScopePending ? messages.sourceScopeChecking : messages.sourceScopeCheck}
          </button>
          {!sourceScopePreviewAvailable ? <p className="text-sm text-zinc-400">{messages.sourceScopeUnavailable}</p> : null}
          {sourceScopeResult.kind === "checked" ? (
            <div role="status" className="space-y-2 text-sm text-zinc-100">
              <p>{messages.sourceScopeChecked}</p>
              <code className="block break-all rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-100">{sourceScopeResult.canonicalScopeJson}</code>
            </div>
          ) : null}
          {sourceScopeResult.kind === "error" ? <p role="alert" className="text-sm text-red-300">{messages.sourceScopeError(sourceScopeResult.code)}</p> : null}
        </section>
      ) : null}
      <p className="text-xs text-zinc-400" data-testid="amux-idea-settings-footnote">
        {messages.frontierSettingsMoved}{" "}
        <Link href="/admin/amux-settings?tab=analysis" className="font-medium text-blue-300 underline">{messages.frontierSettingsLink}</Link>
      </p>
    </section>
  );
}
