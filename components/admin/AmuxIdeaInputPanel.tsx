"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxInitialPlanPanel } from "@/components/admin/AmuxInitialPlanPanel";
import { AmuxFrontierModelsPanel, type AmuxBuildPreviewHooks } from "@/components/admin/AmuxFrontierModelsPanel";
import { AmuxIdeaAnalysisResultPanel } from "@/components/admin/AmuxIdeaAnalysisResultPanel";
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
  initialPlanAvailable, frontierModelsAvailable, frontierModelWriteAvailable, transferPreviewAvailable,
  transferConfirmAvailable, analysisResultAvailable, analysisBudgetAvailable, operatorId,
  openRequestId = null }: {
  submissionAvailable: boolean; sourceScopePreviewAvailable: boolean;
  initialPlanAvailable: boolean; frontierModelsAvailable: boolean;
  frontierModelWriteAvailable: boolean;
  transferPreviewAvailable: boolean; transferConfirmAvailable: boolean;
  analysisResultAvailable: boolean; analysisBudgetAvailable: boolean; operatorId: string;
  /** The idea a list row opened (`?idea=<requestId>`); read back like a saved request. */
  openRequestId?: string | null;
}) {
  const messages = useAdminMessages(adminAmuxIdeaInputMessages);
  const [idea, setIdea] = useState("");
  const [repositories, setRepositories] = useState("");
  const [pullRequests, setPullRequests] = useState("");
  const hasUnsavedInput = !!(idea.trim() || repositories.trim() || pullRequests.trim());
  const [pending, setPending] = useState(false);
  const [readBackPending, setReadBackPending] = useState(false);
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

  // amux-intake.md v18 item 1: the frontier panel can save the idea, prepare
  // its plan and its preview in one request. The submission bookkeeping stays
  // here, so a lost answer recovers exactly as a lost submission does.
  const buildRefs = parsePullRequests(pullRequests);
  const buildHooks: AmuxBuildPreviewHooks = {
    draft: submissionAvailable && recoveryChecked && submission.kind === "idle" &&
      idea.trim() !== "" && buildRefs !== null
      ? { idea, repositories: lines(repositories), pullRequests: buildRefs } : null,
    reserve: (requestId) => {
      if (inFlight.current || !reservePendingIdeaRequest(receiptStore(), operatorId, requestId)) return false;
      inFlight.current = true;
      setSubmission({ kind: "pending", requestId });
      return true;
    },
    onBuilt: ({ requestId, ideaId, hasExternalSources, planReady }) => {
      rememberConfirmedIdeaRequest(receiptStore(), operatorId, requestId);
      setContinuationChunkIndex(0);
      if (planReady) setPlanReadyIdeaId(ideaId);
      setSubmission({ kind: "submitted", requestId, ideaId, hasExternalSources });
    },
    onUnknown: (requestId) => { void readBack(requestId); },
    onRefused: (requestId, code) => {
      clearPendingIdeaRequest(receiptStore(), operatorId, requestId);
      inFlight.current = false;
      setSubmission({ kind: "refused", code });
    },
  };

  const checkInput = async () => {
    const refs = parsePullRequests(pullRequests);
    if (!refs) {
      setResult({ error: "schema_rejected", ideaWrites: 0 });
      return;
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
    } catch {
      if (requestRevision === inputRevision.current) setResult({ error: "preview_failed", ideaWrites: 0 });
    } finally {
      setPending(false);
    }
  };

  const ideaBytes = new TextEncoder().encode(idea.trim()).length;
  const frozen = readBackPending || submission.kind === "pending" || submission.kind === "outcome_unknown" ||
    submission.kind === "submitted" || submission.kind === "recovery_unavailable";
  const refusedForStepUp = result?.error === "ADMIN_REAUTHENTICATION_REQUIRED" ||
    (submission.kind === "refused" && submission.code === "ADMIN_REAUTHENTICATION_REQUIRED") ||
    (sourceScopeResult.kind === "error" && sourceScopeResult.code === "ADMIN_REAUTHENTICATION_REQUIRED");
  const errorMessage = result?.error
    ? (messages.errors[result.error as keyof typeof messages.errors] ?? messages.errors.preview_failed)
    : null;

  const busy = pending || readBackPending || sourceScopePending;
  const card: AmuxIdeaRequestCardState | null =
    submission.kind === "pending" ? { kind: "checking", requestId: submission.requestId } :
      submission.kind === "outcome_unknown" ? (readBackPending
        ? { kind: "checking", requestId: submission.requestId }
        : { kind: "unknown", requestId: submission.requestId }) :
        submission.kind === "submitted"
          ? { kind: "saved", requestId: submission.requestId, ideaId: submission.ideaId } :
          submission.kind === "recovery_unavailable" ? { kind: "locked" } : null;
  const setAsideControls = submission.kind === "outcome_unknown" || submission.kind === "recovery_unavailable" ? (
    <div className="w-full space-y-2 border-t border-zinc-300 pt-3 dark:border-zinc-700" data-testid="amux-idea-set-aside">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1 size-4" checked={setAsideAcknowledged}
          onChange={(event) => setSetAsideAcknowledged(event.target.checked)} />
        <span>{messages.setAsideAcknowledge}</span>
      </label>
      <button type="button" onClick={setAsidePreviousIdea}
        disabled={!canSetAsidePreviousIdea(submission.kind, busy, setAsideAcknowledged)}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-zinc-600">
        {messages.setAsideAction}
      </button>
      {setAside?.kind === "unavailable" ? <p role="alert">{messages.setAsideUnavailable}</p> : null}
    </div>
  ) : null;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4" data-testid="amux-v4-idea-input">
      <div className="space-y-2 border-b border-zinc-200 pb-5 dark:border-zinc-800">
        <p className="text-xs font-semibold tracking-[0.18em] text-blue-700 uppercase dark:text-blue-300">{messages.step}</p>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">{messages.title}</h2>
        <p className="max-w-2xl text-sm leading-6 text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      </div>

      {card ? (
        <AmuxIdeaRequestStatusCard state={card}>
          {card.kind === "unknown" ? <>
            <button type="button" onClick={() => void readBack(card.requestId)} disabled={readBackPending}
              className="min-h-11 rounded-lg border border-amber-700 px-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:opacity-50 dark:border-amber-300">
              {messages.checkSubmissionStatus}
            </button>
            <a href={STEP_UP_HREF} className="font-medium underline">{messages.stepUp}</a>
          </> : null}
          {card.kind === "saved" ? (
            <button type="button" onClick={startAnotherIdea}
              disabled={!canStartAnotherIdea(submission.kind, busy)}
              className="min-h-11 rounded-lg border border-zinc-400 px-4 text-sm font-medium text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100">
              {messages.startAnotherIdea}
            </button>
          ) : null}
          {card.kind === "locked" ? (
            <button type="button" onClick={recoverFromReceipts} disabled={busy}
              className="min-h-11 rounded-lg border border-zinc-400 px-4 font-medium disabled:opacity-50 dark:border-zinc-600">
              {messages.statusRecheckStorage}
            </button>
          ) : null}
          {setAsideControls}
        </AmuxIdeaRequestStatusCard>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
          <h3 className="text-base font-semibold">{messages.ideaSection}</h3>
          <label htmlFor="amux-v4-idea" className="font-medium">{messages.ideaLabel}</label>
          <textarea
            id="amux-v4-idea"
            value={idea}
            onChange={(event) => { setIdea(event.target.value); invalidateResult(); }}
            disabled={pending || frozen}
            maxLength={8192}
            className="min-h-56 w-full rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-base font-normal text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            aria-describedby="amux-v4-idea-hint amux-v4-idea-count"
          />
          <p className="flex flex-wrap justify-between gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <span id="amux-v4-idea-hint">{messages.ideaHint}</span>
            <span id="amux-v4-idea-count">{messages.byteCount(ideaBytes)}</span>
          </p>
          <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <summary className="cursor-pointer font-medium text-blue-800 dark:text-blue-200">{messages.sourceSection}</summary>
            <p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">{messages.sourceSectionHint}</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-2 font-medium" htmlFor="amux-v4-repositories">
                {messages.repositoriesLabel}
                <textarea
                  id="amux-v4-repositories"
                  value={repositories}
                  onChange={(event) => { setRepositories(event.target.value); invalidateResult(); }}
                  disabled={pending || frozen}
                  className="min-h-24 w-full rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm font-normal text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>
              <label className="flex flex-col gap-2 font-medium" htmlFor="amux-v4-pull-requests">
                {messages.pullRequestsLabel}
                <textarea
                  id="amux-v4-pull-requests"
                  value={pullRequests}
                  onChange={(event) => { setPullRequests(event.target.value); invalidateResult(); }}
                  disabled={pending || frozen}
                  className="min-h-24 w-full rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm font-normal text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={checkInput}
              disabled={pending || frozen || idea.trim().length === 0 || ideaBytes > 8192}
              className="min-h-11 rounded-lg bg-blue-700 px-4 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:bg-blue-600 dark:focus-visible:outline-blue-300"
            >
              {messages.preview}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!submissionAvailable || !recoveryChecked || result?.outcome !== "input_checked" || frozen}
              className="min-h-11 rounded-lg border border-blue-700 px-4 text-sm font-medium text-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200"
            >
              {messages.submit}
            </button>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              {submissionAvailable ? messages.submitBoundary : messages.submitUnavailable}
            </span>
          </div>
          <details className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <summary className="cursor-pointer">
              {messages.boundaryCurrentDetail}{" "}
              <span className="font-medium text-blue-800 underline dark:text-blue-200">{messages.boundaryDetails}</span>
            </summary>
            <p className="mt-2 font-semibold">{messages.boundaryTitle}</p>
            <p className="mt-1">{messages.boundaryCurrent}</p>
            <p className="mt-1 font-semibold">{messages.boundaryNext}</p>
            <p className="mt-1">{messages.boundaryNextDetail}</p>
          </details>
        </div>
      )}

      {refusedForStepUp ? (
        <a href={STEP_UP_HREF} className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100">{messages.stepUp}</a>
      ) : null}
      {submission.kind === "refused" ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {messages.submitErrors[submission.code as keyof typeof messages.submitErrors] ?? messages.submitErrors.submit_failed}
        </p>
      ) : null}
      {setAside?.kind === "set_aside" && submission.kind === "idle" ? (
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
          {messages.setAsideNotice(setAside.requestId)}
        </p>
      ) : null}
      <AmuxInitialPlanPanel
        key={submission.kind === "submitted" ? submission.ideaId : "none"}
        ideaId={submission.kind === "submitted" ? submission.ideaId : null}
        operatorId={operatorId} available={initialPlanAvailable}
        declaredExternalSources={submission.kind === "submitted" && submission.hasExternalSources}
        onCommitted={onInitialPlanCommitted}
      />
      <AmuxFrontierModelsPanel
        key={submission.kind === "submitted" ?
          `${submission.ideaId}:${continuationChunkIndex}` : "none"}
        available={frontierModelsAvailable}
        writeAvailable={frontierModelWriteAvailable}
        previewAvailable={transferPreviewAvailable}
        confirmAvailable={transferConfirmAvailable}
        analysisBudgetAvailable={analysisBudgetAvailable}
        ideaId={submission.kind === "submitted" ? submission.ideaId : null}
        planReady={submission.kind === "submitted" && planReadyIdeaId === submission.ideaId}
        declaredExternalSources={submission.kind === "submitted" && submission.hasExternalSources}
        operatorId={operatorId}
        chunkIndex={continuationChunkIndex}
        build={submission.kind === "submitted" ? null : buildHooks}
        buildRequestId={submission.kind === "submitted" ? submission.requestId : null}
      />
      {analysisResultAvailable && submission.kind === "submitted" ?
        <AmuxIdeaAnalysisResultPanel key={submission.ideaId}
          ideaId={submission.ideaId}
          onContinuationReady={setContinuationChunkIndex} /> : null}
      {submission.kind === "submitted" ? (
        <section className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800" aria-labelledby="amux-v4-source-scope-heading">
          <h3 id="amux-v4-source-scope-heading" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{messages.sourceScopeTitle}</h3>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.sourceScopeHint}</p>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
              {messages.sourceRepositoryLabel}
              <input value={sourceRepository} maxLength={165} spellCheck={false} onChange={(event) => { setSourceRepository(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-visible:outline-blue-300" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
              {messages.sourceCommitLabel}
              <input value={sourceCommitSha} maxLength={64} spellCheck={false} onChange={(event) => { setSourceCommitSha(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-visible:outline-blue-300" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
              {messages.sourcePathLabel}
              <input value={sourcePath} maxLength={256} spellCheck={false} onChange={(event) => { setSourcePath(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-visible:outline-blue-300" />
            </label>
          </div>
          <button type="button" onClick={checkSourceScope}
            disabled={!sourceScopePreviewAvailable || sourceScopePending || !sourceRepository.trim() || !sourceCommitSha.trim() || !sourcePath.trim()}
            className="min-h-11 rounded-lg border border-blue-700 px-4 text-sm font-medium text-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200 dark:focus-visible:outline-blue-300">
            {sourceScopePending ? messages.sourceScopeChecking : messages.sourceScopeCheck}
          </button>
          {!sourceScopePreviewAvailable ? <p className="text-sm text-zinc-600 dark:text-zinc-400">{messages.sourceScopeUnavailable}</p> : null}
          {sourceScopeResult.kind === "checked" ? (
            <div role="status" className="space-y-2 text-sm text-zinc-800 dark:text-zinc-100">
              <p>{messages.sourceScopeChecked}</p>
              <code className="block break-all rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">{sourceScopeResult.canonicalScopeJson}</code>
            </div>
          ) : null}
          {sourceScopeResult.kind === "error" ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{messages.sourceScopeError(sourceScopeResult.code)}</p> : null}
        </section>
      ) : null}
      {result ? (
        <div className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100" role="status">
          {errorMessage ? <p>{errorMessage}</p> : null}
          {result.outcome === "input_checked" ? (
            <>
              <p>{messages.result(result.ideaBytes ?? 0, result.repositoryCount ?? 0, result.pullRequestCount ?? 0)}</p>
              <p className="mt-2">{messages.excluded}</p>
            </>
          ) : null}
          {submission.kind === "idle" || submission.kind === "refused" ? (
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">{messages.noWrite}</p>
          ) : null}
        </div>
      ) : null}
      <details className="space-y-2 rounded-xl border border-zinc-300 p-4 text-sm dark:border-zinc-700">
        <summary className="cursor-pointer font-medium">{messages.openSavedTitle}</summary>
        <p>{messages.openSavedHint}</p>
        <label className="block" htmlFor="amux-saved-request-id">{messages.openSavedId}</label>
        <input id="amux-saved-request-id" value={savedRequestId} maxLength={36}
          onChange={(event) => setSavedRequestId(event.target.value)}
          disabled={readBackPending}
          className="min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2 font-mono" />
        <button type="button" onClick={() => void openSavedIdea()}
          disabled={!recoveryChecked || !canOpenSavedIdea(submission.kind,
            pending || readBackPending || sourceScopePending ||
              (submission.kind !== "submitted" && hasUnsavedInput), savedRequestId.trim().toLowerCase())}
          className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
          {messages.openSavedButton}</button>
        {savedRequestError ? <p role="alert">{messages.openSavedFailed}</p> : null}
        {savedRequestReauth ? <a className="underline" href={STEP_UP_HREF}>{messages.stepUp}</a> : null}
      </details>
    </section>
  );
}
