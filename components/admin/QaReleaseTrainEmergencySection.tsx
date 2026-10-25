"use client";

import { useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { useQaReleaseTrainReads } from "@/components/admin/QaReleaseTrainRefresher";
import { announceQaReleaseTrainChanged, card } from "@/components/admin/qaReleaseTabParts";
import { adminFetch } from "@/lib/adminFetch";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import { adminQaReleaseTrainMessages } from "@/lib/adminMessages/qaReleaseTrain";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { aestStamp } from "@/lib/agentOffice/time";
import {
  QA_RELEASE_TRAIN_CARGO_MAX,
  parseQaReleaseTrainEmergencyReason,
  qaReleaseTrainCargoPickable,
  type QaReleaseTrainEmergency,
} from "@/lib/qaReleaseTrainCargoCore";
import type { QaReleaseTrainCargoCandidatesRead } from "@/lib/qaReleaseTrainCargoRead";

const API = "/api/admin/agent-digests/qa-release/train-emergency";
const READ_API = "/api/admin/agent-digests/qa-release/train-cargo";
const PAGE_PATH = "/admin/qa-release?tab=train";
const SHOWN_MATCHES = 8;

type View = { candidates: QaReleaseTrainCargoCandidatesRead; selection: { emergency: QaReleaseTrainEmergency } };

/**
 * An emergency release train (owner request 2026-10-25): owner or ops picks
 * pull requests that can ride and writes a reason; the train service departs
 * with them on its next round. A pending request can be withdrawn.
 */
export function QaReleaseTrainEmergencySection({ canWrite, openUnknown = false }: { canWrite: boolean; openUnknown?: boolean }) {
  const m = useAdminMessages(adminQaReleaseTrainMessages);
  const common = useAdminMessages(adminAgentDigestsMessages);
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  // Read again after any save on the tab or its "Read again": a request the
  // train has since spent is not left showing as pending.
  const reads = useQaReleaseTrainReads();

  useEffect(() => {
    let cancelled = false;
    adminFetch(reads.fresh ? `${READ_API}?fresh=1` : READ_API, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<View>;
      })
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reads.key, reads.fresh]);

  const emergency = view?.selection.emergency ?? null;
  const candidates = view?.candidates.status === "ok" ? view.candidates.candidates.filter((c) => qaReleaseTrainCargoPickable(c.status)) : [];
  const title = (number: number) => candidates.find((c) => c.number === number)?.title ?? "";
  const needle = query.trim().toLowerCase();
  const matches =
    needle === "" ? [] : candidates.filter((c) => !picked.includes(c.number) && `#${c.number} ${c.title}`.toLowerCase().includes(needle)).slice(0, SHOWN_MATCHES);

  const send = async (body: { numbers: number[]; reason: string }, ok: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await adminFetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = (await response.json().catch(() => ({}))) as { code?: unknown; result?: QaReleaseTrainEmergency };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthenticationRequired(true);
        return;
      }
      if (!response.ok || !payload.result) {
        setNotice({ tone: "error", text: m.emergencyFailed });
        return;
      }
      setView((current) => (current ? { ...current, selection: { ...current.selection, emergency: payload.result! } } : current));
      setEditing(false);
      setPicked([]);
      setReason("");
      setNotice({ tone: "ok", text: ok });
      announceQaReleaseTrainChanged();
    } catch {
      setNotice({ tone: "error", text: m.emergencyFailed });
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (picked.length === 0) return setError(m.emergencyNeedPulls);
    if (parseQaReleaseTrainEmergencyReason(reason) === null) return setError(m.emergencyNeedReason);
    setError(null);
    void send({ numbers: picked, reason }, m.emergencySaved);
  };

  const button =
    "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium disabled:opacity-50";

  return (
    <section className={card} data-testid="qa-release-train-emergency">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-semibold text-zinc-100">{m.emergencyTitle}</h3>
        <span className="text-xs text-zinc-400">{m.emergencyPermission}</span>
        {canWrite && !editing && !emergency?.pending ? (
          <button
            type="button"
            className={`${button} ml-auto border-red-400/50 text-red-300 hover:border-red-300`}
            onClick={() => setEditing(true)}
            data-testid="qa-release-train-emergency-open"
          >
            {m.emergencyOpen}
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-zinc-400">{m.emergencyNote}</p>
      {openUnknown ? (
        <p className="mt-2 text-[13px] text-amber-300" data-testid="qa-release-train-emergency-open-unknown">
          {m.emergencyOpenUnknown}
        </p>
      ) : null}

      {emergency?.pending ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-400/40 bg-red-400/5 px-3 py-2" data-testid="qa-release-train-emergency-pending">
          <p className="min-w-0 flex-1 text-sm text-red-200">
            {m.emergencyPending
              .replace("{at}", aestStamp(emergency.pending.requestedAt))
              .replace("{by}", emergency.pending.requestedBy ?? "-")
              .replace("{numbers}", emergency.pending.numbers.map((n) => `#${n}`).join(", "))
              .replace("{reason}", emergency.pending.reason)}
          </p>
          {canWrite ? (
            <button
              type="button"
              className={`${button} border-zinc-700 text-zinc-300 hover:border-zinc-500`}
              disabled={busy}
              onClick={() => void send({ numbers: [], reason: "Withdrawn in Admin." }, m.emergencyWithdrawn)}
            >
              {m.emergencyWithdraw}
            </button>
          ) : null}
        </div>
      ) : emergency?.departedWith ? (
        <p className="mt-2 text-[13px] text-zinc-400">{m.emergencyDeparted.replace("{slot}", emergency.departedWith)}</p>
      ) : null}

      {editing ? (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-red-400/40 p-3" data-testid="qa-release-train-emergency-form">
          {failed || view?.candidates.status === "unread" ? <p className="text-sm text-amber-300">{m.emergencyUnread}</p> : null}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-400">{m.emergencyPulls}</span>
            <div className="flex flex-wrap gap-1.5">
              {picked.map((number) => (
                <button
                  key={number}
                  type="button"
                  className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-red-400/15 px-2 py-1 text-xs text-red-200"
                  aria-label={m.emergencyRemove.replace("{number}", String(number))}
                  onClick={() => setPicked((current) => current.filter((n) => n !== number))}
                >
                  <span className="font-mono">#{number}</span> <span className="truncate">{title(number)}</span> ×
                </button>
              ))}
            </div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={m.emergencyFind}
              aria-label={m.emergencyFind}
              className="min-h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100"
            />
            {needle !== "" ? (
              matches.length === 0 ? (
                <p className="text-xs text-zinc-500">{m.emergencyNoMatch}</p>
              ) : (
                <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                  {matches.map((c) => (
                    <li key={c.number}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                        disabled={picked.length >= QA_RELEASE_TRAIN_CARGO_MAX}
                        onClick={() => {
                          setPicked((current) => [...current, c.number]);
                          setQuery("");
                          setError(null);
                        }}
                      >
                        <span className="w-14 shrink-0 font-mono text-[13px] text-zinc-400">#{c.number}</span>
                        <span className="truncate">{c.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-400">{m.emergencyReason}</span>
            <input
              type="text"
              value={reason}
              maxLength={300}
              onChange={(event) => {
                setReason(event.target.value);
                setError(null);
              }}
              placeholder={m.emergencyReasonPlaceholder}
              className="min-h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-red-300">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={`${button} border-zinc-700 text-zinc-300 hover:border-zinc-500`}
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              {m.emergencyCancel}
            </button>
            <button
              type="button"
              className={`${button} border-red-400/60 bg-red-500/10 text-red-200 hover:border-red-300`}
              disabled={busy}
              onClick={submit}
              data-testid="qa-release-train-emergency-submit"
            >
              {m.emergencySubmit}
            </button>
          </div>
        </div>
      ) : null}

      {reauthenticationRequired ? (
        <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-amber-300">
          {m.emergencyReauth}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {common.signInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={`mt-3 text-sm ${notice.tone === "ok" ? "text-emerald-300" : "text-amber-300"}`}>
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
