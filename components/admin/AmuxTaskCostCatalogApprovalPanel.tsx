"use client";

import { useState } from "react";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const previewSchema = z.object({ catalogVersion: z.string(),
  pricingVersion: z.string(), catalogDigest: digest,
  ruleCount: z.number().int().positive(), routeCount: z.number().int().positive(),
  expectedPreviousVersion: z.number().int().nonnegative(),
  currentStatus: z.enum(["none", "approved", "revoked"]),
  executionAuthorized: z.literal(false) }).strict();
type Preview = z.infer<typeof previewSchema>;

/** Admin-only price approval; the model cannot submit the catalog. A lost
 * response is resolved by exact ID readback and never blindly replayed. */
export function AmuxTaskCostCatalogApprovalPanel({ approvalAvailable }: {
  approvalAvailable: boolean;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [catalogText, setCatalogText] = useState("");
  const [evidenceDigest, setEvidenceDigest] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [approved, setApproved] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readJson = () => {
    if (new TextEncoder().encode(catalogText).length > 262_144) return null;
    try { return JSON.parse(catalogText) as unknown; }
    catch { return null; }
  };
  const showFailure = async (response: Response) => {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === "object" && "error" in value &&
      typeof value.error === "string" ? value.error : "unavailable";
    if (response.status === 428) setReauth(true);
    if (code === "outcome_unknown") setUnknown(true);
    else setError(m.taskCatalogFailed(code));
  };
  const check = async () => {
    const catalog = readJson();
    if (!catalog || busy || unknown) { setError(m.taskCatalogInvalid); return; }
    setBusy(true); setError(null); setPreview(null); setApprovalId(null);
    try {
      const response = await adminFetch("/api/admin/amux/task-cost-catalog", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", catalog }),
      });
      if (!response.ok) { await showFailure(response); return; }
      const parsed = previewSchema.safeParse(await response.json());
      if (!parsed.success) { setError(m.taskCatalogInvalid); return; }
      setPreview(parsed.data);
    } catch { setError(m.taskCatalogInvalid); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    const catalog = readJson();
    if (!approvalAvailable || !preview || !catalog || busy || unknown ||
        approved || !confirmed || !digest.safeParse(evidenceDigest).success) return;
    const id = crypto.randomUUID();
    setApprovalId(id); setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch("/api/admin/amux/task-cost-catalog", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", approvalId: id, catalog,
          catalogDigest: preview.catalogDigest, evidenceDigest,
          expectedPreviousVersion: preview.expectedPreviousVersion,
          ownerConfirmedEvidence: true }),
      });
      if (!response.ok) { await showFailure(response); return; }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("approvalId" in value) ||
          value.approvalId !== id || !("catalogDigest" in value) ||
          value.catalogDigest !== preview.catalogDigest) {
        setUnknown(true); return;
      }
      setApproved(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    if (!approvalId || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(`/api/admin/amux/task-cost-catalog/${approvalId}`,
        { cache: "no-store" });
      if (!response.ok) { await showFailure(response); return; }
      const value: unknown = await response.json();
      if (value && typeof value === "object" && "state" in value &&
          value.state === "approved" && "catalogDigest" in value &&
          value.catalogDigest === preview?.catalogDigest) {
        setApproved(true); setUnknown(false);
      } else setUnknown(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 rounded-xl border border-zinc-300 p-4 text-sm dark:border-zinc-700">
    <h3 className="font-semibold">{m.taskCatalogTitle}</h3>
    <p>{m.taskCatalogHint}</p>
    {!approvalAvailable ? <p role="status">{m.taskCatalogDisabled}</p> : null}
    <label className="block">{m.taskCatalogJson}
      <textarea value={catalogText} disabled={busy || unknown || approved}
        onChange={(event) => { setCatalogText(event.target.value); setPreview(null);
          setConfirmed(false); }} maxLength={262_144}
        className="mt-1 min-h-32 w-full rounded border border-zinc-400 bg-transparent p-2 font-mono text-xs" />
    </label>
    <button type="button" onClick={() => void check()} disabled={busy || unknown || approved}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.taskCatalogPreview}</button>
    {preview ? <div className="space-y-1">
      <p>{preview.catalogVersion} · {preview.pricingVersion} ·
        {preview.ruleCount} / {preview.routeCount}</p>
      <p className="break-all font-mono text-xs">{preview.catalogDigest}</p>
      <p>{m.taskCatalogExpectedVersion}: {preview.expectedPreviousVersion}</p>
      <label className="block">{m.taskCatalogEvidenceDigest}
        <input value={evidenceDigest} disabled={busy || approved}
          onChange={(event) => setEvidenceDigest(event.target.value.trim().toLowerCase())}
          maxLength={64} className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2 font-mono" />
      </label>
      <label className="flex items-center gap-2"><input type="checkbox"
        checked={confirmed} disabled={busy || approved}
        onChange={(event) => setConfirmed(event.target.checked)} />
        {m.taskCatalogConfirm}</label>
      <button type="button" onClick={() => void approve()}
        disabled={!approvalAvailable || busy || unknown || approved || !confirmed ||
          !digest.safeParse(evidenceDigest).success}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.taskCatalogApprove}</button>
    </div> : null}
    {approvalId ? <p className="break-all text-xs">{m.taskCatalogApprovalId}: {approvalId}</p> : null}
    {unknown ? <p role="alert">{m.taskCatalogUnknown}</p> : null}
    {approved ? <p role="status">{m.taskCatalogApproved}</p> : null}
    {approvalId && (unknown || approved) ? <button type="button"
      onClick={() => void readBack()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.taskCatalogReadBack}</button> : null}
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}</a> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
