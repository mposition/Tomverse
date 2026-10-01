"use client";

import { useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

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

export function AmuxIdeaInputPanel() {
  const messages = useAdminMessages(adminAmuxIdeaInputMessages);
  const [idea, setIdea] = useState("");
  const [repositories, setRepositories] = useState("");
  const [pullRequests, setPullRequests] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<InputPreviewResult | null>(null);
  const inputRevision = useRef(0);

  const invalidateResult = () => {
    inputRevision.current += 1;
    setResult(null);
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
  const refusedForStepUp = result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
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
            disabled={pending}
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
              disabled={pending}
              className="min-h-24 w-full rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm font-normal text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-v4-pull-requests">
            {messages.pullRequestsLabel}
            <textarea
              id="amux-v4-pull-requests"
              value={pullRequests}
              onChange={(event) => { setPullRequests(event.target.value); invalidateResult(); }}
              disabled={pending}
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
          disabled={pending || idea.trim().length === 0 || ideaBytes > 8192}
          className="min-h-11 rounded-lg bg-blue-700 px-4 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:bg-blue-600 dark:focus-visible:outline-blue-300"
        >
          {messages.preview}
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
      <p id="amux-v4-transfer-disabled" className="text-sm text-zinc-700 dark:text-zinc-300">{messages.transferUnavailable}</p>

      {refusedForStepUp ? (
        <a href={STEP_UP_HREF} className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100">{messages.stepUp}</a>
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
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">{messages.noWrite}</p>
        </div>
      ) : null}
    </section>
  );
}
