"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import {
  describeAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { soleApproverUnavailableSentence } from "@/lib/adminSoleApproverCore";
import { dispatchAppToast } from "@/lib/appToast";
import { adminRetentionMessages } from "@/lib/adminMessages/retention";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch } from "@/lib/adminFetch";

export type RetentionItem = {
  key: string;
  label: string;
  policy: string;
  /**
   * What the sweep does with these rows. Optional because a client must not
   * blank the panel against a server that has not deployed it yet.
   */
  action?: "delete" | "clear" | "refund" | "keep";
  staleCount: number;
  oldestAt: string | null;
};

type RetentionResponse = {
  generatedAt: string;
  items: RetentionItem[];
};

/**
 * The dry run the operator is looking at.
 *
 * Kept because the execution is bound to it: a single-administrator
 * organisation cannot satisfy the two-person rule, so the preview's digest is
 * what stands in for the second reviewer (lib/adminSoleApproverCore.ts). With
 * two administrators configured the server ignores these and asks for the
 * usual approval, so the panel sends them either way rather than trying to
 * work out which path applies.
 */
type DryRunPreview = {
  id: string;
  digest: string;
  ranAt: string;
  result: unknown;
};

const dateLabel = (value: string | null) => formatAestDateTime(value) ?? "-";

/**
 * The retention table, and above it the red notice when records are already
 * past their window. Pure: it draws what the retention read returned and
 * nothing else, so the notice only appears when the data says rows are waiting.
 */
export function AdminRetentionOverview({
  items,
  loading = false,
  failed = false,
  onRetry,
  onRefresh,
}: {
  items: readonly RetentionItem[] | null;
  loading?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  onRefresh?: () => void;
}) {
  const m = useAdminMessages(adminRetentionMessages);
  // Rows a cleanup will remove or empty. `keep` rows are history and `refund`
  // rows are settled elsewhere, so neither is a pending deletion.
  const doomed = (items ?? []).filter(
    (item) => (item.action === "delete" || item.action === "clear") && item.staleCount > 0
  );
  const doomedRecords = doomed.reduce((sum, item) => sum + item.staleCount, 0);

  const columns: AdminDataColumn<RetentionItem>[] = [
    {
      key: "data",
      header: m.columns.data,
      render: (item) => <span className="font-bold text-zinc-100">{item.label}</span>,
    },
    {
      key: "rule",
      header: m.columns.rule,
      render: (item) => (
        <div className="flex min-w-0 flex-col items-start gap-1">
          {item.action ? (
            <AdminStatusChip tone={item.action === "keep" ? "ok" : "idle"}>{m.action[item.action]}</AdminStatusChip>
          ) : null}
          <span className="text-xs leading-5 text-zinc-400">{item.policy}</span>
        </div>
      ),
    },
    {
      key: "waiting",
      header: m.columns.waiting,
      render: (item) => (
        <div className="flex flex-col items-start gap-1">
          {/* A `keep` policy's number is history, not a queue. Calling it a
              cleanup count told an operator that running the cleanup would
              move it, and for the audit log nothing ever will. */}
          <span className="text-xs text-zinc-500">
            {item.action === "keep" ? m.beyondFloor : m.cleanupCount}
          </span>
          <span className="text-lg font-bold tabular-nums text-zinc-100">{item.staleCount}</span>
        </div>
      ),
    },
    {
      key: "oldest",
      header: m.columns.oldest,
      render: (item) => <span className="whitespace-nowrap text-xs text-zinc-300">{dateLabel(item.oldestAt)}</span>,
    },
  ];

  return (
    <>
      {doomed.length > 0 ? (
        <section
          data-testid="admin-retention-pending-deletion"
          className="flex items-start gap-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-5"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-zinc-900">
            <Trash2 className="h-5 w-5 text-red-300" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-red-100">
              {m.pending.title(doomedRecords.toLocaleString("en-US"), doomed.length)}
            </h2>
            <p className="mt-1 text-sm text-red-200/80">{m.pending.detail}</p>
            <p className="mt-2 text-xs text-red-200/70">{doomed.map((item) => item.label).join(" · ")}</p>
          </div>
        </section>
      ) : null}

      <AdminTile
        title={m.title}
        description={m.description}
        action={
          onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              {m.refresh}
            </button>
          ) : null
        }
      >
        {items ? (
          <AdminDataTable
            caption={m.table}
            columns={columns}
            rows={items}
            rowKey={(item) => item.key}
            cardTitle={(item) => item.label}
            cardMeta={(item) => (
              <span className="flex flex-col items-start gap-1 whitespace-normal">
                {item.action ? (
                  <AdminStatusChip tone={item.action === "keep" ? "ok" : "idle"}>
                    {m.action[item.action]}
                  </AdminStatusChip>
                ) : null}
                <span>{item.policy}</span>
                <span>
                  {m.oldestRecord}: {dateLabel(item.oldestAt)}
                </span>
              </span>
            )}
            cardAside={(item) => (
              <span className="flex flex-col items-end">
                <span className="text-lg font-bold tabular-nums text-zinc-100">{item.staleCount}</span>
                <span className="text-[11px] text-zinc-500">
                  {item.action === "keep" ? m.beyondFloor : m.cleanupCount}
                </span>
              </span>
            )}
          />
        ) : failed ? (
          <AdminStateBlock kind="error" title={m.loadFailedTitle} detail={m.loadFailedDetail} onRetry={onRetry} />
        ) : (
          <AdminStateBlock kind="loading" />
        )}
      </AdminTile>
    </>
  );
}

export function AdminRetentionPanel() {
  const m = useAdminMessages(adminRetentionMessages);
  const { locale: apiLocale } = useAdminLocale();
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  const [data, setData] = useState<RetentionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [running, setRunning] = useState<"dry-run" | "execute" | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [preview, setPreview] = useState<DryRunPreview | null>(null);
  /**
   * Why an execution took the two-administrator path.
   *
   * Kept on screen rather than in the toast it arrives with: a toast is gone
   * before the operator can act on it, and this is the sentence that answers
   * the question the refusal raises.
   */
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  /**
   * The last refusal, classified.
   *
   * A 428 says the administrator's own sign-in is too old, and the panel used
   * to relay that as a toast and stop -- correct, and useless, because it named
   * the remedy without offering it and then disappeared. Observed on
   * 2026-08-23. `AdminUserSecurityControls` already had the affordance; this
   * reuses it rather than inventing a second one.
   */
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const pathname = usePathname();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/admin/retention");
      const payload = (await response.json().catch(() => null)) as
        | RetentionResponse
        | { error?: string }
        | null;
      if (!response.ok || !payload || !("items" in payload)) {
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : messagesRef.current.toast.loadFailed
        );
      }
      setData(payload);
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      dispatchAppToast(
        error instanceof Error ? error.message : messagesRef.current.toast.loadFailed,
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const runCleanup = async (mode: "dry-run" | "execute") => {
    if (running) return;
    setRunning(mode);
    try {
      const response = await adminFetch("/api/admin/maintenance/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          confirmText: mode === "execute" ? confirmText : undefined,
          dryRunId: mode === "execute" ? preview?.id : undefined,
          dryRunDigest: mode === "execute" ? preview?.digest : undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            run?: { id?: string; result?: unknown; createdAt?: string };
            resultDigest?: string;
            error?: string;
            code?: string;
            soleApproverUnavailable?: string;
          }
        | null;
      if (!response.ok || !payload?.run) {
        setFallbackNote(
          soleApproverUnavailableSentence(payload?.soleApproverUnavailable)
        );
        const described = describeAdminApiFailure({
          status: response.status,
          error: payload?.error,
          code: payload?.code,
          fallback: m.toast.cleanupFailed,
          locale: apiLocale,
        });
        setFailure(described);
        throw new Error(described.message);
      }
      setFallbackNote(null);
      setFailure(null);
      dispatchAppToast(
        mode === "execute" ? m.toast.executed : m.toast.dryRunCompleted,
        "success"
      );
      setConfirmText("");
      // A dry run replaces the preview; an execution consumes it. Either way
      // the old one is gone, and the server would refuse it as superseded
      // rather than act on numbers nobody is still looking at.
      setPreview(
        mode === "dry-run" && payload.run.id && payload.resultDigest
          ? {
              id: payload.run.id,
              digest: payload.resultDigest,
              ranAt: payload.run.createdAt || new Date().toISOString(),
              result: payload.run.result ?? null,
            }
          : null
      );
      await load();
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.toast.cleanupFailed,
        "error"
      );
    } finally {
      setRunning(null);
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminRetentionOverview
        items={data?.items ?? null}
        loading={loading}
        failed={loadFailed}
        onRetry={() => void load()}
        onRefresh={() => void load()}
      />

      <AdminTile title={m.manualCleanup} description={m.manualCleanupHelp} className="border-amber-500/30">
        {preview ? (
          <AdminTechInfo summary={m.dryRunAt(dateLabel(preview.ranAt))} defaultOpen>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words leading-5 text-zinc-300">
              {JSON.stringify(preview.result, null, 2)}
            </pre>
          </AdminTechInfo>
        ) : null}
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <input
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder="RUN CLEANUP"
            aria-label={m.confirmLabel}
            className="h-10 rounded-xl border border-amber-500/30 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-amber-300"
          />
          <AdminWriteButton
            variant="secondary"
            onClick={() => runCleanup("dry-run")}
            disabled={Boolean(running)}
          >
            {running === "dry-run" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {m.dryRun}
          </AdminWriteButton>
          <AdminWriteButton
            variant="danger"
            stepUp
            onClick={() => runCleanup("execute")}
            disabled={Boolean(running) || confirmText !== "RUN CLEANUP"}
          >
            {running === "execute" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {m.executeCleanup}
          </AdminWriteButton>
        </div>
        {fallbackNote ? (
          <p
            data-testid="sole-approver-unavailable"
            className="text-sm leading-6 text-amber-100/75"
          >
            {fallbackNote}
          </p>
        ) : null}
        {failure?.requiresReauthentication ? (
          <div
            role="alert"
            aria-live="assertive"
            data-testid="admin-retention-reauthentication"
            className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs font-bold text-red-100"
          >
            <p>{failure.message}</p>
            <Link
              // The step-up URL rather than the console-session one: the
              // console session is still valid, and this page redirects
              // straight back here once the sign-in is recent again.
              href={adminRecentAuthenticationHref(pathname)}
              data-testid="admin-retention-reauthenticate-link"
              className="mt-2 inline-flex cursor-pointer items-center rounded-lg border border-red-400/50 px-2.5 py-1.5 font-bold text-red-50 underline-offset-4 transition hover:bg-red-500/20 hover:underline"
            >
              {m.signInAgain}
            </Link>
          </div>
        ) : null}
      </AdminTile>
    </div>
  );
}
