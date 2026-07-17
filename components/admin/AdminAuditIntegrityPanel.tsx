"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type Integrity = {
  configured: boolean;
  valid: boolean;
  checkedEntries: number;
  firstInvalidId: string | null;
  message: string;
};

export function AdminAuditIntegrityPanel() {
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [loading, setLoading] = useState(false);
  const verify = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/audit-integrity", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { integrity?: Integrity; error?: string } | null;
      if (!response.ok || !data?.integrity) throw new Error(data?.error || "Audit verification failed.");
      setIntegrity(data.integrity);
      dispatchAppToast(data.integrity.message, data.integrity.valid ? "success" : "error");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Audit verification failed.", "error");
    } finally { setLoading(false); }
  };
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-300"><ShieldCheck className="h-5 w-5" /></span>
          <div><h2 className="font-black text-white">Admin audit integrity</h2><p className="mt-1 text-sm text-zinc-400">New audit entries form a serialized HMAC chain. Verify it before exporting or investigating an incident.</p></div>
        </div>
        <button type="button" onClick={() => void verify()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-black text-white hover:bg-blue-500 disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Verify chain</button>
      </div>
      {integrity ? <div className={`mt-4 flex items-start gap-3 rounded-2xl border p-3 ${integrity.valid ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100" : "border-red-500/30 bg-red-500/10 text-red-100"}`}>{integrity.valid ? <CheckCircle2 className="mt-0.5 h-5 w-5" /> : <AlertTriangle className="mt-0.5 h-5 w-5" />}<div><p className="font-black">{integrity.message}</p><p className="mt-1 text-xs opacity-80">Checked {integrity.checkedEntries.toLocaleString()} entries{integrity.firstInvalidId ? ` · first invalid ${integrity.firstInvalidId}` : ""}</p></div></div> : null}
    </section>
  );
}
