"use client";

import Link from "next/link";
import { AlertTriangle, Bot, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxDecisionMakerJudgmentPanel } from "@/components/admin/AmuxDecisionMakerJudgmentPanel";
import { dmReportInstant } from "@/components/admin/AmuxDecisionMakerReportPanel";
import {
  adminAmuxDecisionMakerRequestDetailMessages,
  adminAmuxDecisionMakerRequestsMessages,
} from "@/lib/adminMessages/amuxDecisionMaker";
import { dmAdminDeliveryStatus, dmAdminRequestStatus } from "@/lib/amux/decisionMakerAdminCore";
import type { DmAdminRequestDetail } from "@/lib/amux/decisionMakerAdminRead";

type Messages = (typeof adminAmuxDecisionMakerRequestDetailMessages)["en"];
type ListMessages = (typeof adminAmuxDecisionMakerRequestsMessages)["en"];

/** What the page could show for the request named in its query. */
export type DmAdminRequestDetailView =
  | { kind: "detail"; detail: DmAdminRequestDetail }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "restricted" };

import {
  DM_ADMIN_REQUEST_LIST_HREF,
  dmAdminRequestDetailHref,
} from "@/lib/amux/decisionMakerAdminHrefs";

export { DM_ADMIN_REQUEST_LIST_HREF, dmAdminRequestDetailHref };

const termClass = "text-xs font-medium text-zinc-500";
const textClass = "whitespace-pre-wrap break-words text-sm text-zinc-100";
const calloutClass = "flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm";

const field = (label: string, value: ReactNode, testId?: string) => (
  <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
    <dt className={termClass}>{label}</dt>
    <dd className={textClass}>{value}</dd>
  </div>
);

/** A select's choice, worded as the card worded it; the id alone when the card no longer names it. */
const chosenOption = (m: Messages, detail: DmAdminRequestDetail) => {
  const id = detail.optionId as string;
  const label = detail.card?.options.find((option) => option.id === id)?.label;
  return label === undefined ? m.unknownOption(id) : m.chosenOption(id, label);
};

const proposalFields = (m: Messages, detail: DmAdminRequestDetail) => {
  const { row } = detail;
  if (row.outputKind === "select" && detail.optionId !== null) {
    return (
      <>
        {field(m.answer, chosenOption(m, detail), "amux-dm-detail-answer")}
        {detail.rationale !== null ? field(m.rationale, detail.rationale, "amux-dm-detail-rationale") : null}
      </>
    );
  }
  if (row.outputKind === "free_text" && detail.answer !== null) {
    return (
      <>
        {field(m.answer, detail.answer, "amux-dm-detail-answer")}
        {detail.rationale !== null ? field(m.rationale, detail.rationale, "amux-dm-detail-rationale") : null}
      </>
    );
  }
  if (row.outputKind === "escalate" && detail.escalationReason !== null) {
    return field(m.escalation, detail.escalationReason, "amux-dm-detail-escalation");
  }
  return <p className={textClass}>{m.noProposal}</p>;
};

const snapshotText = (m: Messages, detail: DmAdminRequestDetail) => {
  const state = detail.row.snapshotState;
  if (state === null) return null;
  return state === "none" ? m.cardOnly : m.snapshotAt(state, detail.snapshotTargetSha ?? "");
};

/** Closing the side panel, in place of the link back to the list. */
export type DmAdminRequestClose = { href: string; label: string };

/**
 * One Decision Maker request for the person who judges it
 * (docs/policy/amux-decision-maker.md §6, §12 S2), without hooks, so a test
 * can call it and read the tree it returns.
 *
 * An irreversible proposal says so before anything else (§6). The card and the
 * Decision Maker's texts are the worker's and the model's words: shown as
 * plain text, never as markup, and never followed as instructions. An open
 * proposal with its bodies and transmission all there carries the judgment
 * controls (AmuxDecisionMakerJudgmentPanel) at the foot; nothing else acts.
 *
 * With `close` it is the side panel over AMUX › Execution: a header, a body
 * that scrolls, and the judgment pinned to the foot.
 */
export function AmuxDecisionMakerRequestDetailView({
  m,
  list,
  view,
  close,
}: {
  m: Messages;
  list: ListMessages;
  view: DmAdminRequestDetailView;
  close?: DmAdminRequestClose;
}) {
  const exit = close ? (
    <Link
      href={close.href}
      className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      data-testid="amux-dm-detail-close"
    >
      <X className="h-4 w-4" aria-hidden />
      {close.label}
    </Link>
  ) : (
    <Link href={DM_ADMIN_REQUEST_LIST_HREF} className="text-sm text-blue-300 underline" data-testid="amux-dm-detail-back">
      {m.back}
    </Link>
  );
  const frame = close
    ? "flex h-full min-h-0 flex-col"
    : "mx-auto flex w-full max-w-6xl flex-col rounded-xl border border-zinc-800 bg-zinc-900";
  if (view.kind !== "detail") {
    const message = view.kind === "not_found" ? m.notFound : view.kind === "restricted" ? m.bodiesRestricted : m.unavailable;
    return (
      <section className={`${frame} gap-3 p-5`} data-testid="amux-decision-maker-request-detail">
        <div className="flex justify-end">{exit}</div>
        <p
          role={view.kind === "unavailable" ? "alert" : undefined}
          className="text-sm text-zinc-300"
          data-testid={`amux-dm-detail-${view.kind}`}
        >
          {message}
        </p>
      </section>
    );
  }
  const { detail } = view;
  const { row, card } = detail;
  const status = dmAdminRequestStatus(row, detail.dbNowMs);
  const delivery = dmAdminDeliveryStatus(row);
  const snapshot = snapshotText(m, detail);
  const chosen = row.outputKind === "select" ? detail.optionId : null;
  return (
    <section className={frame} data-testid="amux-decision-maker-request-detail" data-request-id={row.requestId}>
      <header className="flex flex-col gap-3 border-b border-zinc-800 px-6 py-5">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-xl font-bold text-zinc-100" id={`amux-dm-detail-title-${row.requestId}`}>
            {m.title(row.cardId, row.questionRevision)}
          </h2>
          {exit}
        </div>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {field(m.routing, row.route === "operator" ? list.operator : row.instance)}
          {field(m.asker, `${row.askingWorkerId} (${row.askingProvider})`)}
          {field(m.status, list.statuses[status], "amux-dm-detail-status")}
          {field(m.delivery, list.deliveries[delivery], "amux-dm-detail-delivery")}
        </dl>
      </header>

      <div className={`flex flex-col gap-5 px-6 py-5 ${close ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>
        {row.irreversible === true ? (
          <div className={`${calloutClass} flex-row items-start border-red-800 bg-red-950/50 font-medium text-red-200`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p data-testid="amux-dm-detail-irreversible">{m.irreversible}</p>
          </div>
        ) : null}

        {/* §2-7, stage S2-2b4: a decided answer the local AMUX proved it never sent, with why. */}
        {row.deliveryOutcome === "not_sent" && row.deliveryNotSentReason !== null ? (
          <div
            className={`${calloutClass} border-amber-800 bg-amber-950/50 text-amber-200`}
            data-testid="amux-dm-detail-not-sent"
            data-reason={row.deliveryNotSentReason}
          >
            <p className="font-semibold">{m.notSent}</p>
            <p>{m.notSentReasons[row.deliveryNotSentReason]}</p>
            <p>{m.notSentNext[row.deliveryNotSentReason]}</p>
          </div>
        ) : null}

        {/* §5: shown to every administrator who can open the detail; it names no directory or path. */}
        {row.cleanupUnknownAtMs !== null ? (
          <div className={`${calloutClass} border-amber-800 bg-amber-950/50 text-amber-200`} data-testid="amux-dm-detail-cleanup-unknown">
            <p className="font-semibold">{m.cleanupUnknown}</p>
            <p data-testid="amux-dm-detail-cleanup-unknown-at">{m.cleanupUnknownAt(dmReportInstant(row.cleanupUnknownAtMs))}</p>
            <p data-testid="amux-dm-detail-cleanup-unknown-steps">{m.cleanupUnknownSteps}</p>
          </div>
        ) : null}

        {card === null ? (
          <p className={textClass} data-testid="amux-dm-detail-no-card">
            {m.noCard}
          </p>
        ) : (
          <dl className="flex flex-col gap-4" data-testid="amux-dm-detail-card">
            <div className="flex flex-col gap-1.5" data-testid="amux-dm-detail-question">
              <dt className={termClass}>{m.question}</dt>
              <dd className="whitespace-pre-wrap break-words text-base leading-7 text-zinc-100">{card.question}</dd>
            </div>
            <div className="flex flex-col gap-2" data-testid="amux-dm-detail-options">
              <dt className={termClass}>{m.options}</dt>
              <dd>
                {card.options.length === 0 ? (
                  <p className={textClass}>{m.noOptions}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {card.options.map((option) => (
                      <li
                        key={option.id}
                        data-chosen={option.id === chosen || undefined}
                        className={`flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                          option.id === chosen
                            ? "border-sky-800 bg-sky-950/60 font-medium text-zinc-100"
                            : "border-zinc-800 text-zinc-200"
                        }`}
                      >
                        <span className="rounded-md bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-100">{option.id}</span>
                        <span className="min-w-0 flex-1 break-words">{option.label}</span>
                        {option.id === chosen ? <Bot className="h-4 w-4 shrink-0 text-sky-300" aria-label="Decision Maker" /> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            {card.unblocks ? field(m.unblocks, card.unblocks) : null}
            <details className="group rounded-lg border border-zinc-800">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-zinc-200">
                <ChevronRight className="h-4 w-4 text-zinc-500 transition group-open:rotate-90" aria-hidden />
                {m.askType} · {card.askType}
              </summary>
              <div className="flex flex-col gap-3 border-t border-zinc-800 px-3 py-3">
                {card.resolution !== null ? field(m.resolution, card.resolution) : null}
                {card.context ? field(m.context, card.context, "amux-dm-detail-context") : null}
                {card.contextPaths.length > 0
                  ? field(
                      m.contextPaths,
                      <ul className="font-mono text-xs">
                        {card.contextPaths.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>,
                    )
                  : null}
              </div>
            </details>
          </dl>
        )}

        <div className="flex flex-col gap-3 rounded-xl border border-sky-800 bg-zinc-950 p-4" data-testid="amux-dm-detail-proposal">
          <h3 className="flex items-center gap-2 text-sm font-bold text-sky-300">
            <Bot className="h-4 w-4" aria-hidden />
            {m.proposal}
          </h3>
          <dl className="flex flex-col gap-3">{proposalFields(m, detail)}</dl>
          {detail.operatorAnswer !== null ? (
            <dl>{field(m.operatorAnswer, detail.operatorAnswer, "amux-dm-detail-operator-answer")}</dl>
          ) : null}
          {snapshot !== null ? <dl>{field(m.snapshot, snapshot, "amux-dm-detail-snapshot")}</dl> : null}
        </div>
        <p className="text-xs text-zinc-500" data-testid="amux-dm-detail-judgeable" data-judgeable={detail.shown !== null}>
          {detail.shown !== null ? m.judgeable : m.notJudgeable}
        </p>
      </div>

      {/* Keyed by the request: a soft navigation to another request would
          otherwise keep this panel's draft, phase and failure, and send one
          request's judgment with another's id. */}
      {detail.shown !== null ? (
        <footer className="border-t border-zinc-800 bg-zinc-900 px-6 py-4">
          <AmuxDecisionMakerJudgmentPanel
            key={row.requestId}
            requestId={row.requestId}
            shown={detail.shown}
            reloadHref={dmAdminRequestDetailHref(row.requestId)}
          />
        </footer>
      ) : null}
    </section>
  );
}

export function AmuxDecisionMakerRequestDetailPanel({
  view,
  close,
}: {
  view: DmAdminRequestDetailView;
  close?: DmAdminRequestClose;
}) {
  const m = useAdminMessages(adminAmuxDecisionMakerRequestDetailMessages) as Messages;
  const list = useAdminMessages(adminAmuxDecisionMakerRequestsMessages) as ListMessages;
  return <AmuxDecisionMakerRequestDetailView m={m} list={list} view={view} close={close} />;
}
