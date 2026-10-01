"use client";

import { useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  classifyIdeaSubmissionPost,
  classifyIdeaSubmissionReadBack,
} from "@/lib/amux/ideaSubmissionUiCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas");

type InputPreviewResult = {
  outcome?: "input_checked";
  error?: string;
  ideaWrites?: number;
  transferReady?: boolean;
  ideaBytes?: number;
  repositoryCount?: number;
  pullRequestCount?: number;
};

type SubmissionState =
  | { kind: "idle" }
  | { kind: "pending"; requestId: string }
  | { kind: "submitted"; requestId: string; ideaId: string }
  | { kind: "outcome_unknown"; requestId: string }
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

export function AmuxIdeaInputPanel({ submissionAvailable }: { submissionAvailable: boolean }) {
  const messages = useAdminMessages(adminAmuxIdeaInputMessages);
  const [idea, setIdea] = useState("");
  const [repositories, setRepositories] = useState("");
  const [pullRequests, setPullRequests] = useState("");
  const [pending, setPending] = useState(false);
  const [readBackPending, setReadBackPending] = useState(false);
  const [result, setResult] = useState<InputPreviewResult | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });
  const inputRevision = useRef(0);

  const invalidateResult = () => {
    inputRevision.current += 1;
    setResult(null);
    setSubmission({ kind: "idle" });
  };

  const readBack = async (requestId: string) => {
    setReadBackPending(true);
    try {
      const response = await adminFetch(
        `/api/admin/amux/ideas/submissions?requestId=${encodeURIComponent(requestId)}`,
        { cache: "no-store" },
      );
      const decision = classifyIdeaSubmissionReadBack({
        status: response.status,
        body: await response.json(),
      });
      setSubmission(decision.kind === "submitted"
        ? { kind: "submitted", requestId, ideaId: decision.ideaId }
        : { kind: "outcome_unknown", requestId });
    } catch {
      setSubmission({ kind: "outcome_unknown", requestId });
    } finally {
      setReadBackPending(false);
    }
  };

  const submit = async () => {
    if (!submissionAvailable || result?.outcome !== "input_checked" ||
        submission.kind === "pending" || submission.kind === "outcome_unknown" ||
        submission.kind === "submitted") return;
    const refs = parsePullRequests(pullRequests);
    if (!refs) return;
    const requestId = crypto.randomUUID();
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
        setSubmission({ kind: "submitted", requestId, ideaId: decision.ideaId });
      } else if (decision.kind === "refused") {
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
  const frozen = submission.kind === "pending" || submission.kind === "outcome_unknown" ||
    submission.kind === "submitted";
  const refusedForStepUp = result?.error === "ADMIN_REAUTHENTICATION_REQUIRED" ||
    (submission.kind === "refused" && submission.code === "ADMIN_REAUTHENTICATION_REQUIRED");
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
          disabled={!submissionAvailable || result?.outcome !== "input_checked" || frozen}
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
        <p role="status" className="text-sm text-zinc-800 dark:text-zinc-100">
          {messages.submitted(submission.ideaId)}
        </p>
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
