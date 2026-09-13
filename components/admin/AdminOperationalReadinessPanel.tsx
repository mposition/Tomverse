"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Save } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminOperationalReadinessMessages } from "@/lib/adminMessages/operationalReadiness";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";

type Checkpoint = {
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

const localDateTime = (value: string | null, fallbackDays = 0) => {
  const date = value ? new Date(value) : new Date(Date.now() + fallbackDays * 86_400_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

function CheckpointCard({ row, onSaved }: { row: Checkpoint; onSaved: (rows: Checkpoint[]) => void }) {
  const m = useAdminMessages(adminOperationalReadinessMessages);
  const [status, setStatus] = useState(row.status === "not_verified" ? "warning" : row.status);
  const [nextDueAt, setNextDueAt] = useState(localDateTime(row.nextDueAt, row.defaultDueDays));
  const [detail, setDetail] = useState(row.detail || "");
  const [evidenceUrl, setEvidenceUrl] = useState(row.evidenceUrl || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/operational-checkpoints", {
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
    <article className={`rounded-2xl border p-4 ${row.overdue || row.status === "failed" ? "border-amber-500/30 bg-amber-500/10" : "border-zinc-800 bg-zinc-900/60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-black text-white">{row.name}</h3>
          <p className="mt-1 text-xs text-zinc-500">{row.observedAt ? m.verifiedAt(new Date(row.observedAt).toLocaleString()) : m.neverVerified}</p>
        </div>
        {row.overdue ? <AlertTriangle className="h-5 w-5 text-amber-300" /> : <CheckCircle2 className="h-5 w-5 text-emerald-300" />}
      </div>
      {/* `[&>*]:min-w-0`: see AdminPrivacyRequestsPanel -- a grid item will not
          shrink below `<input type="datetime-local">`'s intrinsic width. */}
      <div className="mt-3 grid gap-2 [&>*]:min-w-0">
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white">
          <option value="healthy">{m.status.healthy}</option>
          <option value="warning">{m.status.warning}</option>
          <option value="failed">{m.status.failed}</option>
          <option value="not_configured">{m.status.not_configured}</option>
        </select>
        <input type="datetime-local" value={nextDueAt} onChange={(event) => setNextDueAt(event.target.value)} className="h-10 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white" aria-label={m.nextDue(row.name)} />
        <input value={detail} onChange={(event) => setDetail(event.target.value)} placeholder={m.detailPlaceholder} className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white" />
        <input value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} placeholder={m.evidencePlaceholder} className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white" />
        <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {m.verifyCheckpoint}
        </button>
      </div>
    </article>
  );
}

export function AdminOperationalReadinessPanel() {
  const m = useAdminMessages(adminOperationalReadinessMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  const [rows, setRows] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/operational-checkpoints", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { checkpoints?: Checkpoint[]; error?: string } | null;
      if (!response.ok || !data?.checkpoints) throw new Error(data?.error || messagesRef.current.toast.loadFailed);
      setRows(data.checkpoints);
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : messagesRef.current.toast.loadFailed, "error");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">{m.eyebrow}</p>
          <h2 className="mt-2 break-words text-2xl font-black text-white">{m.title}</h2>
          <p className="mt-2 text-sm text-zinc-400">{m.description}</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-700 px-3 text-xs font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {m.refresh}
        </button>
      </div>
      <div className="mt-5 grid gap-3 [&>*]:min-w-0 md:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => <CheckpointCard key={`${row.key}-${row.updatedAt}`} row={row} onSaved={setRows} />)}
      </div>
    </section>
  );
}
