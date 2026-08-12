"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Download, Loader2, ShieldCheck, X } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";

/**
 * /settings/data -- the surface PRIVACY-02 was missing.
 *
 * The export API has existed for a while with nothing linking to it, which
 * meant the gate's actual requirement -- that a user can obtain their data --
 * was not met however correct the backend was.
 *
 * The two-step flow is visible here rather than hidden, because each step is a
 * promise the product is making. Asking for the file requires a recent sign-in;
 * the link that comes back works once and dies in five minutes; and every
 * request, download and refusal is listed underneath. That last part is not
 * decoration: a refused row is how somebody finds out a link of theirs was
 * presented by someone else.
 */

type ExportHistoryEntry = {
  id: string;
  status: string;
  refusalReason: string | null;
  expiresAt: string;
  consumedAt: string | null;
  byteLength: number | null;
  includedDomainCount: number | null;
  filteredDomainCount: number | null;
  createdAt: string;
};

type Ticket = { downloadPath: string; expiresAt: string };

type Phase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "ready"; ticket: Ticket }
  | { kind: "reauthRequired" }
  | { kind: "error"; message: string };

const REMAINING_TICK_MS = 1_000;

/** `4:59`, counted down to zero and no further. */
const formatRemaining = (milliseconds: number) => {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const formatBytes = (bytes: number | null) => {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function AccountDataDownload() {
  const { t } = useLanguage();
  const formatCopy = (key: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      t(key)
    );
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [history, setHistory] = useState<ExportHistoryEntry[] | null>(null);
  const [remaining, setRemaining] = useState(0);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/user/account/export", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { requests?: ExportHistoryEntry[] };
      setHistory(body.requests ?? []);
    } catch {
      // The history is context, not the task. A failure to load it must not
      // stop somebody downloading their data.
    }
  }, []);

  useEffect(() => {
    // Deferred out of the effect body for the same reason the memory settings
    // do it: the loader resolves into setState, and calling it synchronously
    // here is a cascading render the lint rule exists to stop.
    queueMicrotask(() => {
      void loadHistory();
    });
  }, [loadHistory]);

  // The countdown is the honest representation of what the link is: not a
  // button that might stop working, but one that will.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const expiry = Date.parse(phase.ticket.expiresAt);
    const tick = () => setRemaining(expiry - Date.now());
    queueMicrotask(tick);
    const timer = setInterval(tick, REMAINING_TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

  const expired = phase.kind === "ready" && remaining <= 0;

  const requestDownload = useCallback(async () => {
    setPhase({ kind: "requesting" });
    try {
      const response = await fetch("/api/user/account/export", {
        method: "POST",
        cache: "no-store",
      });
      if (response.status === 428) {
        setPhase({ kind: "reauthRequired" });
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setPhase({ kind: "error", message: body.error || t("accountDataExport.requestFailed") });
        return;
      }
      const ticket = (await response.json()) as Ticket;
      setPhase({ kind: "ready", ticket });
      void loadHistory();
    } catch {
      setPhase({ kind: "error", message: t("accountDataExport.requestFailed") });
    }
  }, [loadHistory, t]);

  // The link is spent by following it, so the page returns to idle rather than
  // leaving a control that looks live and is not.
  const onDownloaded = useCallback(() => {
    window.setTimeout(() => {
      setPhase({ kind: "idle" });
      void loadHistory();
    }, 1_500);
  }, [loadHistory]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <SettingsDetailNav
        section="account-data"
        currentLabel={t("accountDataExport.dataTabTitle")}
        backTestId="account-data-back"
      />

      <header className="mt-6">
        <h1 className="text-xl font-bold">{t("accountDataExport.pageTitle")}</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          {t("accountDataExport.pageDescription")}
        </p>
      </header>

      <section
        className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
        data-testid="account-data-export-panel"
      >
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            {t("accountDataExport.securityNote")}
          </p>
        </div>

        {phase.kind === "reauthRequired" && (
          <p
            className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200"
            data-testid="account-data-export-reauth"
          >
            {t("accountDataExport.reauthRequired")}
          </p>
        )}

        {phase.kind === "error" && (
          <p
            className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200"
            data-testid="account-data-export-error"
          >
            <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
            {phase.message}
          </p>
        )}

        {phase.kind === "ready" && !expired ? (
          <div className="mt-4" data-testid="account-data-export-ready">
            <a
              href={phase.ticket.downloadPath}
              onClick={onDownloaded}
              download
              data-testid="account-data-export-download"
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-600 px-3 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 dark:border-blue-900/60"
            >
              <Download className="h-4 w-4" />
              {t("accountDataExport.downloadNow")}
            </a>
            <p
              className="mt-2 text-center text-xs text-zinc-500"
              data-testid="account-data-export-countdown"
            >
              {formatCopy("accountDataExport.linkExpiresIn", {
                remaining: formatRemaining(remaining),
              })}
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={requestDownload}
            disabled={phase.kind === "requesting"}
            data-testid="account-data-export-request"
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {phase.kind === "requesting" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {expired
              ? t("accountDataExport.requestAgain")
              : t("accountDataExport.prepareDownload")}
          </button>
        )}

        {expired && (
          <p className="mt-2 text-center text-xs text-zinc-500" data-testid="account-data-export-expired">
            {t("accountDataExport.linkExpired")}
          </p>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-bold">{t("accountDataExport.historyTitle")}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">
          {t("accountDataExport.historyDescription")}
        </p>

        {history === null ? (
          <p className="mt-3 text-sm text-zinc-500">{t("accountDataExport.historyLoading")}</p>
        ) : history.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500" data-testid="account-data-export-history-empty">
            {t("accountDataExport.historyEmpty")}
          </p>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="account-data-export-history">
            {history.map((entry) => {
              const size = formatBytes(entry.byteLength);
              return (
                <li
                  key={entry.id}
                  className="flex items-start gap-3 rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                >
                  {entry.status === "downloaded" ? (
                    <Check className="mt-1 h-4 w-4 shrink-0 text-status-success-600" />
                  ) : entry.status === "refused" ? (
                    <X className="mt-1 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                  ) : (
                    <Download className="mt-1 h-4 w-4 shrink-0 text-zinc-400" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {t(`accountDataExport.status.${entry.status}`)}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {new Date(entry.createdAt).toLocaleString()}
                      {size ? ` · ${size}` : ""}
                    </p>
                    {/* A refusal is the row worth reading twice: it means a
                        link for this account was presented and turned away. */}
                    {entry.status === "refused" && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                        {t("accountDataExport.refusedNote")}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
