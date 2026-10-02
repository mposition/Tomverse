"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxInitialPlanPanel } from "@/components/admin/AmuxInitialPlanPanel";
import { AmuxFrontierModelsPanel } from "@/components/admin/AmuxFrontierModelsPanel";
import { AmuxSourceScopeApprovalPanel } from "@/components/admin/AmuxSourceScopeApprovalPanel";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  canCreateIdeaFromState,
  canStartAnotherIdea,
  canSelectRecentIdea,
  classifyIdeaSubmissionPost,
  classifyIdeaSubmissionReadBack,
  classifyRecentIdeaList,
  type RecentIdea,
} from "@/lib/amux/ideaSubmissionUiCore";
import {
  clearConfirmedIdeaRequest,
  clearPendingIdeaRequest,
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
  | { kind: "checked"; canonicalScopeJson: string;
      ideaDigest: string; scopeDigest: string; scopeDigestKeyId: string }
  | { kind: "error"; code: string };

type SubmissionState =
  | { kind: "idle" }
  | { kind: "pending"; requestId: string }
  | { kind: "submitted"; requestId: string; ideaId: string; hasExternalSources: boolean }
  | { kind: "outcome_unknown"; requestId: string }
  | { kind: "selection_pending"; requestId: string }
  | { kind: "selection_unavailable"; requestId: string }
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
  sourceScopeApprovalAvailable,
  initialPlanAvailable, frontierModelsAvailable, transferPreviewAvailable,
  transferConfirmAvailable, recentAvailable, operatorId }: {
  submissionAvailable: boolean; sourceScopePreviewAvailable: boolean;
  sourceScopeApprovalAvailable: boolean;
  initialPlanAvailable: boolean; frontierModelsAvailable: boolean;
  transferPreviewAvailable: boolean; transferConfirmAvailable: boolean;
  recentAvailable: boolean; operatorId: string;
}) {
  const messages = useAdminMessages(adminAmuxIdeaInputMessages);
  const { locale } = useAdminLocale();
  const [idea, setIdea] = useState("");
  const [repositories, setRepositories] = useState("");
  const [pullRequests, setPullRequests] = useState("");
  const [pending, setPending] = useState(false);
  const [readBackPending, setReadBackPending] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [result, setResult] = useState<InputPreviewResult | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });
  const [recentIdeas, setRecentIdeas] = useState<RecentIdea[] | null>(null);
  const [recentCursor, setRecentCursor] = useState<string | null>(null);
  const [recentPending, setRecentPending] = useState(false);
  const [recentError, setRecentError] = useState(false);
  const recentRequestGeneration = useRef(0);
  const [planReadyIdeaId, setPlanReadyIdeaId] = useState<string | null>(null);
  const onInitialPlanCommitted = useCallback((committedIdeaId: string) => {
    setPlanReadyIdeaId(committedIdeaId);
  }, []);
  const [sourceRepository, setSourceRepository] = useState("");
  const [sourceKind, setSourceKind] = useState<"repository_file" | "pull_request_file">("repository_file");
  const [sourceCommitSha, setSourceCommitSha] = useState("");
  const [sourcePrNumber, setSourcePrNumber] = useState("");
  const [sourceBaseSha, setSourceBaseSha] = useState("");
  const [sourceHeadSha, setSourceHeadSha] = useState("");
  const [sourceSide, setSourceSide] = useState<"base" | "head">("head");
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

  const startAnotherIdea = () => {
    if (!canStartAnotherIdea(submission.kind, pending || readBackPending || sourceScopePending)) return;
    if (submission.kind === "submitted") {
      clearConfirmedIdeaRequest(receiptStore(), operatorId, submission.requestId);
    } else if (submission.kind === "selection_unavailable") {
      const previous = readConfirmedIdeaRequest(receiptStore(), operatorId);
      if (previous.kind === "confirmed") {
        clearConfirmedIdeaRequest(receiptStore(), operatorId, previous.requestId);
      }
    }
    inputRevision.current += 1;
    inFlight.current = false;
    setIdea("");
    setRepositories("");
    setPullRequests("");
    setResult(null);
    setPlanReadyIdeaId(null);
    setSourceRepository("");
    setSourceKind("repository_file");
    setSourceCommitSha("");
    setSourcePrNumber("");
    setSourceBaseSha("");
    setSourceHeadSha("");
    setSourceSide("head");
    setSourcePath("");
    setSourceScopeResult({ kind: "idle" });
    setSubmission({ kind: "idle" });
  };

  const checkSourceScope = async () => {
    if (submission.kind !== "submitted" || !sourceScopePreviewAvailable || sourceScopePending ||
        !sourceFieldsComplete) return;
    const ideaId = submission.ideaId;
    const source = sourceKind === "repository_file"
      ? { kind: "repository_file", repository: sourceRepository.trim(),
        commitSha: sourceCommitSha.trim(), path: sourcePath.trim() }
      : { kind: "pull_request_file", repository: sourceRepository.trim(),
        number: Number(sourcePrNumber), baseSha: sourceBaseSha.trim(),
        headSha: sourceHeadSha.trim(), side: sourceSide, path: sourcePath.trim() };
    setSourceScopePending(true);
    setSourceScopeResult({ kind: "idle" });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/source-scope-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, ideaId, scopeJson: JSON.stringify({
          version: 1,
          sources: [source],
        }) }),
      });
      setSourceScopeResult(classifySourceScopePreview({ status: response.status, body: await response.json() }, ideaId));
    } catch {
      setSourceScopeResult({ kind: "error", code: "preview_unavailable" });
    } finally {
      setSourceScopePending(false);
    }
  };

  const readBack = useCallback(async (requestId: string,
    purpose: "submission" | "selection" = "submission") => {
    setReadBackPending(true);
    const unavailable = () => {
      if (purpose === "selection") {
        inFlight.current = false;
        setSubmission({ kind: "selection_unavailable", requestId });
      } else {
        setSubmission({ kind: "outcome_unknown", requestId });
      }
    };
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
        inFlight.current = true;
        setSubmission({ kind: "submitted", requestId, ideaId: decision.ideaId,
          hasExternalSources: decision.hasExternalSources });
      } else {
        unavailable();
      }
    } catch {
      unavailable();
    } finally {
      setReadBackPending(false);
    }
  }, [operatorId]);

  const refreshRecentIdeas = useCallback(async () => {
    if (!recentAvailable) return;
    const generation = ++recentRequestGeneration.current;
    setRecentPending(true);
    setRecentError(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/submissions?view=recent",
        { cache: "no-store" });
      const page = classifyRecentIdeaList({ status: response.status, body: await response.json() });
      if (!page) throw new Error("recent_ideas_unavailable");
      if (generation === recentRequestGeneration.current) {
        setRecentIdeas(page.items);
        setRecentCursor(page.nextCursor);
      }
    } catch { if (generation === recentRequestGeneration.current) setRecentError(true); }
    finally { if (generation === recentRequestGeneration.current) setRecentPending(false); }
  }, [recentAvailable]);

  const loadMoreRecentIdeas = async () => {
    if (!recentAvailable || !recentCursor || recentPending || !recentIdeas) return;
    const generation = recentRequestGeneration.current;
    setRecentPending(true);
    setRecentError(false);
    try {
      const query = new URLSearchParams({ view: "recent", cursor: recentCursor });
      const response = await adminFetch(`/api/admin/amux/ideas/submissions?${query}`,
        { cache: "no-store" });
      const page = classifyRecentIdeaList({ status: response.status, body: await response.json() });
      if (!page || page.items.some((item) => recentIdeas.some((seen) => seen.requestId === item.requestId))) {
        throw new Error("recent_ideas_unavailable");
      }
      if (generation === recentRequestGeneration.current) {
        setRecentIdeas([...recentIdeas, ...page.items]);
        setRecentCursor(page.nextCursor);
      }
    } catch { if (generation === recentRequestGeneration.current) setRecentError(true); }
    finally { if (generation === recentRequestGeneration.current) setRecentPending(false); }
  };

  useEffect(() => { queueMicrotask(() => { void refreshRecentIdeas(); }); }, [refreshRecentIdeas]);

  const selectRecentIdea = (requestId: string) => {
    if (!recoveryChecked || !canSelectRecentIdea(submission.kind,
      pending || readBackPending || sourceScopePending) ||
      (submission.kind !== "submitted" &&
        (!!idea.trim() || !!repositories.trim() || !!pullRequests.trim())) ||
      !recentIdeas?.some((row) => row.requestId === requestId)) return;
    inputRevision.current += 1;
    setIdea("");
    setRepositories("");
    setPullRequests("");
    setResult(null);
    setPlanReadyIdeaId(null);
    setSourceRepository("");
    setSourceKind("repository_file");
    setSourceCommitSha("");
    setSourcePrNumber("");
    setSourceBaseSha("");
    setSourceHeadSha("");
    setSourceSide("head");
    setSourcePath("");
    setSourceScopeResult({ kind: "idle" });
    inFlight.current = true;
    setSubmission({ kind: "selection_pending", requestId });
    void readBack(requestId, "selection");
  };

  useEffect(() => {
    let active = true;
    const recovered = readPendingIdeaRequest(receiptStore(), operatorId);
    const confirmed = recovered.kind === "none"
      ? readConfirmedIdeaRequest(receiptStore(), operatorId) : null;
    queueMicrotask(() => {
      if (!active) return;
      if (recovered.kind === "unavailable") {
        setSubmission({ kind: "recovery_unavailable" });
      } else if (recovered.kind === "pending") {
        inFlight.current = true;
        setSubmission({ kind: "outcome_unknown", requestId: recovered.requestId });
        void readBack(recovered.requestId);
      } else if (confirmed?.kind === "confirmed") {
        inFlight.current = true;
        setSubmission({ kind: "outcome_unknown", requestId: confirmed.requestId });
        void readBack(confirmed.requestId);
      } else if (confirmed?.kind === "unavailable") {
        setSubmission({ kind: "recovery_unavailable" });
      }
      setRecoveryChecked(true);
    });
    return () => { active = false; };
  }, [operatorId, readBack]);

  const submit = async () => {
    if (!submissionAvailable || !recoveryChecked || inFlight.current ||
        result?.outcome !== "input_checked" ||
        !canCreateIdeaFromState(submission.kind)) return;
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
  const sourceFieldsComplete = !!sourceRepository.trim() && !!sourcePath.trim() &&
    (sourceKind === "repository_file" ? !!sourceCommitSha.trim() :
      /^[1-9]\d*$/.test(sourcePrNumber) && Number.isSafeInteger(Number(sourcePrNumber)) &&
      !!sourceBaseSha.trim() && !!sourceHeadSha.trim());
  const frozen = !canCreateIdeaFromState(submission.kind);
  const refusedForStepUp = result?.error === "ADMIN_REAUTHENTICATION_REQUIRED" ||
    (submission.kind === "refused" && submission.code === "ADMIN_REAUTHENTICATION_REQUIRED") ||
    (sourceScopeResult.kind === "error" && sourceScopeResult.code === "ADMIN_REAUTHENTICATION_REQUIRED");
  const errorMessage = result?.error
    ? (messages.errors[result.error as keyof typeof messages.errors] ?? messages.errors.preview_failed)
    : null;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4" data-testid="amux-v4-idea-input">
      <div className="space-y-2 border-b border-zinc-200 pb-5 dark:border-zinc-800">
        <p className="text-xs font-semibold tracking-[0.18em] text-blue-700 uppercase dark:text-blue-300">{messages.step}</p>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">{messages.title}</h2>
        <p className="max-w-2xl text-sm leading-6 text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(17rem,0.85fr)]">
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 text-sm font-medium text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
          <h3 className="text-base font-semibold">{messages.ideaSection}</h3>
          <label htmlFor="amux-v4-idea">{messages.ideaLabel}</label>
          <textarea
            id="amux-v4-idea"
            value={idea}
            onChange={(event) => { setIdea(event.target.value); invalidateResult(); }}
            disabled={pending || frozen}
            maxLength={8192}
            className="min-h-56 w-full rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-base font-normal text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            aria-describedby="amux-v4-idea-hint amux-v4-idea-count"
          />
          <span id="amux-v4-idea-count" className="text-xs font-normal text-zinc-600 dark:text-zinc-400">{messages.byteCount(ideaBytes)}</span>
          <span id="amux-v4-idea-hint" className="text-xs font-normal text-zinc-600 dark:text-zinc-400">{messages.ideaHint}</span>
        </div>

        <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{messages.sourceSection}</h3>
            <p className="text-xs leading-5 text-zinc-600 dark:text-zinc-400">{messages.sourceSectionHint}</p>
          </div>
          <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-v4-repositories">
            {messages.repositoriesLabel}
            <textarea
              id="amux-v4-repositories"
              value={repositories}
              onChange={(event) => { setRepositories(event.target.value); invalidateResult(); }}
              disabled={pending || frozen}
              className="min-h-24 w-full rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm font-normal text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-v4-pull-requests">
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
      </div>

      <section className="overflow-hidden rounded-xl border border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/30" aria-labelledby="amux-v4-boundary-heading">
        <div className="h-1 bg-blue-600 dark:bg-blue-400" aria-hidden="true" />
        <h3 id="amux-v4-boundary-heading" className="px-4 pt-4 text-sm font-semibold text-blue-900 dark:text-blue-200">{messages.boundaryTitle}</h3>
        <div className="grid md:grid-cols-2">
          <div className="space-y-1 p-4 md:border-r md:border-blue-200 dark:md:border-blue-900">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{messages.boundaryCurrent}</p>
            <p className="text-xs leading-5 text-zinc-700 dark:text-zinc-300">{messages.boundaryCurrentDetail}</p>
          </div>
          <div className="space-y-1 border-t border-blue-200 p-4 md:border-t-0 dark:border-blue-900">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{messages.boundaryNext}</p>
            <p className="text-xs leading-5 text-zinc-700 dark:text-zinc-300">{messages.boundaryNextDetail}</p>
          </div>
        </div>
      </section>

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
          {submission.kind === "pending" ? messages.submitting : messages.submit}
        </button>
        <button
          type="button"
          disabled
          aria-describedby="amux-v4-transfer-disabled"
          className="min-h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-900 opacity-50 dark:border-zinc-600 dark:text-zinc-100"
        >
          {messages.transfer}
        </button>
      </div>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        {submissionAvailable ? messages.submitBoundary : messages.submitUnavailable}
      </p>
      <p id="amux-v4-transfer-disabled" className="text-sm text-zinc-700 dark:text-zinc-300">{messages.transferUnavailable}</p>

      {refusedForStepUp ? (
        <a href={STEP_UP_HREF} className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100">{messages.stepUp}</a>
      ) : null}
      {submission.kind === "refused" ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {messages.submitErrors[submission.code as keyof typeof messages.submitErrors] ?? messages.submitErrors.submit_failed}
        </p>
      ) : null}
      {submission.kind === "submitted" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-zinc-800 dark:text-zinc-100">
            {messages.submitted(submission.ideaId)}
          </p>
          <button
            type="button"
            onClick={startAnotherIdea}
            disabled={!canStartAnotherIdea(submission.kind, pending || readBackPending || sourceScopePending)}
            className="min-h-11 rounded-lg border border-zinc-400 px-4 text-sm font-medium text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          >
            {messages.startAnotherIdea}
          </button>
        </div>
      ) : null}
      {submission.kind === "outcome_unknown" ? (
        <div role="alert" className="space-y-2 text-sm text-amber-800 dark:text-amber-200">
          <p>{messages.outcomeUnknown(submission.requestId)}</p>
          <button
            type="button"
            onClick={() => readBack(submission.requestId)}
            disabled={readBackPending}
            className="min-h-11 rounded-lg border border-amber-700 px-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:opacity-50 dark:border-amber-300"
          >
            {messages.checkSubmissionStatus}
          </button>
          <a href={STEP_UP_HREF} className="ml-3 font-medium underline">{messages.stepUp}</a>
        </div>
      ) : null}
      {submission.kind === "selection_pending" ? <p role="status">{messages.recentIdeaChecking}</p> : null}
      {submission.kind === "selection_unavailable" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-amber-800 dark:text-amber-200">
          <p>{messages.recentIdeaUnavailable}</p>
          <button type="button" onClick={() => selectRecentIdea(submission.requestId)}
            disabled={readBackPending || recentPending}
            className="min-h-11 rounded-lg border border-amber-700 px-3 font-medium dark:border-amber-300">
            {messages.checkSubmissionStatus}
          </button>
          <button type="button" onClick={startAnotherIdea}
            disabled={!canStartAnotherIdea(submission.kind, pending || readBackPending || sourceScopePending)}
            className="min-h-11 rounded-lg border border-zinc-400 px-3 font-medium dark:border-zinc-600">
            {messages.startAnotherIdea}
          </button>
        </div>
      ) : null}
      {recentAvailable ? (
        <section className="space-y-3 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
          aria-labelledby="amux-v4-recent-ideas-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 id="amux-v4-recent-ideas-heading" className="font-semibold text-zinc-900 dark:text-zinc-100">{messages.recentIdeasTitle}</h3>
              <p className="text-zinc-600 dark:text-zinc-400">{messages.recentIdeasHint}</p>
            </div>
            <button type="button" onClick={refreshRecentIdeas} disabled={recentPending}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 font-medium disabled:opacity-50 dark:border-zinc-600">
              {messages.recentIdeasRefresh}
            </button>
          </div>
          {recentPending ? <p role="status">{messages.recentIdeasLoading}</p> : null}
          {recentError ? <p role="alert">{messages.recentIdeasError}</p> : null}
          {submission.kind !== "submitted" &&
            (!!idea.trim() || !!repositories.trim() || !!pullRequests.trim()) ?
            <p>{messages.recentIdeasUnsaved}</p> : null}
          {!recentPending && !recentError && recentIdeas?.length === 0 ? <p>{messages.recentIdeasEmpty}</p> : null}
          {recentIdeas && recentIdeas.length > 0 ? (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {recentIdeas.map((row) => (
                <li key={row.requestId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="break-all text-zinc-700 dark:text-zinc-300">
                    {messages.recentIdeaLabel(row.ideaId, new Date(row.submittedAt).toLocaleString(locale))}
                  </span>
                  <button type="button" onClick={() => selectRecentIdea(row.requestId)}
                    disabled={!recoveryChecked || !canSelectRecentIdea(submission.kind,
                      pending || readBackPending || sourceScopePending) ||
                      (submission.kind !== "submitted" &&
                        (!!idea.trim() || !!repositories.trim() || !!pullRequests.trim())) ||
                      (submission.kind === "submitted" && submission.requestId === row.requestId)}
                    className="min-h-11 rounded-lg border border-blue-700 px-3 font-medium text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
                    {messages.recentIdeaOpen}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {recentCursor ? (
            <button type="button" onClick={loadMoreRecentIdeas} disabled={recentPending}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 font-medium disabled:opacity-50 dark:border-zinc-600">
              {messages.recentIdeasMore}
            </button>
          ) : null}
        </section>
      ) : null}
      <AmuxInitialPlanPanel
        key={submission.kind === "submitted" ? submission.ideaId : "none"}
        ideaId={submission.kind === "submitted" ? submission.ideaId : null}
        operatorId={operatorId} available={initialPlanAvailable}
        declaredExternalSources={submission.kind === "submitted" && submission.hasExternalSources}
        onCommitted={onInitialPlanCommitted}
      />
      <AmuxFrontierModelsPanel
        key={submission.kind === "submitted" ? submission.ideaId : "none"}
        available={frontierModelsAvailable}
        previewAvailable={transferPreviewAvailable}
        confirmAvailable={transferConfirmAvailable}
        ideaId={submission.kind === "submitted" ? submission.ideaId : null}
        planReady={submission.kind === "submitted" && planReadyIdeaId === submission.ideaId}
        declaredExternalSources={submission.kind === "submitted" && submission.hasExternalSources}
        operatorId={operatorId}
      />
      {submission.kind === "submitted" ? (
        <section className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800" aria-labelledby="amux-v4-source-scope-heading">
          <h3 id="amux-v4-source-scope-heading" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{messages.sourceScopeTitle}</h3>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.sourceScopeHint}</p>
          <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
            {messages.sourceKindLabel}
            <select value={sourceKind} onChange={(event) => {
              setSourceKind(event.target.value as "repository_file" | "pull_request_file");
              setSourceScopeResult({ kind: "idle" });
            }} disabled={sourceScopePending}
            className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900">
              <option value="repository_file">{messages.sourceRepositoryFile}</option>
              <option value="pull_request_file">{messages.sourcePullRequestFile}</option>
            </select>
          </label>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
              {messages.sourceRepositoryLabel}
              <input value={sourceRepository} maxLength={165} spellCheck={false} onChange={(event) => { setSourceRepository(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
            {sourceKind === "repository_file" ? (
              <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
                {messages.sourceCommitLabel}
                <input value={sourceCommitSha} maxLength={64} spellCheck={false} onChange={(event) => { setSourceCommitSha(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                  disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900" />
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
                  {messages.sourcePrNumberLabel}
                  <input value={sourcePrNumber} maxLength={20} inputMode="numeric" onChange={(event) => { setSourcePrNumber(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                    disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900" />
                </label>
                <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
                  {messages.sourceBaseShaLabel}
                  <input value={sourceBaseSha} maxLength={64} spellCheck={false} onChange={(event) => { setSourceBaseSha(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                    disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900" />
                </label>
                <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
                  {messages.sourceHeadShaLabel}
                  <input value={sourceHeadSha} maxLength={64} spellCheck={false} onChange={(event) => { setSourceHeadSha(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                    disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900" />
                </label>
                <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
                  {messages.sourceSideLabel}
                  <select value={sourceSide} onChange={(event) => { setSourceSide(event.target.value as "base" | "head"); setSourceScopeResult({ kind: "idle" }); }}
                    disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900">
                    <option value="head">{messages.sourceHeadSide}</option>
                    <option value="base">{messages.sourceBaseSide}</option>
                  </select>
                </label>
              </>
            )}
            <label className="flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-100">
              {messages.sourcePathLabel}
              <input value={sourcePath} maxLength={256} spellCheck={false} onChange={(event) => { setSourcePath(event.target.value); setSourceScopeResult({ kind: "idle" }); }}
                disabled={sourceScopePending} className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
          </div>
          <button type="button" onClick={checkSourceScope}
            disabled={!sourceScopePreviewAvailable || sourceScopePending || !sourceFieldsComplete}
            className="min-h-11 rounded-lg border border-blue-700 px-4 text-sm font-medium text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
            {sourceScopePending ? messages.sourceScopeChecking : messages.sourceScopeCheck}
          </button>
          {!sourceScopePreviewAvailable ? <p className="text-sm text-zinc-600 dark:text-zinc-400">{messages.sourceScopeUnavailable}</p> : null}
          {sourceScopeResult.kind === "checked" ? (
            <div role="status" className="space-y-2 text-sm text-zinc-800 dark:text-zinc-100">
              <p>{messages.sourceScopeChecked}</p>
              <code className="block break-all rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">{sourceScopeResult.canonicalScopeJson}</code>
              <AmuxSourceScopeApprovalPanel
                key={`${submission.ideaId}:${sourceScopeResult.scopeDigest}`}
                ideaId={submission.ideaId} operatorId={operatorId}
                checked={sourceScopeResult} available={sourceScopeApprovalAvailable} />
            </div>
          ) : null}
          {sourceScopeResult.kind === "error" ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{messages.sourceScopeError(sourceScopeResult.code)}</p> : null}
        </section>
      ) : null}
      {submission.kind === "recovery_unavailable" ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {messages.recoveryUnavailable}
        </p>
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
    </section>
  );
}
