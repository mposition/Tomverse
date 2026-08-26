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
  /** Entries each available key accounted for, index-aligned with the key list. */
  keyEntryCounts: number[];
  /** Leading entries, oldest first, that no available key opens. */
  unverifiedPrefix: number;
  /** Every entry that did not verify, oldest first, bounded. */
  unverifiedIds: string[];
  /** Failing entries beyond the ones listed. */
  unverifiedIdsTruncated: number;
  message: string;
};

/** What a single-field reconstruction found, or did not. */
type Diagnosis = {
  verifiesAsStored: boolean;
  candidatesTried: number;
  keysTried: number;
  /** Each match names the field that differs; the key is a position, never a value. */
  matches: Array<{ label: string; keyPosition: number }>;
  /** The row names an actor by address but carries no user id. */
  actorIdMissingWithEmail: boolean;
  /** The row verifies when keys are sorted by code point rather than by collation. */
  verifiesUnderCodepointKeyOrder: boolean;
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
 * What a failure means, in the reader's terms.
 *
 * Three attempts, each corrected by a chain the previous one described wrongly.
 *
 * The first branched on "the first failure is the oldest row" and said
 * *nothing has verified under any available key*. Staging then came back 115
 * of 116 verified and the panel announced that nothing had.
 *
 * The second called any oldest-row failure an unlisted earlier *span*. The
 * 2026-08-16 audit recorded 53 entries verifying, so that span holds 53 rows
 * and 52 of them verify -- which a missing key cannot do.
 *
 * The third said "only the chain's first entry does not verify, and every
 * entry after it does" whenever the unverified *prefix* was one. An hour
 * later nine entries were failing, eight of them past the prefix, and that
 * sentence was simply false about the chain in front of it.
 *
 * The lesson each time is the same: a sentence about the whole chain cannot
 * be chosen from one statistic about part of it. So the prefix decides the
 * *shape* of the story and the failure count decides whether that story is
 * the whole of it -- and when it is not, the reading says so and stops,
 * because scattered failures after a verified run are not a key problem and
 * there is nothing honest to add without looking at the rows.
 */
function auditIntegrityReading(integrity: Integrity): string {
  const scattered = integrity.invalidEntries - integrity.unverifiedPrefix;
  if (integrity.verifiedEntries === 0) {
    return "Nothing has verified under any available key. That is what a changed signing key looks like rather than an altered entry: add the previous key to ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS and verify again — see docs/ops/admin-audit-key-epochs.md.";
  }
  if (scattered > 0) {
    // Entries interleaved with verified ones. No key boundary produces that,
    // so naming a key here would send the reader somewhere there is nothing.
    const head =
      integrity.unverifiedPrefix > 0
        ? `The oldest ${integrity.unverifiedPrefix.toLocaleString()} ${integrity.unverifiedPrefix === 1 ? "entry does" : "entries do"} not verify, and ${scattered.toLocaleString()} later ${scattered === 1 ? "entry does" : "entries do"} not either`
        : `${scattered.toLocaleString()} ${scattered === 1 ? "entry does" : "entries do"} not verify, scattered among entries that do`;
    return `${head}. Entries that fail among entries that pass are not a signing-key boundary — a key change invalidates a contiguous run. Something has rewritten these rows since they were signed. Diagnose them below, newest first: a row that verified recently bounds the window it changed in.`;
  }
  if (integrity.unverifiedPrefix === 0) {
    return "Entries at the start of the chain verified, so a changed signing key does not explain this on its own.";
  }
  if (integrity.unverifiedPrefix === 1) {
    return "Only the chain's first entry does not verify, and every entry after it does. A changed signing key invalidates a contiguous span rather than a single row, so this points at that entry's stored content rather than at a missing key — open it and compare it against the change it describes.";
  }
  return `The oldest ${integrity.unverifiedPrefix.toLocaleString()} entries do not verify and everything after them does, so that span was signed with a key that is not listed — one rotation further back than the current keys account for. Add that older key to ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS and verify again — see docs/ops/admin-audit-key-epochs.md.`;
}

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
  const [diagnosis, setDiagnosis] = useState<{ auditId: string; result: Diagnosis } | null>(null);
  const [diagnosing, setDiagnosing] = useState<string | null>(null);

  const verify = async () => {
    setLoading(true);
    // A previous failure's row must not survive into a new verification: it
    // would sit under a fresh verdict describing a different entry.
    setEntry(null);
    setDiagnosis(null);
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

  /**
   * The diagnosis needs the database and the signing keys, so it runs on the
   * server and comes back as field names. Telling an operator to clone the
   * repository and run a script would move the work rather than do it, and put
   * production secrets somewhere new on the way.
   */
  const diagnose = async (auditId: string) => {
    setDiagnosing(auditId);
    try {
      const response = await fetch(
        `/api/admin/audit/${encodeURIComponent(auditId)}/diagnose`,
        { cache: "no-store" }
      );
      const data = (await response.json().catch(() => null)) as
        | { diagnosis?: Diagnosis; error?: string }
        | null;
      if (!response.ok || !data?.diagnosis) {
        throw new Error(data?.error || "Could not diagnose this entry.");
      }
      setDiagnosis({ auditId, result: data.diagnosis });
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not diagnose this entry.",
        "error"
      );
    } finally {
      setDiagnosing(null);
    }
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
                {integrity.keysUsed > 1 ? <> · {integrity.keysUsed} of {integrity.keysAvailable} keys used</> : null}
                {integrity.firstInvalidId ? <> · first unverified <span className="font-mono">{integrity.firstInvalidId}</span></> : null}
              </p>
              {integrity.firstInvalidId ? (
                <p data-testid="admin-audit-integrity-reading" className="mt-2 text-xs opacity-90">
                  {auditIntegrityReading(integrity)}
                </p>
              ) : null}
              {integrity.keysAvailable > 1 ? (
                <p data-testid="admin-audit-integrity-key-counts" className="mt-2 text-xs opacity-90">
                  {/* Positions, never values. Which listed key opened what is
                      the difference between one click and two redeploys, and
                      a key that opened nothing is either the wrong value or
                      one covering a span this chain does not contain — it can
                      still produce entries that verify, so it should be
                      dropped rather than left. Key 1 is the signing key; the
                      rest are ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS in order. */}
                  Entries opened per key:{" "}
                  {integrity.keyEntryCounts
                    .map((count, index) => `key ${index + 1} — ${count.toLocaleString()}`)
                    .join(" · ")}
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
              <button
                type="button"
                data-testid="admin-audit-integrity-diagnose"
                onClick={() => void diagnose(integrity.firstInvalidId as string)}
                disabled={diagnosing !== null}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-red-400/30 px-3 text-xs font-bold text-red-100 hover:bg-red-500/10 disabled:opacity-50"
              >
                {diagnosing === integrity.firstInvalidId ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}{" "}
                What changed?
              </button>
            </div>
          ) : null}

          {/* Every failing entry, not only the first.
              Reporting one was enough while one failed. On 2026-08-26 nine
              did -- eight of them rows that had verified an hour before -- and
              the only one reachable was the oldest, which is the least
              informative of the nine: a row that was fine an hour ago bounds
              the window it changed in, and a row broken since July does not.
              Newest first for the same reason. */}
          {integrity.unverifiedIds.length > 1 ? (
            <div
              data-testid="admin-audit-integrity-unverified-list"
              className="mt-3 rounded-xl border border-red-400/20 bg-black/20 p-3 text-xs"
            >
              <p className="font-black">
                Every unverified entry, newest first
                {integrity.unverifiedIdsTruncated > 0 ? (
                  <> · {integrity.unverifiedIdsTruncated.toLocaleString()} more not listed</>
                ) : null}
              </p>
              <ul className="mt-2 space-y-1">
                {[...integrity.unverifiedIds].reverse().map((auditId) => (
                  <li key={auditId} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono break-all">{auditId}</span>
                    <a
                      href={`/admin/audit?entry=${encodeURIComponent(auditId)}`}
                      className="underline decoration-red-400/50 underline-offset-2 hover:text-white"
                    >
                      open
                    </a>
                    <button
                      type="button"
                      data-testid="admin-audit-integrity-diagnose-one"
                      onClick={() => void diagnose(auditId)}
                      disabled={diagnosing !== null}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-400/30 px-2 py-0.5 font-bold text-red-100 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {diagnosing === auditId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : null}
                      what changed?
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {diagnosis ? (
            <div
              data-testid="admin-audit-integrity-diagnosis"
              className="mt-3 rounded-xl border border-red-400/20 bg-black/20 p-3 text-xs"
            >
              <p className="font-mono opacity-70 break-all">{diagnosis.auditId}</p>
              {/* A match is proof, not a hint: the digest is reproduced
                  exactly, under content differing in one named field. So the
                  wording commits, and no-match commits to the opposite. */}
              {diagnosis.result.matches.length === 0 ? (
                <p className="mt-1">
                  No single-field change reproduces this entry&apos;s hash.{" "}
                  {diagnosis.result.candidatesTried.toLocaleString()} reconstructions were
                  tried against {diagnosis.result.keysTried} key
                  {diagnosis.result.keysTried === 1 ? "" : "s"}. More than one field
                  differs from what was signed, or a field this does not vary
                  does, or it was signed with a key this environment no longer
                  has.
                </p>
              ) : (
                <>
                  <p className="mt-1 font-black">
                    The hash is reproduced by content differing in one field:
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {diagnosis.result.matches.map((match) => (
                      <li key={`${match.label}-${match.keyPosition}`} className="font-mono">
                        {match.label} <span className="opacity-70">(key {match.keyPosition})</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 opacity-90">
                    That is what changed since the entry was signed.
                  </p>
                </>
              )}
              {/* Its own finding, because the remedy is not the one a field
                  mismatch calls for: nothing about the entry is wrong. */}
              {diagnosis.result.verifiesUnderCodepointKeyOrder ? (
                <p data-testid="admin-audit-integrity-collation" className="mt-2 font-black">
                  This entry verifies when object keys are sorted by code point
                  instead of by collation, which is what signing uses. Nothing
                  about the row changed — it was signed by a runtime whose
                  locale data ordered two of its keys the other way. See
                  docs/ops/admin-audit-key-epochs.md.
                </p>
              ) : null}
              {/* Not a match, and said separately because it is not one: a cuid
                  is not a value any candidate set can try, so the id cannot be
                  reconstructed. What can be said is which mechanism fits. */}
              {diagnosis.result.actorIdMissingWithEmail ? (
                <p data-testid="admin-audit-integrity-actor-fingerprint" className="mt-2 opacity-90">
                  This row names an actor by address but carries no user id.
                  That is what deleting a user leaves behind: `actorUserId` is
                  in the hash and also a foreign key set to null on delete, so
                  the database rewrote the row with no application code
                  involved. The id it was signed with cannot be recovered.
                </p>
              ) : null}
              <p className="mt-2 opacity-90">
                Do not re-hash the row: rewriting an audit entry to satisfy its
                own checker ends what the chain proves.
              </p>
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
