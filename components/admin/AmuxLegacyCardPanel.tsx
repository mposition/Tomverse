"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useAdminMessages } from "./AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxLegacyCardMessages } from "@/lib/adminMessages/amuxLegacyCard";
import type { AdminMessageShape } from "@/lib/adminLocale";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { amuxIdeaLaneBoardHref } from "@/lib/amux/ideaLaneBoardCore";

/** What the card detail read returns for a legacy card (lib/amux/legacyCardOwnerService.ts). */
export type AmuxLegacyCardView = {
  kind: "workboard" | "pre_v22_task";
  closeRefusal: string | null;
  /** Archived already with an escalation still open: a close only resolves that escalation. */
  alreadyArchived?: boolean;
  idea: { state: "ready"; title: string; text: string; truncated: boolean } |
    { state: "refused"; code: string };
};

const PREWRITE_REFUSALS: ReadonlySet<string> = new Set(["amux_submission_disabled", "submission_disabled",
  "audit_unavailable", "key_store_unavailable"]);

type Messages = AdminMessageShape<(typeof adminAmuxLegacyCardMessages)["en"]>;
type Action = "recreate" | "close";
export type AmuxLegacyCardOutcome =
  | { kind: "recreated"; requestId: string; closed: boolean; reason: string | null }
  | { kind: "closed" }
  | { kind: "refused"; error: string; reason: string | null }
  | { kind: "reauth" }
  | { kind: "unknown" };

/** One POST to the legacy card route, read into what the panel says. Never resent on an unknown outcome. */
export async function requestAmuxLegacyCardAction(input: {
  action: Action; taskId: string; revision: number; fetcher?: typeof adminFetch;
}): Promise<AmuxLegacyCardOutcome> {
  let response: Response;
  try {
    response = await (input.fetcher ?? adminFetch)("/api/admin/amux/legacy-card", {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ action: input.action, taskId: input.taskId, revision: input.revision,
        ownerConfirmed: true }),
    });
  } catch { return { kind: "unknown" }; }
  if (response.status === 428) return { kind: "reauth" };
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { body = {}; }
  const text = (value: unknown) => typeof value === "string" ? value : null;
  if (response.ok && body.status === "recreated" && typeof body.requestId === "string") {
    return { kind: "recreated", requestId: body.requestId, closed: body.closed === true, reason: text(body.reason) };
  }
  if (response.ok && body.status === "closed") return { kind: "closed" };
  const error = text(body.error);
  // A 4xx and the 503s that refuse before any write are known; anything else may have written.
  if (error && error !== "outcome_unknown" && (response.status < 500 || PREWRITE_REFUSALS.has(error))) {
    return { kind: "refused", error, reason: text(body.reason) };
  }
  return { kind: "unknown" };
}

const reasonText = (m: Messages, code: string | null) => code ? m.reason[code] ?? code : null;

const LEGACY_KINDS: ReadonlySet<string> = new Set(["workboard", "pre_v22_task"]);

const isLegacyCardView = (value: unknown): value is AmuxLegacyCardView => {
  if (typeof value !== "object" || value === null) return false;
  const view = value as Record<string, unknown>;
  const idea = view.idea as Record<string, unknown> | null | undefined;
  return typeof view.kind === "string" && LEGACY_KINDS.has(view.kind) &&
    (view.closeRefusal === null || typeof view.closeRefusal === "string") &&
    typeof idea === "object" && idea !== null && (idea.state === "ready" ?
      typeof idea.title === "string" && typeof idea.text === "string" : idea.state === "refused");
};

/** A card's legacy panel and the revision it was read at; `view` is null for any other card. */
export type AmuxLegacyCardRead = { revision: number; view: AmuxLegacyCardView | null };

/**
 * The legacy panel of one card, from the same owner-only card detail read the
 * execution board opens (`/api/admin/amux/execution-view?view=detail`). Null
 * when it could not be read: the caller then shows no panel. Read only.
 */
export async function readAmuxLegacyCardForTask(taskId: string,
  fetcher: typeof adminFetch = adminFetch): Promise<AmuxLegacyCardRead | null> {
  try {
    const response = await fetcher(
      `/api/admin/amux/execution-view?view=detail&taskId=${encodeURIComponent(taskId)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, unknown> | null;
    if (!body || body.id !== taskId || !Number.isSafeInteger(body.revision)) return null;
    return { revision: body.revision as number, view: isLegacyCardView(body.legacyCard) ? body.legacyCard : null };
  } catch { return null; }
}

/**
 * Reads the legacy panel of the card on screen when `enabled` (the owner).
 * A read for an earlier card is dropped: only the answer for `taskId` is kept.
 * `initial` is what is shown before the read lands.
 */
export function useAmuxLegacyCardRead(taskId: string, enabled: boolean,
  initial: AmuxLegacyCardRead | null = null, fetcher?: typeof adminFetch): AmuxLegacyCardRead | null {
  const [read, setRead] = useState<{ taskId: string; read: AmuxLegacyCardRead | null }>({ taskId, read: initial });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void readAmuxLegacyCardForTask(taskId, fetcher).then((result) => {
      if (current) setRead({ taskId, read: result });
    });
    return () => { current = false; };
  }, [taskId, enabled, fetcher]);
  return enabled && read.taskId === taskId ? read.read : null;
}

export function AmuxLegacyCardPanel({ taskId, revision, view, canAct, onChanged, fetcher, reauthReturnPath }: {
  taskId: string; revision: number; view: AmuxLegacyCardView; canAct: boolean;
  /** Reloads the board and the card after a write; `closed` says whether the card left the owner queue. */
  onChanged: (closed: boolean) => void;
  fetcher?: typeof adminFetch;
  /** Where a fresh sign-in returns; the execution board's card by default. */
  reauthReturnPath?: string;
}) {
  const m = useAdminMessages(adminAmuxLegacyCardMessages);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AmuxLegacyCardOutcome | null>(null);
  const ready = view.idea.state === "ready" ? view.idea : null;
  // After a close the shown view is stale: the card is in the archive now.
  const done = outcome?.kind === "closed" || (outcome?.kind === "recreated" && outcome.closed);
  const blocked = view.closeRefusal !== null;
  const archived = view.alreadyArchived === true;

  const run = async (action: Action) => {
    setBusy(true);
    setConfirming(null);
    const result = await requestAmuxLegacyCardAction({ action, taskId, revision, fetcher });
    setOutcome(result);
    setBusy(false);
    if (result.kind === "recreated" || result.kind === "closed")
      onChanged(result.kind === "closed" || result.closed);
  };

  return <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
    data-testid="amux-legacy-card">
    <h4 className="font-semibold">{m.title[view.kind]}</h4>
    <p className="text-sm leading-6">{m.intro[view.kind]} {archived ? m.closeEffectArchived : m.closeEffect}</p>
    {blocked && <p role="status" className="text-sm font-semibold text-amber-200"
      data-testid="amux-legacy-card-not-closable">{m.notClosable} {reasonText(m, view.closeRefusal)}</p>}
    {ready ? <details className="rounded border border-zinc-700 p-2 text-sm">
      <summary className="cursor-pointer font-medium">{m.preview}: {ready.title}</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs"
        data-testid="amux-legacy-card-idea-preview">{ready.text}</pre>
      {ready.truncated && <p className="mt-2 text-xs">{m.truncated}</p>}
    </details> : view.idea.state === "refused" && <p role="status" className="text-sm"
      data-testid="amux-legacy-card-idea-refused">{m.ideaRefused} {reasonText(m, view.idea.code)}</p>}
    {canAct && !blocked && !done && <div className="flex flex-wrap gap-2">
      {confirming === null ? <>
        {ready && <button type="button" className="min-h-11 rounded-lg border border-blue-500/50 px-3 py-2 font-semibold"
          disabled={busy} onClick={() => setConfirming("recreate")}
          data-testid="amux-legacy-card-recreate">{m.recreate}</button>}
        <button type="button" className="min-h-11 rounded-lg border border-zinc-600 px-3 py-2 font-semibold"
          disabled={busy} onClick={() => setConfirming("close")}
          data-testid="amux-legacy-card-close">{m.close}</button>
      </> : <div className="space-y-2" role="group" aria-label={m.title[view.kind]}>
        <p className="text-sm font-semibold">{confirming === "recreate" ? (archived ? m.confirmRecreateArchived : m.confirmRecreate) :
          archived ? m.confirmCloseArchived : m.confirmClose}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="min-h-11 rounded-lg border border-blue-500/50 px-3 py-2 font-semibold"
            disabled={busy} onClick={() => void run(confirming)}
            data-testid="amux-legacy-card-confirm">{m.confirm}</button>
          <button type="button" className="min-h-11 rounded-lg border border-zinc-600 px-3 py-2"
            disabled={busy} onClick={() => setConfirming(null)}>{m.cancel}</button>
        </div>
      </div>}
    </div>}
    {busy && <p role="status" className="text-sm">{m.working}</p>}
    {outcome && <div role="status" className="text-sm" data-testid="amux-legacy-card-outcome">
      {outcome.kind === "recreated" && <p>{m.recreated(outcome.closed)}{!outcome.closed && outcome.reason ?
        ` (${reasonText(m, outcome.reason)})` : ""} <Link className="underline"
        href={amuxIdeaLaneBoardHref(outcome.requestId)}>{m.openIdea}</Link></p>}
      {outcome.kind === "closed" && <p>{archived ? m.closedDoneArchived : m.closedDone}</p>}
      {outcome.kind === "refused" && <p>{outcome.error === "idea_refused" ? m.ideaRefused : m.notClosable}{" "}
        {reasonText(m, outcome.reason ?? outcome.error)}</p>}
      {outcome.kind === "reauth" && <Link className="underline" href={adminRecentAuthenticationHref(reauthReturnPath ??
        "/admin/amux-execution?tab=cards&taskId=" + encodeURIComponent(taskId))}>{m.reauth}</Link>}
      {outcome.kind === "unknown" && <p>{m.failed}</p>}
    </div>}
  </section>;
}
