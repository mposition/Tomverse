"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type Integrity = {
  configured: boolean;
  valid: boolean;
  checkedEntries: number;
  firstInvalidId: string | null;
  /** The oldest hash-chained entry, whatever the verdict. */
  firstCheckedId: string | null;
  /** Whether the first failure is that oldest entry. */
  firstInvalidIsOldest: boolean;
  verifiedEntries: number;
  invalidEntries: number;
  linkageBreaks: number;
  keysAvailable: number;
  /** How many of the available keys accounted for at least one entry. */
  keysUsed: number;
  message: string;
};

/** The identifying half of an audit row. Not its metadata, which can be large. */
type AuditEntry = {
  id: string;
  createdAt: string;
  action: string;
  targetType: string;
  targetId: string | null;
  actorEmail: string | null;
  actorUserId: string | null;
};

/**
 * Verifying the chain, and — when it fails — showing the row it failed on.
 *
 * The 2026-08-21 staging round recorded that this panel named `firstInvalidId`
 * and gave no way to look it up; the 2026-08-25 round found the identical id
 * still there, still unreachable. An id nobody can resolve is not a diagnosis,
 * it is a rock in the operator's shoe: it says something is wrong and refuses
 * to say what.
 *
 * So the failure now carries two things it did not.
 *
 * The row itself, fetched from the endpoint that already existed
 * (`GET /api/admin/audit/{id}`) and had simply never been linked to anything.
 *
 * And whether that row is the *oldest* entry in the chain, which is the bit
 * that separates the two stories a failure can tell: "everything before this
 * verified and this one does not" — tampering — from "nothing has verified at
 * all" — a signing key that changed. `docs/ops/admin-audit-key-epochs.md`
 * records that the second is what happened here, and this is the panel that
 * should have been able to say so.
 *
 * The counts alongside are the other half. The verifier now checks every row
 * rather than stopping at the first failure, so the panel can report how much
 * of the chain verified rather than only where it first did not — and, when a
 * rotation is spanned, that more than one signing key was needed to do it.
 */
export function AdminAuditIntegrityPanel() {
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [loading, setLoading] = useState(false);
  const [entry, setEntry] = useState<AuditEntry | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);

  const verify = async () => {
    setLoading(true);
    // A previous failure's row must not survive into a new verification: it
    // would sit under a fresh verdict describing a different entry.
    setEntry(null);
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

  const loadEntry = async (auditId: string) => {
    setEntryLoading(true);
    try {
      const response = await fetch(`/api/admin/audit/${encodeURIComponent(auditId)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { audit?: AuditEntry; error?: string } | null;
      if (!response.ok || !data?.audit) throw new Error(data?.error || "Audit event not found.");
      setEntry(data.audit);
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Audit event not found.", "error");
    } finally { setEntryLoading(false); }
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-300"><ShieldCheck className="h-5 w-5" /></span>
          <div><h2 className="font-black text-white">Admin audit integrity</h2><p className="mt-1 text-sm text-zinc-400">New audit entries form a serialized HMAC chain. Verify it before exporting or investigating an incident.</p></div>
        </div>
        <button type="button" onClick={() => void verify()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Verify chain</button>
      </div>

      {integrity ? (
        <div
          data-testid="admin-audit-integrity-result"
          className={`mt-4 rounded-2xl border p-3 ${integrity.valid ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100" : "border-red-500/30 bg-red-500/10 text-red-100"}`}
        >
          <div className="flex items-start gap-3">
            {integrity.valid ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />}
            <div className="min-w-0">
              <p className="font-black">{integrity.message}</p>
              <p className="mt-1 text-xs opacity-80">
                {/* The counts sit together on purpose. "Checked 110" beside a
                    green verdict once meant 110 entries were fine; with more
                    than one signing key in play it has to say how many
                    actually verified, or the number flatters the answer. */}
                Verified {integrity.verifiedEntries.toLocaleString()} of{" "}
                {integrity.checkedEntries.toLocaleString()} entries
                {integrity.invalidEntries > 0 ? <> · {integrity.invalidEntries.toLocaleString()} unverified</> : null}
                {integrity.linkageBreaks > 0 ? <> · {integrity.linkageBreaks.toLocaleString()} linkage {integrity.linkageBreaks === 1 ? "break" : "breaks"}</> : null}
                {integrity.keysUsed > 1 ? <> · {integrity.keysUsed} signing keys</> : null}
                {integrity.firstInvalidId ? <> · first unverified <span className="font-mono">{integrity.firstInvalidId}</span></> : null}
              </p>
              {integrity.firstInvalidId ? (
                <p data-testid="admin-audit-integrity-reading" className="mt-2 text-xs opacity-90">
                  {integrity.firstInvalidIsOldest
                    ? "This is the oldest entry in the chain, so nothing has verified under any available key. That is what a changed signing key looks like rather than an altered entry: add the previous key to ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS and verify again — see docs/ops/admin-audit-key-epochs.md."
                    : "Entries before this one verified and this one did not, so a changed signing key does not explain it on its own."}
                </p>
              ) : null}
            </div>
          </div>

          {integrity.firstInvalidId ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!entry ? (
                <button
                  type="button"
                  data-testid="admin-audit-integrity-show-entry"
                  onClick={() => void loadEntry(integrity.firstInvalidId as string)}
                  disabled={entryLoading}
                  className="inline-flex h-9 items-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 text-xs font-bold text-red-100 hover:bg-red-500/20 disabled:opacity-50"
                >
                  {entryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Show this entry
                </button>
              ) : null}
              {/* The same row in the audit workspace, which is where an
                  operator goes next: the surrounding entries, the export, the
                  filters. A link rather than a second copy of that screen. It
                  resolves server-side, so it works for a row far older than the
                  window that workspace lists. */}
              <a
                href={`/admin/audit?entry=${encodeURIComponent(integrity.firstInvalidId)}`}
                data-testid="admin-audit-integrity-open-in-log"
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-red-400/30 px-3 text-xs font-bold text-red-100 hover:bg-red-500/10"
              >
                Open in the audit log
              </a>
            </div>
          ) : null}

          {entry ? (
            <dl data-testid="admin-audit-integrity-entry" className="mt-3 grid gap-x-4 gap-y-1 rounded-xl border border-red-400/20 bg-black/20 p-3 text-xs sm:grid-cols-2">
              {[
                ["Written", new Date(entry.createdAt).toISOString()],
                ["Action", entry.action],
                ["Target", entry.targetId ? `${entry.targetType} ${entry.targetId}` : entry.targetType],
                ["Actor", entry.actorEmail || entry.actorUserId || "Unknown admin"],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="shrink-0 opacity-70">{label}</dt>
                  <dd className="min-w-0 break-words font-mono">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
