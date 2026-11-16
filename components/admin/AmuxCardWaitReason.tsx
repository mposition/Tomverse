"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import type { AmuxCardWaitDetail } from "@/lib/amux/cardWaitReasonCore";

/** Why a card is not running, as the board and the card detail read it
 * (owner decision 2026-11-15, lib/amux/cardWaitReasonCore.ts). */
export type AmuxCardWaitReasonView = {
  stage: string;
  code: string;
  detail: AmuxCardWaitDetail;
  since: string | null;
  seenAt: string | null;
};

const useWaitMessages = () => useAdminMessages(adminAmuxExecutionMessages).waitReason;
type Messages = ReturnType<typeof useWaitMessages>;

const codeText = (m: Messages, code: string) => m.code[code] ?? m.fallback;
const readinessText = (m: Messages, code: string) => m.readiness[code] ?? m.fallback;
const routeText = (m: Messages, code: string) => m.route[code] ?? m.fallback;

/** The causes in a few words: the readiness refusals, or each distinct route reason. */
function causes(m: Messages, detail: AmuxCardWaitDetail): string[] {
  if (detail.reasons?.length) return detail.reasons.map((reason) => readinessText(m, reason));
  if (detail.routes?.length)
    return [...new Set(detail.routes.map((route) => route.why))]
      .filter((why) => why !== "not_chosen").map((why) => routeText(m, why));
  return [];
}

/** One line under a board card. */
export function AmuxCardWaitReasonLine({ wait }: { wait: AmuxCardWaitReasonView | null | undefined }) {
  const m = useWaitMessages();
  if (!wait) return null;
  const why = causes(m, wait.detail).slice(0, 2);
  return <p className="text-xs text-amber-300" data-testid="amux-card-wait-reason"
    data-wait-code={wait.code}>
    {codeText(m, wait.code)}{why.length ? ` · ${why.join(", ")}` : ""}</p>;
}

/** The whole reason in the card detail: the code, since when, and each route. */
export function AmuxCardWaitReasonPanel({ wait, date }: {
  wait: AmuxCardWaitReasonView | null | undefined; date: (value: string) => string;
}) {
  const m = useWaitMessages();
  if (!wait) return null;
  const reasons = wait.detail.reasons ?? [];
  const routes = wait.detail.routes ?? [];
  return <section className="rounded border border-amber-700 p-2 text-sm"
    data-testid="amux-card-wait-reason-panel" data-wait-code={wait.code}>
    <h4 className="font-semibold">{m.title}</h4>
    <p>{codeText(m, wait.code)}{wait.since ? ` · ${m.since(date(wait.since))}` : ""}</p>
    {wait.detail.holdsAll && <p className="text-xs text-zinc-400">{m.allCards}</p>}
    {wait.detail.attemptsUsed !== undefined && wait.detail.maxAttempts !== undefined &&
      <p className="text-xs">{m.attempts(wait.detail.attemptsUsed, wait.detail.maxAttempts)}</p>}
    {reasons.length > 0 && <ul className="list-disc pl-5 text-xs">
      {reasons.map((reason) => <li key={reason}>{readinessText(m, reason)}</li>)}</ul>}
    {routes.length > 0 && <ul className="text-xs" data-testid="amux-card-wait-routes">
      {routes.map((route) => <li key={`${route.worker}:${route.provider}`}>
        {route.worker} · {routeText(m, route.why)}</li>)}</ul>}
  </section>;
}
