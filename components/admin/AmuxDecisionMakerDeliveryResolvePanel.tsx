"use client";

import { useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxDecisionMakerAttentionMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import type { DmDeliveryResolveOutcome } from "@/lib/amux/decisionMakerJudgmentCore";

const RESOLVE_PATH = "/api/admin/amux/decision-maker/deliveries/resolve";

type Messages = (typeof adminAmuxDecisionMakerAttentionMessages)["en"];
export type DmDeliveryResolveState =
  | { phase: "idle" }
  | { phase: "sending"; outcome: DmDeliveryResolveOutcome }
  | { phase: "recorded"; outcome: DmDeliveryResolveOutcome }
  | { phase: "refused"; reason: string }
  | { phase: "unknown" };

const buttonClass =
  "inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A confirmed answer whose delivery is unknown (docs/policy/amux-decision-maker.md
 * §9), without hooks: the person checked the worker's session in AMUX and
 * records what they found, once. Nothing here sends anything to a worker.
 */
export function AmuxDecisionMakerDeliveryResolveView({
  d,
  state,
  failure,
  reloadHref,
  onResolve,
}: {
  d: Messages;
  state: DmDeliveryResolveState;
  failure: AdminApiFailure | null;
  reloadHref: string;
  onResolve: (outcome: DmDeliveryResolveOutcome) => void;
}) {
  const locked = state.phase !== "idle";
  const settled =
    state.phase === "recorded" ? d.resolveRecorded[state.outcome]
      : state.phase === "refused" ? d.resolveRefused[state.reason] ?? d.resolveFailed
        : state.phase === "unknown" ? d.resolveUnknown : null;
  return (
    <section className="flex flex-col gap-3" data-testid="amux-dm-delivery-resolve" data-phase={state.phase} aria-label={d.resolveTitle}>
      <p className="text-sm leading-6 text-amber-200">{d.deliveryUnknownNext}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${buttonClass} border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}
          disabled={locked}
          onClick={() => onResolve("delivered")}
          data-testid="amux-dm-delivery-resolve-delivered"
        >
          {d.resolveDelivered}
        </button>
        <button
          type="button"
          className={`${buttonClass} border-amber-800 text-amber-200 hover:bg-amber-950/50`}
          disabled={locked}
          onClick={() => onResolve("not_delivered")}
          data-testid="amux-dm-delivery-resolve-not_delivered"
        >
          {d.resolveNotDelivered}
        </button>
      </div>
      {state.phase === "sending" ? (
        <p role="status" className="text-sm text-zinc-300">
          {d.resolveSending}
        </p>
      ) : null}
      {settled !== null ? (
        <div role="status" className="flex flex-col gap-1 text-sm text-zinc-100" data-testid="amux-dm-delivery-resolve-settled">
          <p>{settled}</p>
          <a href={reloadHref} className="text-blue-300 underline">
            {d.reload}
          </a>
        </div>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} returnTo={reloadHref} /> : null}
    </section>
  );
}

type Io = { post: (body: unknown) => Promise<Response>; failureOf: (response: Response) => Promise<AdminApiFailure> };
type Apply = (changes: { state?: DmDeliveryResolveState; failure?: AdminApiFailure | null }) => void;

/** Sent once; an unknown outcome is said and the person reloads, never a second send. */
export async function runDmDeliveryResolve(requestId: string, outcome: DmDeliveryResolveOutcome, io: Io, apply: Apply) {
  apply({ state: { phase: "sending", outcome }, failure: null });
  let response: Response;
  try {
    response = await io.post({ requestId, outcome });
  } catch {
    apply({ state: { phase: "unknown" } });
    return;
  }
  if (response.ok) {
    apply({ state: { phase: "recorded", outcome } });
    return;
  }
  const body = (await response.clone().json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
  if (response.status === 409 && typeof body?.reason === "string") {
    apply({ state: { phase: "refused", reason: body.reason } });
    return;
  }
  if (response.status === 503 && body?.error === "outcome_unknown") {
    apply({ state: { phase: "unknown" } });
    return;
  }
  // Refused before the transaction, or rolled back: nothing was written.
  apply({ state: { phase: "idle" }, failure: await io.failureOf(response) });
}

export function AmuxDecisionMakerDeliveryResolvePanel({ requestId, reloadHref }: { requestId: string; reloadHref: string }) {
  const d = useAdminMessages(adminAmuxDecisionMakerAttentionMessages) as Messages;
  const { locale } = useAdminLocale();
  const [state, setState] = useState<DmDeliveryResolveState>({ phase: "idle" });
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  return (
    <AmuxDecisionMakerDeliveryResolveView
      d={d}
      state={state}
      failure={failure}
      reloadHref={reloadHref}
      onResolve={(outcome) => {
        if (state.phase !== "idle" || !window.confirm(d.resolveConfirm)) return;
        void runDmDeliveryResolve(
          requestId,
          outcome,
          {
            post: (body) =>
              adminFetch(RESOLVE_PATH, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            failureOf: (response) => readAdminApiFailure(response, { fallback: d.resolveFailed, locale }),
          },
          (changes) => {
            if (changes.state) setState(changes.state);
            if ("failure" in changes) setFailure(changes.failure ?? null);
          },
        );
      }}
    />
  );
}
