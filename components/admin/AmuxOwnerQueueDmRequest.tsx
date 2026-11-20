"use client";

import { useState } from "react";
import Link from "next/link";
import { Bot, Radio } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxOwnerQueueMessages } from "@/lib/adminMessages/amuxOwnerQueue";
import { formatAestDateTime } from "@/lib/adminUiCore";
import {
  AMUX_DM_RELAY_RUNBOOK_URL, amuxOwnerQueueDmButton,
  type AmuxDmRelayView, type AmuxOwnerQueueDmView,
} from "@/lib/amux/ownerQueueDmRequestCore";

type DmReasonCopy = Readonly<Record<string, string>>;

const at = (value: string) => formatAestDateTime(value, { seconds: false }) ?? value;

/** The strip's relay line: when the host's DM relay last called, and whether it stopped. */
export function AmuxOwnerQueueDmRelayChip({ relay }: { relay: AmuxDmRelayView | null | undefined }) {
  const copy = useAdminMessages(adminAmuxOwnerQueueMessages).dmRequest.relay;
  if (relay === undefined) return null;
  const down = relay === null || relay.state === "stale" || relay.state === "never";
  const seen = relay?.lastSeenAt ? at(relay.lastSeenAt) : null;
  const text = relay === null ? copy.unknown : relay.state === "asking" ? copy.asking
    : seen === null ? copy.never : relay.state === "live" ? copy.live(seen) : copy.stale(seen);
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="amux-owner-queue-dm-relay"
      data-state={relay === null ? "unknown" : relay.state}>
      <Radio className={`h-4 w-4 ${down ? "text-red-400" : "text-emerald-400"}`} aria-hidden />
      <span className="text-zinc-300">{copy.label}</span>
      <span className={down ? "font-bold text-red-300" : "text-zinc-100"}>{text}</span>
      {down ? (
        <a href={AMUX_DM_RELAY_RUNBOOK_URL} target="_blank" rel="noreferrer"
          className="text-xs font-bold text-red-200 underline" data-testid="amux-owner-queue-dm-relay-check">
          {copy.check}
        </a>
      ) : null}
    </div>
  );
}

const reasonText = (reasons: DmReasonCopy, fallback: (code: string) => string, code: string | null) =>
  code === null ? null : Object.hasOwn(reasons, code) ? reasons[code]! : fallback(code);

/**
 * The card's Decision Maker box: which path holds it, how far it got and why
 * it stopped, and the one button the owner may press. While the relay is not
 * calling, the button gives way to the relay check: a card sent now would wait
 * for nothing. Pressing it changes nothing with the DM directly
 * (/api/admin/amux/owner-queue/dm-request); the list is read again after it,
 * whatever came back.
 */
export function AmuxOwnerQueueDmRequestPanel({ taskId, dm, relay, canAsk, onChanged, settlementShown = false }: {
  taskId: string;
  dm: AmuxOwnerQueueDmView | undefined;
  relay: AmuxDmRelayView | null | undefined;
  /** `ops:write`: the button is offered. */
  canAsk: boolean;
  onChanged: () => void;
  /**
   * The card's settlement is already drawn by the panel above it (its proposal,
   * its confirmation, why it was handed off): a settlement view here keeps only
   * the button or the relay check.
   */
  settlementShown?: boolean;
}) {
  const copy = useAdminMessages(adminAmuxOwnerQueueMessages);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"done" | "refused" | "failed" | null>(null);
  if (!dm) return null;
  // Absent (not read) or null (the read failed): the relay is not judged down.
  const button = amuxOwnerQueueDmButton(dm, relay ?? null);
  if (settlementShown && dm.source === "settlement" && dm.state !== "switch_off" && dm.state !== "not_eligible" &&
    button === null) return null;
  const reason = reasonText(copy.dmRequest.reason, copy.dmRequest.reasonFallback, dm.reason);
  const press = async () => {
    if (!dm.action || !dm.sourceId || (dm.source !== "result_review" && dm.source !== "settlement")) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await adminFetch("/api/admin/amux/owner-queue/dm-request", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, source: dm.source, action: dm.action, sourceId: dm.sourceId }),
      });
      setNotice(response.ok ? "done" : response.status === 409 ? "refused" : "failed");
    } catch {
      setNotice("failed");
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4" data-testid="amux-owner-queue-dm-request"
      data-source={dm.source ?? "none"} data-state={dm.state}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-zinc-100">
        <Bot className="h-4 w-4" aria-hidden />
        {copy.dmRequest.title}
        {dm.source ? <span className="text-xs font-normal text-zinc-400">{copy.dmRequest.source[dm.source]}</span> : null}
      </p>
      <p className="mt-1.5 text-sm leading-6 text-zinc-300">{copy.dmRequest.state[dm.state]}</p>
      {reason ? <p className="text-sm leading-6 text-zinc-400" data-testid="amux-owner-queue-dm-request-reason">{reason}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {dm.requestId && (dm.state === "proposed" || dm.state === "dm_closed") ? (
          <Link href={`/admin/amux-execution?tab=review&dmRequest=${encodeURIComponent(dm.requestId)}`}
            className="text-sm font-bold text-blue-300 underline" data-testid="amux-owner-queue-dm-request-open">
            {dm.state === "proposed" ? copy.dmRequest.openProposal : copy.dmRequest.openRequest}
          </Link>
        ) : null}
        {button === "relay_check" ? (
          <span className="text-sm" data-testid="amux-owner-queue-dm-request-relay-needed">
            <span className="font-bold text-red-300">{copy.dmRequest.relay.check}</span>{" "}
            <a href={AMUX_DM_RELAY_RUNBOOK_URL} target="_blank" rel="noreferrer" className="text-red-200 underline">
              {copy.dmRequest.relay.runbook}
            </a>
          </span>
        ) : button !== null && canAsk ? (
          <button type="button" onClick={() => void press()} disabled={busy}
            data-testid="amux-owner-queue-dm-request-button" data-action={button}
            className="inline-flex min-h-9 items-center rounded-xl border border-blue-500/50 bg-blue-500/15 px-3 text-sm font-bold text-blue-100 hover:bg-blue-500/25 disabled:opacity-50">
            {busy ? copy.dmRequest.busy : button === "resend" ? copy.dmRequest.resend : copy.dmRequest.request}
          </button>
        ) : null}
      </div>
      {button === "relay_check" ? <p className="mt-1 text-xs text-zinc-500">{copy.dmRequest.relay.checkHint}</p> : null}
      {notice ? (
        <p className={`mt-2 text-sm ${notice === "done" ? "text-emerald-300" : "text-amber-200"}`}
          role="status" data-testid="amux-owner-queue-dm-request-notice">{copy.dmRequest[notice]}</p>
      ) : null}
      {button === "resend" || button === "request" ? (
        <p className="mt-1 text-xs text-zinc-500">{copy.dmRequest.confirmNote}</p>
      ) : null}
    </div>
  );
}
