"use client";

import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminOperationalReadinessMessages } from "@/lib/adminMessages/operationalReadiness";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch } from "@/lib/adminFetch";

export type Checkpoint = {
  key: string;
  name: string;
  status: string;
  observedAt: string | null;
  nextDueAt: string | null;
  detail: string | null;
  evidenceUrl: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
  overdue: boolean;
  defaultDueDays: number;
};

type CheckpointState = "ready" | "overdue" | "failed" | "warning" | "notConfigured" | "notVerified";

/**
 * Where a checkpoint stands. Only a checkpoint that was verified, reads healthy
 * and is not past its due date counts as ready; anything else is named, so a
 * failed or never-verified one cannot pass as done.
 */
export function checkpointState(row: Pick<Checkpoint, "status" | "overdue" | "observedAt">): CheckpointState {
  if (row.status === "failed") return "failed";
  if (row.status === "not_configured") return "notConfigured";
  if (row.status === "not_verified" || !row.observedAt) return "notVerified";
  if (row.overdue) return "overdue";
  if (row.status === "warning") return "warning";
  return "ready";
}

const STATE_TONE: Record<CheckpointState, AdminTone> = {
  ready: "ok",
  overdue: "warn",
  failed: "bad",
  warning: "warn",
  notConfigured: "unknown",
  notVerified: "unknown",
};

const localDateTime = (value: string | null, fallbackDays = 0) => {
  const date = value ? new Date(value) : new Date(Date.now() + fallbackDays * 86_400_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

const FIELD_CLASS =
  "h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500";

function CheckpointRow({ row, onSaved }: { row: Checkpoint; onSaved: (rows: Checkpoint[]) => void }) {
  const m = useAdminMessages(adminOperationalReadinessMessages);
  const [status, setStatus] = useState(row.status === "not_verified" ? "warning" : row.status);
  const [nextDueAt, setNextDueAt] = useState(localDateTime(row.nextDueAt, row.defaultDueDays));
  const [detail, setDetail] = useState(row.detail || "");
  const [evidenceUrl, setEvidenceUrl] = useState(row.evidenceUrl || "");
  const [saving, setSaving] = useState(false);
  const state = checkpointState(row);

  const save = async () => {
    setSaving(true);
    try {
      const response = await adminFetch("/api/admin/operational-checkpoints", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: row.key,
          status,
          observedAt: new Date().toISOString(),
          nextDueAt: new Date(nextDueAt).toISOString(),
          detail: detail.trim() || null,
          evidenceUrl: evidenceUrl.trim() || null,
        }),
      });
      const data = (await response.json().catch(() => null)) as { checkpoints?: Checkpoint[]; error?: string } | null;
      if (!response.ok || !data?.checkpoints) throw new Error(data?.error || m.toast.updateFailed);
      onSaved(data.checkpoints);
      dispatchAppToast(m.toast.updated(row.name), "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.toast.updateFailed, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="min-w-0 border-t border-zinc-800 first:border-t-0">
      {/* A checkpoint that is not ready opens with its form showing: it is the
          one that needs a recorded check. Ready ones stay folded. */}
      <details className="group" data-state={state} open={state !== "ready"}>
        <summary className="flex cursor-pointer list-none items-center gap-3 py-3 [&::-webkit-details-marker]:hidden">
          {state === "ready" ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
          ) : (
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-300" aria-hidden />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-zinc-100">{row.name}</span>
            <span className="block text-xs text-zinc-500">
              {row.observedAt ? m.verifiedAt(formatAestDateTime(row.observedAt, { seconds: true }) ?? "-") : m.neverVerified}
              {row.nextDueAt ? ` · ${m.nextDueAt(formatAestDateTime(row.nextDueAt) ?? "-")}` : ""}
            </span>
          </span>
          <AdminStatusChip tone={STATE_TONE[state]}>{m.state[state]}</AdminStatusChip>
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-90" aria-hidden />
        </summary>
        {/* `[&>*]:min-w-0`: see AdminPrivacyRequestsPanel -- a grid item will not
            shrink below `<input type="datetime-local">`'s intrinsic width. */}
        <div className="grid gap-2 pb-4 pl-8 [&>*]:min-w-0">
          <p className="text-xs font-bold text-zinc-400">{m.editHint}</p>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className={FIELD_CLASS}
            aria-label={row.name}
          >
            <option value="healthy">{m.status.healthy}</option>
            <option value="warning">{m.status.warning}</option>
            <option value="failed">{m.status.failed}</option>
            <option value="not_configured">{m.status.not_configured}</option>
          </select>
          <input
            type="datetime-local"
            value={nextDueAt}
            onChange={(event) => setNextDueAt(event.target.value)}
            className={`${FIELD_CLASS} w-full min-w-0`}
            aria-label={m.nextDue(row.name)}
          />
          <input
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
            placeholder={m.detailPlaceholder}
            className={FIELD_CLASS}
          />
          <input
            value={evidenceUrl}
            onChange={(event) => setEvidenceUrl(event.target.value)}
            placeholder={m.evidencePlaceholder}
            className={FIELD_CLASS}
          />
          <div>
            <AdminWriteButton onClick={() => void save()} disabled={saving} size="sm">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {m.verifyCheckpoint}
            </AdminWriteButton>
          </div>
        </div>
      </details>
    </li>
  );
}

/**
 * The checklist: one row per checkpoint, closed until opened, with the count
 * of those that are ready. Pure over `rows`, so it renders without a request.
 */
export function AdminReadinessChecklist({
  rows,
  onSaved = () => undefined,
}: {
  rows: readonly Checkpoint[];
  onSaved?: (rows: Checkpoint[]) => void;
}) {
  const m = useAdminMessages(adminOperationalReadinessMessages);
  const ready = rows.filter((row) => checkpointState(row) === "ready").length;
  return (
    <AdminTile
      title={m.title}
      description={m.description}
      action={
        <AdminStatusChip tone={ready === rows.length ? "ok" : "warn"} className="whitespace-nowrap">
          {m.readyCount(ready, rows.length)}
        </AdminStatusChip>
      }
    >
      <ul className="grid gap-x-8 [&>*]:min-w-0 lg:grid-cols-2" data-testid="admin-readiness-checklist">
        {rows.map((row) => (
          <CheckpointRow key={`${row.key}-${row.updatedAt}`} row={row} onSaved={onSaved} />
        ))}
      </ul>
    </AdminTile>
  );
}

export function AdminOperationalReadinessPanel() {
  const m = useAdminMessages(adminOperationalReadinessMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  const [rows, setRows] = useState<Checkpoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/admin/operational-checkpoints", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { checkpoints?: Checkpoint[]; error?: string } | null;
      if (!response.ok || !data?.checkpoints) throw new Error(data?.error || messagesRef.current.toast.loadFailed);
      setRows(data.checkpoints);
      setFailed(false);
    } catch (error) {
      setFailed(true);
      dispatchAppToast(error instanceof Error ? error.message : messagesRef.current.toast.loadFailed, "error");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {rows ? (
        <AdminReadinessChecklist rows={rows} onSaved={setRows} />
      ) : failed ? (
        <AdminTile title={m.title} description={m.description}>
          <AdminStateBlock kind="error" title={m.loadFailedTitle} detail={m.loadFailedDetail} onRetry={() => void load()} />
        </AdminTile>
      ) : (
        <AdminTile title={m.title} description={m.description}>
          <AdminStateBlock kind="loading" />
        </AdminTile>
      )}
      <div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}{" "}
          {m.refresh}
        </button>
      </div>
    </div>
  );
}
