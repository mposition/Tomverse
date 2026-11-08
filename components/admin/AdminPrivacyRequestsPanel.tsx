"use client";

import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, Plus, RefreshCw, Save } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminPrivacyRequestsMessages } from "@/lib/adminMessages/privacyRequests";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch } from "@/lib/adminFetch";

type PrivacyRow = {
  id: string; userId: string | null; email: string; requestType: string; status: string;
  dueAt: string; legalHold: boolean; legalHoldReason: string | null; note: string | null;
  completedAt: string | null; handledByEmail: string | null; createdAt: string; updatedAt: string;
};

const localDateTime = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** A request waiting on someone is a warning; one being worked is in progress. */
const STATUS_TONE: Record<string, AdminTone> = {
  open: "warn",
  in_progress: "info",
  completed: "ok",
  rejected: "idle",
};

const FIELD =
  "h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-blue-500";

function PrivacyCard({
  row,
  canWrite,
  onSaved,
}: {
  row: PrivacyRow;
  canWrite: boolean;
  onSaved: (row: PrivacyRow) => void;
}) {
  const m = useAdminMessages(adminPrivacyRequestsMessages);
  const [status, setStatus] = useState(row.status);
  const [dueAt, setDueAt] = useState(localDateTime(row.dueAt));
  const [legalHold, setLegalHold] = useState(row.legalHold);
  const [legalHoldReason, setLegalHoldReason] = useState(row.legalHoldReason || "");
  const [note, setNote] = useState(row.note || "");
  const [saving, setSaving] = useState(false);
  const overdue = new Date(row.dueAt) < new Date() && !["completed", "rejected"].includes(row.status);
  const statusLabel = (m.card.statuses as Record<string, string>)[row.status] ?? row.status;

  const save = async () => {
    setSaving(true);
    try {
      const response = await adminFetch("/api/admin/privacy-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, status, dueAt: new Date(dueAt).toISOString(), legalHold, legalHoldReason: legalHoldReason.trim() || null, note: note.trim() || null }),
      });
      const data = (await response.json().catch(() => null)) as { request?: PrivacyRow; error?: string } | null;
      if (!response.ok || !data?.request) throw new Error(data?.error || m.toast.updateFailed);
      onSaved(data.request);
      dispatchAppToast(m.toast.updated, "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.toast.updateFailed, "error");
    } finally { setSaving(false); }
  };

  return (
    <details className={`border-t border-zinc-800 py-3 first:border-t-0 ${overdue ? "rounded-xl bg-red-500/10 px-3" : ""}`}>
      <summary className="cursor-pointer list-none">
        {/* `flex-wrap` plus `min-w-0` on the identity column: a customer email
            is one unbreakable token, so without both the status chips are
            pushed past a 320px viewport and the page scrolls sideways. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="break-all font-bold text-white">{row.email}</p>
            <p className="mt-1 text-xs text-zinc-500">
              {m.card.due(row.requestType, formatAestDateTime(row.dueAt, { seconds: true }) ?? "-")}
            </p>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <AdminStatusChip tone={STATUS_TONE[row.status] ?? "unknown"}>{statusLabel}</AdminStatusChip>
            {overdue ? <AdminStatusChip tone="bad">{m.card.overdue}</AdminStatusChip> : null}
            {row.legalHold ? <AdminStatusChip tone="warn">{m.card.legalHold}</AdminStatusChip> : null}
            <ChevronRight className="h-4 w-4 text-zinc-500" aria-hidden />
          </div>
        </div>
      </summary>
      {/* `[&>*]:min-w-0` because a grid item's default `min-width: auto` refuses
          to shrink below `<input type="datetime-local">`'s intrinsic width, which
          overflows a 320px viewport. */}
      <div className="mt-4 grid gap-2 border-t border-zinc-800 pt-4 [&>*]:min-w-0 md:grid-cols-2">
        <select value={status} onChange={(event) => setStatus(event.target.value)} className={FIELD}>
          <option value="open">{m.card.statuses.open}</option>
          <option value="in_progress">{m.card.statuses.in_progress}</option>
          <option value="completed">{m.card.statuses.completed}</option>
          <option value="rejected">{m.card.statuses.rejected}</option>
        </select>
        <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} aria-label={m.card.dueDate} className={`${FIELD} w-full min-w-0`} />
        <label className="flex h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-bold text-white">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} className="h-4 w-4 accent-amber-500" /> {m.card.legalException}
        </label>
        <input value={legalHoldReason} onChange={(event) => setLegalHoldReason(event.target.value)} disabled={!legalHold} aria-label={m.card.legalHoldReason} placeholder={m.card.legalHoldReasonPlaceholder} className={`${FIELD} disabled:opacity-40`} />
        <input value={note} onChange={(event) => setNote(event.target.value)} aria-label={m.card.operatorNote} placeholder={m.card.operatorNote} className={`${FIELD} md:col-span-2`} />
        <AdminWriteButton
          writable={canWrite}
          requiredRole="support"
          onClick={() => void save()}
          disabled={saving}
          className="md:col-span-2"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />} {m.card.save}
        </AdminWriteButton>
      </div>
    </details>
  );
}

/**
 * The data-rights request queue. It reads its own rows from the existing
 * route, so a failed read is held here and drawn as an error with a retry --
 * never as "No privacy requests", which would hide a request with a deadline.
 * `canWrite` only draws the write controls locked; the route refuses on its
 * own.
 */
export function AdminPrivacyRequestsPanel({ canWrite = true }: { canWrite?: boolean } = {}) {
  const m = useAdminMessages(adminPrivacyRequestsMessages);
  // Read by `load` without making it a dependency, so switching console
  // language does not refetch the queue and drop the pages already loaded.
  const toastRef = useRef(m.toast);
  useEffect(() => { toastRef.current = m.toast; }, [m.toast]);
  const [rows, setRows] = useState<PrivacyRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [email, setEmail] = useState("");
  const [requestType, setRequestType] = useState("export");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (cursor?: string | null, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ take: "30" });
      if (cursor) params.set("cursor", cursor);
      const response = await adminFetch(`/api/admin/privacy-requests?${params}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { requests?: PrivacyRow[]; nextCursor?: string | null; error?: string } | null;
      if (!response.ok || !data?.requests) throw new Error(data?.error || toastRef.current.loadFailed);
      setRows((current) => append ? [...current, ...data.requests!] : data.requests!);
      setNextCursor(data.nextCursor || null);
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      dispatchAppToast(error instanceof Error ? error.message : toastRef.current.loadFailed, "error");
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const response = await adminFetch("/api/admin/privacy-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, requestType, dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), note: null }) });
      const data = (await response.json().catch(() => null)) as { request?: PrivacyRow; error?: string } | null;
      if (!response.ok || !data?.request) throw new Error(data?.error || m.toast.createFailed);
      setRows((current) => [data.request!, ...current]); setEmail(""); dispatchAppToast(m.toast.added, "success");
    } catch (error) { dispatchAppToast(error instanceof Error ? error.message : m.toast.createFailed, "error"); }
    finally { setCreating(false); }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminTile as="div" title={m.addTitle} description={m.addDescription}>
        <div className="grid gap-2 [&>*]:min-w-0 md:grid-cols-[1fr_12rem_auto]">
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} aria-label={m.customerEmail} placeholder={m.customerEmail} className={FIELD} />
          <select value={requestType} onChange={(event) => setRequestType(event.target.value)} aria-label={m.requestTypeLabel} className={FIELD}>
            <option value="access">{m.requestTypes.access}</option>
            <option value="export">{m.requestTypes.export}</option>
            <option value="deletion">{m.requestTypes.deletion}</option>
            <option value="correction">{m.requestTypes.correction}</option>
          </select>
          <AdminWriteButton writable={canWrite} requiredRole="support" onClick={() => void create()} disabled={creating || !email.includes("@")}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} {m.add}
          </AdminWriteButton>
        </div>
      </AdminTile>
      <AdminTile
        title={m.title}
        description={m.description}
        action={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden /> {m.refresh}
          </button>
        }
      >
        {loadFailed ? (
          <AdminStateBlock kind="error" title={m.readFailedTitle} detail={m.readFailedDetail} onRetry={() => void load()} />
        ) : null}
        <div className="flex min-w-0 flex-col [&>*]:min-w-0">
          {rows.map((row) => (
            <PrivacyCard
              key={`${row.id}-${row.updatedAt}`}
              row={row}
              canWrite={canWrite}
              onSaved={(saved) => setRows((current) => current.map((item) => item.id === saved.id ? saved : item))}
            />
          ))}
        </div>
        {loading && rows.length === 0 && !loadFailed ? <AdminStateBlock kind="loading" /> : null}
        {!loading && !loadFailed && rows.length === 0 ? <AdminStateBlock kind="empty" title={m.empty} /> : null}
        {nextCursor ? (
          <button type="button" onClick={() => void load(nextCursor, true)} disabled={loading} className="w-full rounded-xl border border-zinc-700 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">{m.loadNext}</button>
        ) : null}
      </AdminTile>
    </div>
  );
}
