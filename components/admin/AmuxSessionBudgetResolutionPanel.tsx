"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminCommonMessages } from "@/lib/adminMessages/common";
import { adminAmuxSessionBudgetResolutionMessages } from "@/lib/adminMessages/amuxSessionBudgetResolution";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const endpoint = "/api/admin/amux/ideas/session-budget-resolution";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const MICRO_USD = /^(?:0|[1-9][0-9]{0,18})$/;

export type SessionBudgetUnknownList = {
  rows: Array<{ claimId: string; invocationOrdinal: number; budgetMode: string; createdAt: string }>;
  total: number; limit: number;
};
export type SessionBudgetReadback = {
  claimId: string; status: string; reservedMicroUsd: string; readbackDigest: string;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The owner list reply; anything else is unread, never an empty list. */
export function readSessionBudgetUnknownList(value: unknown): SessionBudgetUnknownList | null {
  const body = record(value);
  if (body?.state !== "unknown_list" || !Array.isArray(body.rows) ||
      !Number.isSafeInteger(body.total) || !Number.isSafeInteger(body.limit) ||
      (body.total as number) < body.rows.length) return null;
  const rows: SessionBudgetUnknownList["rows"] = [];
  for (const item of body.rows) {
    const row = record(item);
    if (!row || typeof row.claimId !== "string" || !UUID.test(row.claimId) ||
        !Number.isSafeInteger(row.invocationOrdinal) || typeof row.budgetMode !== "string" ||
        typeof row.createdAt !== "string") return null;
    rows.push({ claimId: row.claimId, invocationOrdinal: row.invocationOrdinal as number,
      budgetMode: row.budgetMode, createdAt: row.createdAt });
  }
  return { rows, total: body.total as number, limit: body.limit as number };
}

/** One exact claim's read-back; a reply for another claim is unread. */
export function readSessionBudgetReadback(value: unknown, claimId: string): SessionBudgetReadback | null {
  const readback = record(record(value)?.readback);
  if (record(value)?.state !== "readback" || !readback || readback.claimId !== claimId ||
      typeof readback.status !== "string" || typeof readback.reservedMicroUsd !== "string" ||
      !MICRO_USD.test(readback.reservedMicroUsd) || typeof readback.readbackDigest !== "string" ||
      !DIGEST.test(readback.readbackDigest)) return null;
  return { claimId, status: readback.status, reservedMicroUsd: readback.reservedMicroUsd,
    readbackDigest: readback.readbackDigest };
}

/** What the owner confirms, fixed text with the claim and the moment of
 * confirmation. Only its sha256 is sent; the audit entry keeps that digest. */
export function sessionBudgetEvidenceText(claimId: string, confirmedAt: string): string {
  return ["amux-v19-session-budget-evidence-v1", `claimId=${claimId}`,
    "operator confirmed outcome unknown on runner", `confirmedAt=${confirmedAt}`].join("\n");
}

export async function sessionBudgetEvidenceDigest(text: string): Promise<string | null> {
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

const usd = (micro: string) => (Number(micro) / 1_000_000).toFixed(2);

/** amux-intake v19 item 6: the owner resolves a session claim the runner held
 * as outcome unknown. Only "may have run" is offered: it records the full
 * reserved amount as used. A lost answer is only read back, never resent. */
export function AmuxSessionBudgetResolutionPanel() {
  const m = useAdminMessages(adminAmuxSessionBudgetResolutionMessages);
  const common = useAdminMessages(adminCommonMessages).apiFailure;
  const [list, setList] = useState<SessionBudgetUnknownList | null>(null);
  const [failure, setFailure] = useState<"unavailable" | "readDisabled" | null>(null);
  const [requiresReauthentication, setRequiresReauthentication] = useState(false);
  const onStatus = useCallback((status: number) => {
    if (status === 428) setRequiresReauthentication(true);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await adminFetch(`${endpoint}?list=outcome_unknown`, { cache: "no-store" });
      onStatus(response.status);
      const body: unknown = await response.json().catch(() => null);
      const parsed = response.ok ? readSessionBudgetUnknownList(body) : null;
      // A failed refresh keeps the rows on screen: a row whose resolution
      // outcome is unknown must keep its read-back-only state, never remount.
      if (parsed) setList(parsed);
      setFailure(parsed ? null : response.status === 409 &&
        record(body)?.error === "session_budget_resolution_read_disabled" ? "readDisabled" : "unavailable");
    } catch { setFailure("unavailable"); }
  }, [onStatus]);

  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load]);

  return <section aria-labelledby="amux-session-budget-resolution-title"
    className="space-y-3 rounded-lg border border-zinc-700 p-4 text-sm"
    data-testid="amux-session-budget-resolution">
    <h4 id="amux-session-budget-resolution-title" className="font-semibold">{m.title}</h4>
    <p>{m.hint}</p>
    <p className="text-amber-200">{m.haltHint}</p>
    <p className="text-zinc-400">{m.inFlightHint}</p>
    <p role={failure ? "alert" : "status"} data-testid="amux-session-budget-resolution-state">
      {failure ? m[failure] : !list ? m.loading : list.rows.length === 0 ? m.empty
        : m.shown(list.rows.length, list.total, list.limit)}</p>
    {list && list.rows.length > 0 ? <ul className="space-y-3">{list.rows.map((row) =>
      <UnknownClaimRow key={row.claimId} row={row} onStatus={onStatus} />)}</ul> : null}
    <button type="button" onClick={() => void load()}
      className="min-h-11 rounded-lg border border-zinc-500 px-4">{m.refresh}</button>
    {requiresReauthentication ? <p role="alert"><Link
      href={adminRecentAuthenticationHref("/admin/amux-settings?tab=analysis")}
      className="inline-flex min-h-11 items-center rounded-lg border border-amber-500 px-4">
      {common.reauthenticate}</Link></p> : null}
  </section>;
}

export function UnknownClaimRow({ row, onStatus }: {
  row: SessionBudgetUnknownList["rows"][number]; onStatus: (status: number) => void;
}) {
  const m = useAdminMessages(adminAmuxSessionBudgetResolutionMessages);
  const [readback, setReadback] = useState<SessionBudgetReadback | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<"resolved" | "refused" | "digestUnavailable" | null>(null);
  const [evidence, setEvidence] = useState<{ text: string; digest: string } | null>(null);
  const rowId = `amux-session-budget-unknown-${row.claimId}`;

  const read = async (): Promise<SessionBudgetReadback | null> => {
    try {
      const response = await adminFetch(`${endpoint}?${new URLSearchParams({ claimId: row.claimId })}`,
        { cache: "no-store" });
      onStatus(response.status);
      const parsed = response.ok
        ? readSessionBudgetReadback(await response.json().catch(() => null), row.claimId) : null;
      setReadback(parsed ?? readback); setReadFailed(!parsed);
      return parsed;
    } catch { setReadFailed(true); return null; }
  };
  const readBack = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const parsed = await read();
      // Only a claim that is no longer unknown ends an uncertain resolution:
      // a commit may still be in flight while it reads unknown.
      if (pending && parsed && parsed.status !== "outcome_unknown") {
        setPending(false);
        setNotice(parsed.status === "owner_consumed" ? "resolved" : null);
      }
    } finally { setBusy(false); }
  };
  const consume = async () => {
    if (!readback || readback.status !== "outcome_unknown" || !confirmed || busy || pending) return;
    setBusy(true); setNotice(null);
    let outcome: "resolved" | "refused" | "unknown" = "unknown";
    try {
      const text = sessionBudgetEvidenceText(row.claimId, new Date().toISOString());
      const digest = await sessionBudgetEvidenceDigest(text);
      if (!digest) { setNotice("digestUnavailable"); return; }
      setEvidence({ text, digest });
      try {
        const response = await adminFetch(endpoint, { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claimId: row.claimId, verification: "not_proven",
            localEvidenceDigest: digest, readbackDigest: readback.readbackDigest,
            ownerConfirmed: true }) });
        onStatus(response.status);
        const body = record(await response.json().catch(() => null));
        if (response.status === 201 && body?.state === "resolved" && body.claimId === row.claimId &&
            body.status === "owner_consumed") outcome = "resolved";
        // A 4xx answer is decided before or by a rolled-back transaction.
        else if (response.status >= 400 && response.status < 500) outcome = "refused";
      } catch { /* Unknown: read back only. */ }
      setConfirmed(false);
      if (outcome === "unknown") { setPending(true); return; }
      if (outcome === "refused") setEvidence(null);
      setNotice(outcome);
      await read();
    } finally { setBusy(false); }
  };

  const canConsume = readback?.status === "outcome_unknown" && confirmed && !busy && !pending;
  // A subscription claim held headroom, not money: closing it returns that
  // headroom instead of counting it as used (owner decision 2026-10-20).
  const shadow = row.budgetMode === "max_shadow";
  return <li className="space-y-2 rounded-lg border border-zinc-700 p-3"
    data-testid="amux-session-budget-unknown-row" aria-labelledby={`${rowId}-title`}>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt id={`${rowId}-title`}>{m.claim}</dt><dd className="font-mono break-all">{row.claimId}</dd>
      <dt>{m.ordinal}</dt><dd>{row.invocationOrdinal}</dd>
      <dt>{m.mode}</dt><dd className="font-mono">{row.budgetMode}</dd>
      <dt>{m.created}</dt><dd className="font-mono">{row.createdAt}</dd>
      {readback ? <><dt>{m.status}</dt><dd className="font-mono">{readback.status}</dd>
        <dt>{m.reserved}</dt><dd className="font-mono">{usd(readback.reservedMicroUsd)}</dd></> : null}
    </dl>
    {readFailed ? <p role="alert">{m.readBackUnavailable}</p> : null}
    {readback && readback.status !== "outcome_unknown" && notice !== "resolved"
      ? <p role="status">{m.alreadyResolved(readback.status)}</p> : null}
    {readback?.status === "outcome_unknown" && !pending ? <>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={confirmed} disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)} className="size-5" />{m.confirm}</label>
      <p className="text-zinc-400">{shadow ? m.consumeHintShadow : m.consumeHint}</p>
    </> : null}
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => void readBack()}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.readBack}</button>
      {readback?.status === "outcome_unknown" && !pending ? <button type="button"
        disabled={!canConsume} onClick={() => void consume()}
        className="min-h-11 rounded-lg border border-red-500 px-4 text-red-300 disabled:opacity-50">
        {shadow ? m.consumeShadow : m.consume}</button> : null}
    </div>
    {pending ? <p role="alert">{m.unknown}</p> : null}
    {notice ? <p role={notice === "resolved" ? "status" : "alert"}>
      {notice === "resolved" && shadow ? m.resolvedShadow : m[notice]}</p> : null}
    {evidence && (pending || notice === "resolved") ? <div className="space-y-1">
      <p>{m.evidence} <span className="font-mono break-all">{evidence.digest}</span></p>
      <pre className="whitespace-pre-wrap break-all font-mono text-xs text-zinc-400">{evidence.text}</pre>
    </div> : null}
  </li>;
}
