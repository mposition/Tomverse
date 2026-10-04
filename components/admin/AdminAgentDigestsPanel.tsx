"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { QaReleaseMergeLaneSection } from "@/components/admin/QaReleaseMergeLaneSection";
import type { AgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { adminFetch } from "@/lib/adminFetch";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { QA_RELEASE_SECRET_ROTATION_FIELDS } from "@/lib/qaReleaseOperatorControlFields";

const PAGE_PATH = "/admin/agent-digests";
const CONTROL_ROUTE = "/api/admin/agent-digests/qa-release/control";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

/**
 * The QA-release section of the common Agent digest area: the newest
 * operator control revision and the recent digests, as counts and codes.
 * The one control here records the next operator control revision
 * (docs/policy/qa-release-agent.md sections 4 and 6), offered only to owner
 * and ops; its route checks the role and a recent sign-in again, and a stale
 * sign-in is answered with the way back. The develop merge lane's latch and
 * its release are QaReleaseMergeLaneSection.
 */
export function AdminAgentDigestsPanel({ initial }: { initial: AgentDigestConsole }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const onOff = (value: boolean) => (value ? m.on : m.off);

  return (
    <section className="flex min-w-0 flex-col gap-5">
      <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <Lock className="h-4 w-4" aria-hidden="true" />
        {m.readOnlyNote}
      </p>

      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.controlTitle}</h2>
        {initial.control ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="agent-digest-control">
            <dt className="text-zinc-600 dark:text-zinc-400">{m.revision}</dt>
            <dd>{initial.control.revision}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.digestEnabled}</dt>
            <dd>{onOff(initial.control.digestEnabled)}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.mergeLaneEnabled}</dt>
            <dd>{onOff(initial.control.mergeLaneEnabled)}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.developLaneOn}</dt>
            <dd>{onOff(initial.control.developLaneOn)}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.iacCommit}</dt>
            <dd className="break-all font-mono text-xs">{initial.control.iacCommit ?? m.none}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.recordedAt}</dt>
            <dd>{initial.control.createdAt}</dd>
          </dl>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.controlNone}</p>
        )}
      </div>

      {/* Keyed by revision: after a save and refresh the form starts from the new record. */}
      {initial.canWrite ? (
        <QaReleaseControlForm key={initial.control?.revision ?? 0} current={initial.control} />
      ) : null}

      <QaReleaseMergeLaneSection lane={initial.mergeLane} canWrite={initial.canWrite} />

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.digestsTitle}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{fill(m.showingNewest, { count: initial.limit })}</p>
        {initial.digests.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.emptyDigests}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="agent-digest-list">
            {initial.digests.map((row) => (
              <li key={row.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {m.digestDate}: {row.digestDate ?? m.none}
                </p>
                <p className="text-zinc-600 dark:text-zinc-400">
                  {m.stored}: {row.createdAt} · {m.size}: {row.sizeBytes} B ·{" "}
                  <span className="break-all font-mono text-xs">{row.payloadSha256}</span>
                </p>
                {row.body === "expired" ? <p className="text-zinc-600 dark:text-zinc-400">{m.bodyExpired}</p> : null}
                {row.body === "unreadable" ? <p className="text-amber-800 dark:text-amber-300">{m.bodyUnreadable}</p> : null}
                {row.summary ? (
                  <div className="mt-2 flex flex-col gap-1 text-zinc-700 dark:text-zinc-300">
                    <p>
                      {m.gates}:{" "}
                      {Object.entries(row.summary.gatesByVerdict)
                        .map(([verdict, count]) => `${verdict} ${count}`)
                        .join(", ")}
                    </p>
                    <p>
                      {row.summary.issuesAvailable
                        ? fill(m.issues, { candidates: row.summary.issueCandidates, blocked: row.summary.issueBlocked })
                        : m.issuesUnavailable}
                    </p>
                    <p>{fill(m.checks, { count: row.summary.failedChecks })}</p>
                    <p>{fill(m.ci, { count: row.summary.failedCiJobs })}</p>
                    {row.summary.notChecked.length > 0 ? (
                      <p>
                        {m.notChecked}: <span className="font-mono text-xs">{row.summary.notChecked.join(", ")}</span>
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

type Notice = { tone: "ok" | "error"; text: string } | null;

/** An ISO instant as a datetime-local value in the viewer's own zone. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function QaReleaseControlForm({ current }: { current: AgentDigestConsole["control"] }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const router = useRouter();
  const [digestEnabled, setDigestEnabled] = useState(current?.digestEnabled ?? false);
  const [mergeLaneEnabled, setMergeLaneEnabled] = useState(current?.mergeLaneEnabled ?? false);
  const [developLaneOn, setDevelopLaneOn] = useState(current?.developLaneOn ?? false);
  const [iacCommit, setIacCommit] = useState(current?.iacCommit ?? "");
  const [rotated, setRotated] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      QA_RELEASE_SECRET_ROTATION_FIELDS.map((field) => [field, toLocalInput(current?.rotatedAt[field] ?? null)]),
    ),
  );
  // Only the fields a person changed are re-read from the minute-precision
  // input; an untouched one sends its recorded instant unchanged.
  const [edited, setEdited] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);

  const submit = async () => {
    if (!window.confirm(m.confirmSave)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await adminFetch(CONTROL_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          digestEnabled,
          mergeLaneEnabled,
          developLaneOn,
          iacCommit: iacCommit.trim() === "" ? null : iacCommit.trim(),
          ...Object.fromEntries(
            QA_RELEASE_SECRET_ROTATION_FIELDS.map((field) => [
              field,
              edited.has(field)
                ? rotated[field]
                  ? new Date(rotated[field]).toISOString()
                  : null
                : (current?.rotatedAt[field] ?? null),
            ]),
          ),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        result?: { revision?: unknown };
      };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthenticationRequired(true);
        return;
      }
      if (response.status === 409 && typeof payload.code === "string") {
        setNotice({ tone: "error", text: fill(m.refused, { code: payload.code }) });
        return;
      }
      if (!response.ok || typeof payload.result?.revision !== "number") {
        setNotice({ tone: "error", text: m.failed });
        return;
      }
      setNotice({ tone: "ok", text: fill(m.saved, { revision: payload.result.revision }) });
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: m.failed });
    } finally {
      setBusy(false);
    }
  };

  const checkbox = (label: string, value: boolean, set: (next: boolean) => void, testId: string) => (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input type="checkbox" checked={value} onChange={(event) => set(event.target.checked)} data-testid={testId} />
      {label}
    </label>
  );

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
      data-testid="qa-release-control-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.formTitle}</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.formNote}</p>
      {checkbox(m.digestEnabled, digestEnabled, setDigestEnabled, "qa-release-control-digest")}
      {checkbox(m.mergeLaneEnabled, mergeLaneEnabled, setMergeLaneEnabled, "qa-release-control-merge-lane")}
      {checkbox(m.developLaneOn, developLaneOn, setDevelopLaneOn, "qa-release-control-develop-lane")}
      <label className="flex flex-col gap-1 text-sm">
        {m.iacCommit}
        <input
          className="rounded border border-zinc-300 px-2 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          value={iacCommit}
          onChange={(event) => setIacCommit(event.target.value)}
          placeholder={m.iacCommitHint}
          pattern="[0-9a-f]{40}"
          maxLength={40}
          data-testid="qa-release-control-iac"
        />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{m.rotationTitle}</legend>
        {QA_RELEASE_SECRET_ROTATION_FIELDS.map((field) => (
          <label key={field} className="flex flex-col gap-1 text-sm">
            {m[field]}
            <input
              type="datetime-local"
              className="rounded border border-zinc-300 px-2 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              value={rotated[field]}
              onChange={(event) => {
                const value = event.target.value;
                setRotated((previous) => ({ ...previous, [field]: value }));
                setEdited((previous) => new Set(previous).add(field));
              }}
            />
          </label>
        ))}
      </fieldset>
      {reauthenticationRequired ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
          {m.reauthenticationRequired}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {m.signInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className={
            notice.tone === "ok" ? "text-sm text-zinc-700 dark:text-zinc-300" : "text-sm text-red-700 dark:text-red-300"
          }
        >
          {notice.text}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="min-h-11 self-start rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        data-testid="qa-release-control-save"
      >
        {m.save}
      </button>
    </form>
  );
}
