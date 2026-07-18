"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2, Plus, RefreshCw, Save } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type PrivacyRow = {
  id: string; userId: string | null; email: string; requestType: string; status: string;
  dueAt: string; legalHold: boolean; legalHoldReason: string | null; note: string | null;
  completedAt: string | null; handledByEmail: string | null; createdAt: string; updatedAt: string;
};

const localDateTime = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function PrivacyCard({ row, onSaved }: { row: PrivacyRow; onSaved: (row: PrivacyRow) => void }) {
  const [status, setStatus] = useState(row.status);
  const [dueAt, setDueAt] = useState(localDateTime(row.dueAt));
  const [legalHold, setLegalHold] = useState(row.legalHold);
  const [legalHoldReason, setLegalHoldReason] = useState(row.legalHoldReason || "");
  const [note, setNote] = useState(row.note || "");
  const [saving, setSaving] = useState(false);
  const overdue = new Date(row.dueAt) < new Date() && !["completed", "rejected"].includes(row.status);

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/privacy-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, status, dueAt: new Date(dueAt).toISOString(), legalHold, legalHoldReason: legalHoldReason.trim() || null, note: note.trim() || null }),
      });
      const data = (await response.json().catch(() => null)) as { request?: PrivacyRow; error?: string } | null;
      if (!response.ok || !data?.request) throw new Error(data?.error || "Privacy request update failed.");
      onSaved(data.request);
      dispatchAppToast("Privacy request updated.", "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Privacy request update failed.", "error");
    } finally { setSaving(false); }
  };

  return (
    <details className={`rounded-2xl border p-4 ${overdue ? "border-red-500/30 bg-red-500/10" : "border-zinc-800 bg-zinc-900/60"}`}>
      <summary className="cursor-pointer list-none">
        <div className="flex items-start justify-between gap-3">
          <div><p className="font-black text-white">{row.email}</p><p className="mt-1 text-xs text-zinc-500">{row.requestType} · due {new Date(row.dueAt).toLocaleString()}</p></div>
          <div className="flex items-center gap-2"><span className="rounded-full border border-zinc-700 px-2 py-1 text-xs font-black text-zinc-200">{row.status}</span>{row.legalHold ? <span className="rounded-full border border-amber-500/30 px-2 py-1 text-xs font-black text-amber-200">Legal hold</span> : null}<ChevronRight className="h-4 w-4 text-zinc-500" /></div>
        </div>
      </summary>
      <div className="mt-4 grid gap-2 border-t border-zinc-800 pt-4 md:grid-cols-2">
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white"><option value="open">Open</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="rejected">Rejected</option></select>
        <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white" />
        <label className="flex h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-bold text-white"><input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} className="h-4 w-4 accent-amber-500" /> Legal retention exception</label>
        <input value={legalHoldReason} onChange={(event) => setLegalHoldReason(event.target.value)} disabled={!legalHold} placeholder="Required legal hold reason" className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white disabled:opacity-40" />
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Operator note" className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white md:col-span-2" />
        <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 text-xs font-black text-white hover:bg-blue-500 disabled:opacity-50 md:col-span-2">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save request</button>
      </div>
    </details>
  );
}

export function AdminPrivacyRequestsPanel() {
  const [rows, setRows] = useState<PrivacyRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [requestType, setRequestType] = useState("export");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (cursor?: string | null, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ take: "30" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/admin/privacy-requests?${params}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { requests?: PrivacyRow[]; nextCursor?: string | null; error?: string } | null;
      if (!response.ok || !data?.requests) throw new Error(data?.error || "Privacy queue load failed.");
      setRows((current) => append ? [...current, ...data.requests!] : data.requests!);
      setNextCursor(data.nextCursor || null);
    } catch (error) { dispatchAppToast(error instanceof Error ? error.message : "Privacy queue load failed.", "error"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const response = await fetch("/api/admin/privacy-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, requestType, dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), note: null }) });
      const data = (await response.json().catch(() => null)) as { request?: PrivacyRow; error?: string } | null;
      if (!response.ok || !data?.request) throw new Error(data?.error || "Privacy request creation failed.");
      setRows((current) => [data.request!, ...current]); setEmail(""); dispatchAppToast("Privacy request added.", "success");
    } catch (error) { dispatchAppToast(error instanceof Error ? error.message : "Privacy request creation failed.", "error"); }
    finally { setCreating(false); }
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">Privacy operations</p><h2 className="mt-2 text-2xl font-black text-white">Data rights request queue</h2><p className="mt-2 text-sm text-zinc-400">Track access, export, deletion, correction, deadlines, and documented legal retention exceptions.</p></div><button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-700 px-3 text-xs font-black text-zinc-200"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh</button></div>
      <div className="mt-4 grid gap-2 md:grid-cols-[1fr_12rem_auto]"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Customer email" className="h-11 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white" /><select value={requestType} onChange={(event) => setRequestType(event.target.value)} className="h-11 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white"><option value="access">Access</option><option value="export">Export</option><option value="deletion">Deletion</option><option value="correction">Correction</option></select><button type="button" onClick={() => void create()} disabled={creating || !email.includes("@")} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white disabled:opacity-50">{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add request</button></div>
      <div className="mt-5 grid gap-3">{rows.map((row) => <PrivacyCard key={`${row.id}-${row.updatedAt}`} row={row} onSaved={(saved) => setRows((current) => current.map((item) => item.id === saved.id ? saved : item))} />)}{!loading && rows.length === 0 ? <p className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-500">No privacy requests.</p> : null}</div>
      {nextCursor ? <button type="button" onClick={() => void load(nextCursor, true)} disabled={loading} className="mt-4 w-full rounded-xl border border-zinc-700 py-2 text-sm font-black text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">Load next 30</button> : null}
    </section>
  );
}
