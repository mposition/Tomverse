"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import type { AgentDigestConsole, QaReleaseConsoleAttempt } from "@/lib/agentDigestConsoleRead";
import { adminFetch } from "@/lib/adminFetch";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const PAGE_PATH = "/admin/agent-digests";
const RELEASE_ROUTE = "/api/admin/agent-digests/qa-release/merge-lane/release";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

type Lane = AgentDigestConsole["mergeLane"];
type Choice = "none" | "not_merged" | "merged_on_develop" | "deployed" | "restored";

/**
 * The develop merge lane in the Agent digest area (docs/policy/qa-release-agent.md
 * version 4, section 8 item 5): whether it is latched and why, and the
 * attempt it holds. Owner and ops may release a latch, optionally ending a
 * stuck attempt by a fact they confirmed; the route checks the role and a
 * recent sign-in again, and a stale sign-in is answered with the way back.
 */
export function QaReleaseMergeLaneSection({ lane, canWrite }: { lane: Lane; canWrite: boolean }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const attempt = lane.openAttempt;
  return (
    <div className="flex flex-col gap-2" data-testid="qa-release-merge-lane">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.laneTitle}</h2>
      <p className={lane.latched ? "text-sm text-amber-800 dark:text-amber-300" : "text-sm text-zinc-600 dark:text-zinc-400"}>
        {lane.latched ? m.laneLatched : m.laneFree}
      </p>
      {lane.latched && lane.latch ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-600 dark:text-zinc-400">{m.latchReason}</dt>
          <dd className="font-mono text-xs" data-testid="qa-release-merge-lane-reason">{lane.latch.reason ?? m.none}</dd>
          <dt className="text-zinc-600 dark:text-zinc-400">{m.latchAt}</dt>
          <dd>{lane.latch.createdAt}</dd>
        </dl>
      ) : null}
      {/* The attempt the latch names: a failed deploy has already closed it,
          and it is what the latch alert sends a person here to read. */}
      {lane.latched && lane.latchAttempt && lane.latchAttempt.id !== attempt?.id ? (
        <>
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.latchAttempt}</h3>
          <AttemptDetails attempt={lane.latchAttempt} testId="qa-release-merge-lane-latch-attempt" />
        </>
      ) : null}
      <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.openAttempt}</h3>
      {attempt ? (
        <AttemptDetails attempt={attempt} testId="qa-release-merge-lane-attempt" />
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.noOpenAttempt}</p>
      )}
      {/* Keyed by the latch event: after a release and refresh the form starts again. */}
      {canWrite && lane.latched ? <ReleaseForm key={lane.latch?.sequence ?? 0} lane={lane} /> : null}
    </div>
  );
}

function AttemptDetails({ attempt, testId }: { attempt: QaReleaseConsoleAttempt; testId: string }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid={testId}>
      <dt className="text-zinc-600 dark:text-zinc-400">{m.attemptId}</dt>
      <dd className="break-all font-mono text-xs">{attempt.id}</dd>
      <dt className="text-zinc-600 dark:text-zinc-400">{m.attemptState}</dt>
      <dd className="font-mono text-xs">
        {attempt.state}
        {attempt.outcome ? ` (${attempt.outcome})` : ""}
      </dd>
      <dt className="text-zinc-600 dark:text-zinc-400">{m.pullRequest}</dt>
      <dd>#{attempt.pullRequestNumber}</dd>
      <dt className="text-zinc-600 dark:text-zinc-400">{m.headSha}</dt>
      <dd className="break-all font-mono text-xs">{attempt.headSha}</dd>
      <dt className="text-zinc-600 dark:text-zinc-400">{m.mergeCommit}</dt>
      <dd className="break-all font-mono text-xs">{attempt.mergeCommitSha ?? m.none}</dd>
      <dt className="text-zinc-600 dark:text-zinc-400">{m.issuedAt}</dt>
      <dd>{attempt.issuedAt}</dd>
      <dt className="text-zinc-600 dark:text-zinc-400">{m.deployObserved}</dt>
      <dd>
        {attempt.deployObservation === null ? (
          m.deployNotObserved
        ) : (
          <>
            <span>{attempt.deployObservedAt}</span>
            <ul className="mt-1 flex flex-col gap-0.5">
              {attempt.deployObservation.map((entry, index) => (
                <li key={`${entry.service}-${index}`} className="break-all font-mono text-xs">
                  {entry.service}: {entry.status} {entry.commitSha ?? m.none}
                </li>
              ))}
            </ul>
          </>
        )}
      </dd>
    </dl>
  );
}

function ReleaseForm({ lane }: { lane: Lane }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const router = useRouter();
  const attempt = lane.openAttempt;
  const [choice, setChoice] = useState<Choice>("none");
  const [mergeCommit, setMergeCommit] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);

  // Two confirmed facts per state, and nothing else (policy section 8 item 5).
  const choices: Choice[] =
    attempt === null
      ? ["none"]
      : attempt.state === "awaiting_deploy"
        ? ["none", "deployed", "restored"]
        : ["none", "not_merged", "merged_on_develop"];
  const label: Record<Choice, string> = {
    none: m.resolveNone,
    not_merged: m.resolveNotMerged,
    merged_on_develop: m.resolveMergedOnDevelop,
    deployed: m.resolveDeployed,
    restored: m.resolveRestored,
  };

  const resolution = () => {
    if (choice === "none" || attempt === null) return null;
    const base = { attemptId: attempt.id, shownState: attempt.state };
    return choice === "merged_on_develop" ? { ...base, fact: choice, mergeCommitSha: mergeCommit.trim() } : { ...base, fact: choice };
  };

  const submit = async () => {
    if (!window.confirm(m.confirmRelease)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await adminFetch(RELEASE_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: resolution() }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        result?: { released?: unknown; sequence?: unknown; reason?: unknown };
      };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthenticationRequired(true);
        return;
      }
      if (response.ok && payload.result?.released === false && typeof payload.result.reason === "string") {
        setNotice({ tone: "error", text: fill(m.releaseRefused, { code: payload.result.reason }) });
        return;
      }
      if (!response.ok || payload.result?.released !== true || typeof payload.result.sequence !== "number") {
        setNotice({ tone: "error", text: m.releaseFailed });
        return;
      }
      setNotice({ tone: "ok", text: fill(m.released, { sequence: payload.result.sequence }) });
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: m.releaseFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
      data-testid="qa-release-merge-lane-release-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{m.releaseTitle}</h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.releaseNote}</p>
      <fieldset className="flex flex-col gap-1">
        {choices.map((value) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name="qa-release-merge-lane-resolution"
              value={value}
              checked={choice === value}
              onChange={() => setChoice(value)}
              data-testid={`qa-release-merge-lane-resolve-${value}`}
            />
            {label[value]}
          </label>
        ))}
      </fieldset>
      {choice === "merged_on_develop" ? (
        <label className="flex flex-col gap-1 text-sm">
          {m.mergeCommit}
          <input
            className="rounded border border-zinc-300 px-2 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            value={mergeCommit}
            onChange={(event) => setMergeCommit(event.target.value)}
            placeholder={m.mergeCommitHint}
            pattern="[0-9a-f]{40}"
            maxLength={40}
            required
            data-testid="qa-release-merge-lane-merge-commit"
          />
        </label>
      ) : null}
      {reauthenticationRequired ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
          {m.reauthenticationRequiredRelease}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {m.signInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className={notice.tone === "ok" ? "text-sm text-zinc-700 dark:text-zinc-300" : "text-sm text-red-700 dark:text-red-300"}
        >
          {notice.text}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="min-h-11 self-start rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        data-testid="qa-release-merge-lane-release"
      >
        {m.release}
      </button>
    </form>
  );
}
