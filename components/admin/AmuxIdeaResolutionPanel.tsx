"use client";

import { useState } from "react";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { AmuxVisibleAnalysisUnit } from "@/lib/amux/ideaAnalysisResultReadCore";

const ref = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().nonnegative().refine(Number.isSafeInteger);
const catalogSchema = z.object({
  nodes: z.array(z.object({ ref, level: z.enum(["initiative", "epic", "feature"]),
    parentRef: ref.nullable(), revision, contentDigest: digest,
    state: z.enum(["active", "archived"]) }).strict()).max(1_000),
  cards: z.array(z.object({ ref, sourceSystem: z.literal("admin-idea-v4"),
    cardType: z.enum(["story", "task"]), storyKind: z.enum(["general", "bug"]).nullable(),
    featureRef: ref, revision, contentDigest: digest,
    status: z.enum(["backlog", "todo", "doing", "review", "done", "blocked", "cancelled"]) })
    .strict()).max(1_000),
  legacyCards: z.array(z.object({ ref, title: z.string().min(1).max(200) })
    .strict()).max(1_000),
}).strict();
type Catalog = z.infer<typeof catalogSchema>;

/** A08 owner decision workspace. It records no approval: the server must
 * re-read the analysis and target rows again at the later A09 write boundary. */
export function AmuxIdeaResolutionPanel({ ideaId, chunkIndex, units }: {
  ideaId: string; chunkIndex: number; units: AmuxVisibleAnalysisUnit[];
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [actions, setActions] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [related, setRelated] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valid, setValid] = useState(false);
  const [reauth, setReauth] = useState(false);
  const proposals = units.filter((unit) => unit.decisionState === "proposed" &&
    (unit.proposal?.kind === "node" || unit.proposal?.kind === "card"));
  const bodyExpired = units.some((unit) => unit.proposal === null);

  const load = async () => {
    if (busy) return;
    setBusy(true); setError(null); setValid(false); setReauth(false);
    try {
      const response = await adminFetch(`/api/admin/amux/ideas/resolution-preview?${
        new URLSearchParams({ ideaId })}`, { cache: "no-store" });
      if (response.status === 428) { setCatalog(null); setReauth(true); return; }
      const parsed = catalogSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) { setCatalog(null); setError(m.resolutionUnavailable); }
      else setCatalog(parsed.data);
    } catch { setCatalog(null); setError(m.resolutionUnavailable); }
    finally { setBusy(false); }
  };

  const preview = async () => {
    if (busy || !catalog) return;
    setBusy(true); setError(null); setValid(false); setReauth(false);
    const nodeChoices = proposals.filter((unit) => unit.proposal?.kind === "node")
      .filter((unit) => actions[unit.id])
      .map((unit) => {
        const target = catalog.nodes.find((entry) => entry.ref === targets[unit.id]);
        return { proposalLocalId: unit.localRef,
          action: actions[unit.id],
          targetRef: actions[unit.id] === "select_existing" ? target?.ref ?? null : null,
          targetRevision: actions[unit.id] === "select_existing" ? target?.revision ?? null : null,
          targetDigest: actions[unit.id] === "select_existing" ? target?.contentDigest ?? null : null,
          reason: actions[unit.id] === "reject" ? reasons[unit.id]?.trim() || null : null };
      });
    const cardChoices = proposals.filter((unit) => unit.proposal?.kind === "card")
      .filter((unit) => actions[unit.id])
      .map((unit) => {
        const target = catalog.cards.find((entry) => entry.ref === targets[unit.id]);
        const link = actions[unit.id] === "link_existing";
        return { proposalLocalId: unit.localRef, action: actions[unit.id],
          targetRef: link ? target?.ref ?? null : null,
          targetRevision: link ? target?.revision ?? null : null,
          targetDigest: link ? target?.contentDigest ?? null : null,
          relatedLocalRefs: ["split", "merge"].includes(actions[unit.id])
            ? (related[unit.id] ?? "").split(",").map((value) => value.trim()).filter(Boolean)
            : [], reason: reasons[unit.id]?.trim() || null };
      });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/resolution-preview", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId, chunkIndex, nodeChoices, cardChoices }),
      });
      if (response.status === 428) { setReauth(true); return; }
      const result: unknown = await response.json();
      if (response.ok && result !== null && typeof result === "object" &&
          "ok" in result && result.ok === true) setValid(true);
      else {
        const code = result !== null && typeof result === "object" &&
          "code" in result && typeof result.code === "string" ? result.code :
          result !== null && typeof result === "object" && "error" in result &&
          typeof result.error === "string" ? result.error : "unavailable";
        setError(m.resolutionInvalid(code));
      }
    } catch { setError(m.resolutionUnavailable); }
    finally { setBusy(false); }
  };

  if (proposals.length === 0) return null;
  return <section className="space-y-3 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700"
    aria-labelledby="amux-v4-resolution-heading">
    <h4 id="amux-v4-resolution-heading" className="font-semibold">{m.resolutionTitle}</h4>
    <p>{m.resolutionHint}</p>
    <button type="button" onClick={() => void load()} disabled={busy}
      className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
      {busy && !catalog ? m.resolutionLoading : m.resolutionLoad}
    </button>
    {bodyExpired ? <p role="alert">{m.analysisResultBodyExpired}</p> : null}
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}</a> : null}
    {catalog ? <div className="space-y-3">
      {catalog.nodes.length + catalog.cards.length === 0 ?
        <p>{m.resolutionNoTargets}</p> : null}
      {proposals.map((unit) => {
        const proposal = unit.proposal;
        if (!proposal || proposal.kind === "evidence") return null;
        const isNode = proposal.kind === "node";
        const action = actions[unit.id] ?? "";
        const sameTitleRefs = !isNode ? proposals.filter((candidate) =>
          candidate.id !== unit.id && candidate.proposal?.kind === "card" &&
          candidate.proposal.cardType === proposal.cardType &&
          candidate.proposal.storyKind === proposal.storyKind &&
          candidate.proposal.featureRef === proposal.featureRef &&
          candidate.proposal.title.normalize("NFC").toLowerCase() ===
            proposal.title.normalize("NFC").toLowerCase())
          .map((candidate) => candidate.localRef) : [];
        const legacyMatches = catalog.legacyCards.filter((entry) =>
          entry.title.normalize("NFC").toLowerCase() ===
            proposal.title.normalize("NFC").toLowerCase());
        const options = isNode ? catalog.nodes.filter((entry) =>
          entry.level === proposal.level && entry.state === "active") :
          catalog.cards.filter((entry) => entry.cardType === proposal.cardType &&
            entry.storyKind === proposal.storyKind && entry.status !== "cancelled");
        return <div key={unit.id} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="font-medium">{proposal.title} · {unit.localRef}</p>
          {!isNode && (sameTitleRefs.length > 0 || proposal.duplicateCandidateRefs.length > 0) ?
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {m.resolutionPotentialOverlap}: {Array.from(new Set([
                ...sameTitleRefs, ...proposal.duplicateCandidateRefs,
              ])).join(", ")}
            </p> : null}
          {legacyMatches.length > 0 ? <p className="text-xs text-amber-700 dark:text-amber-300">
            {m.resolutionLegacyOverlap}: {legacyMatches.map((entry) => entry.ref).join(", ")}
          </p> : null}
          <label className="block">{isNode ? m.resolutionNodeAction : m.resolutionCardAction}
            <select value={action} onChange={(event) => {
              setActions((current) => ({ ...current, [unit.id]: event.target.value }));
              setValid(false);
            }} className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2">
              <option value="">{m.resolutionChoose}</option>
              {isNode ? <><option value="create">{m.resolutionCreate}</option>
                <option value="select_existing">{m.resolutionLink}</option>
                <option value="reject">{m.resolutionReject}</option></> :
                <><option value="register">{m.resolutionRegister}</option>
                  <option value="link_existing">{m.resolutionLink}</option>
                  <option value="split">{m.resolutionSplit}</option>
                  <option value="merge">{m.resolutionMerge}</option>
                  <option value="reject">{m.resolutionReject}</option></>}
            </select>
          </label>
          {(action === "select_existing" || action === "link_existing") ?
            <label className="block">{m.resolutionLink}
              <select value={targets[unit.id] ?? ""} onChange={(event) => {
                setTargets((current) => ({ ...current, [unit.id]: event.target.value }));
                setValid(false);
              }} className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2">
                <option value="">{m.resolutionChoose}</option>
                {options.map((entry) => <option key={entry.ref} value={entry.ref}>
                  {entry.ref} · {"level" in entry ? entry.level : entry.cardType} · r{entry.revision}
                </option>)}
              </select>
            </label> : null}
          {action && action !== "register" && (!isNode || action === "reject") ?
            <label className="block">{m.resolutionReason}
              <textarea value={reasons[unit.id] ?? ""} maxLength={500}
                onChange={(event) => { setReasons((current) => ({ ...current,
                  [unit.id]: event.target.value })); setValid(false); }}
                className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2" />
            </label> : null}
          {!isNode && action === "register" &&
            (proposal.duplicateCandidateRefs.length > 0 || sameTitleRefs.length > 0) ?
            <label className="block">{m.resolutionReason}
              <textarea value={reasons[unit.id] ?? ""} maxLength={500}
                onChange={(event) => { setReasons((current) => ({ ...current,
                  [unit.id]: event.target.value })); setValid(false); }}
                className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2" />
            </label> : null}
          {!isNode && (action === "split" || action === "merge") ?
            <label className="block">{m.resolutionRelated}
              <input value={related[unit.id] ?? ""} onChange={(event) => {
                setRelated((current) => ({ ...current, [unit.id]: event.target.value }));
                setValid(false);
              }} className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2" />
            </label> : null}
        </div>;
      })}
      <button type="button" onClick={() => void preview()} disabled={busy}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
        {busy ? m.resolutionChecking : m.resolutionPreview}
      </button>
    </div> : null}
    {valid ? <p role="status">{m.resolutionValid}</p> : null}
    {valid && Object.values(actions).some((action) => action === "split" ||
      action === "merge") ? <p role="status">{m.resolutionDerivationRequired}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
