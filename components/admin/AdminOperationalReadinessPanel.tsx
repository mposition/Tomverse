"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Save } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

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
      if (!response.ok || !data?.checkpoints) throw new Error(data?.error || "Checkpoint update failed.");
      onSaved(data.checkpoints);
      dispatchAppToast(`${row.name} checkpoint updated.`, "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Checkpoint update failed.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className={`rounded-2xl border p-4 ${row.overdue || row.status === "failed" ? "border-amber-500/30 bg-amber-500/10" : "border-zinc-800 bg-zinc-900/60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-black text-white">{row.name}</h3>
          <p className="mt-1 text-xs text-zinc-500">{row.observedAt ? `Verified ${new Date(row.observedAt).toLocaleString()}` : "Never verified"}</p>
        </div>
        {row.overdue ? <AlertTriangle className="h-5 w-5 text-amber-300" /> : <CheckCircle2 className="h-5 w-5 text-emerald-300" />}
      </div>
      <div className="mt-3 grid gap-2">
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white">
          <option value="healthy">Healthy</option>
          <option value="warning">Warning</option>
          <option value="failed">Failed</option>
          <option value="not_configured">Not configured</option>
        </select>
        <input type="datetime-local" value={nextDueAt} onChange={(event) => setNextDueAt(event.target.value)} className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white" aria-label={`${row.name} next due`} />
        <input value={detail} onChange={(event) => setDetail(event.target.value)} placeholder="Verification result or operator note" className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white" />
        <input value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} placeholder="Optional evidence URL" className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white" />
        <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 text-xs font-black text-white hover:bg-blue-500 disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Verify checkpoint
        </button>
      </div>
    </article>
  );
}

export function AdminOperationalReadinessPanel() {
  const [rows, setRows] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/operational-checkpoints", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { checkpoints?: Checkpoint[]; error?: string } | null;
      if (!response.ok || !data?.checkpoints) throw new Error(data?.error || "Could not load operational checkpoints.");
      setRows(data.checkpoints);
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Could not load operational checkpoints.", "error");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">Operational assurance</p>
          <h2 className="mt-2 text-2xl font-black text-white">Recovery and access checkpoints</h2>
          <p className="mt-2 text-sm text-zinc-400">Record provider-confirmed backup evidence, restore drills, access reviews, and external audit archives without claiming automated verification.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-700 px-3 text-xs font-black text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </button>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => <CheckpointCard key={`${row.key}-${row.updatedAt}`} row={row} onSaved={setRows} />)}
      </div>
    </section>
  );
}
