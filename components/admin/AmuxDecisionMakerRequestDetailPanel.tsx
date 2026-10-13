"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxDecisionMakerJudgmentPanel } from "@/components/admin/AmuxDecisionMakerJudgmentPanel";
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

/** The Decision Maker tab itself, which the detail returns to. */
export const DM_ADMIN_REQUEST_LIST_HREF = "/admin/amux-settings?tab=decision-maker";

/** The detail of one request, on the same tab (docs/ui-contracts/admin-console-ia.md: a section lives in ?tab=). */
export const dmAdminRequestDetailHref = (requestId: string) =>
  `${DM_ADMIN_REQUEST_LIST_HREF}&request=${encodeURIComponent(requestId)}`;

const termClass = "text-xs font-medium text-zinc-600 dark:text-zinc-400";
const textClass = "whitespace-pre-wrap break-words text-sm text-zinc-900 dark:text-zinc-100";

const field = (label: string, value: ReactNode, testId?: string) => (
  <div className="flex flex-col gap-0.5" data-testid={testId}>
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

/**
 * AMUX › Operations settings › Decision Maker, one request for the person who
 * judges it (docs/policy/amux-decision-maker.md §6, §12 S2), without hooks, so
 * a test can call it and read the tree it returns.
 *
 * An irreversible proposal says so before anything else (§6). The card and the
 * Decision Maker's texts are the worker's and the model's words: shown as
 * plain text, never as markup, and never followed as instructions. An open
 * proposal with its bodies and transmission all there carries the judgment
 * controls (AmuxDecisionMakerJudgmentPanel); nothing else on the panel acts.
 */
export function AmuxDecisionMakerRequestDetailView({
  m,
  list,
  view,
}: {
  m: Messages;
  list: ListMessages;
  view: DmAdminRequestDetailView;
}) {
  const back = (
    <Link href={DM_ADMIN_REQUEST_LIST_HREF} className="text-sm text-blue-700 underline dark:text-blue-300" data-testid="amux-dm-detail-back">
      {m.back}
    </Link>
  );
  if (view.kind !== "detail") {
    const message = view.kind === "not_found" ? m.notFound : view.kind === "restricted" ? m.bodiesRestricted : m.unavailable;
    return (
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4" data-testid="amux-decision-maker-request-detail">
        {back}
        <p
          role={view.kind === "unavailable" ? "alert" : undefined}
          className="text-sm text-zinc-700 dark:text-zinc-300"
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
  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4"
      data-testid="amux-decision-maker-request-detail"
      data-request-id={row.requestId}
    >
      {back}
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title(row.cardId, row.questionRevision)}</h2>
      {row.irreversible === true ? (
        <p
          className="rounded border border-red-300 px-3 py-2 text-sm font-semibold text-red-800 dark:border-red-700 dark:text-red-200"
          data-testid="amux-dm-detail-irreversible"
        >
          {m.irreversible}
        </p>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        {field(m.routing, row.route === "operator" ? list.operator : row.instance)}
        {field(m.asker, `${row.askingWorkerId} (${row.askingProvider})`)}
        {field(m.status, list.statuses[status], "amux-dm-detail-status")}
        {field(m.delivery, list.deliveries[delivery], "amux-dm-detail-delivery")}
      </dl>

      {card === null ? (
        <p className={textClass} data-testid="amux-dm-detail-no-card">
          {m.noCard}
        </p>
      ) : (
        <dl className="flex flex-col gap-3" data-testid="amux-dm-detail-card">
          {field(m.question, card.question, "amux-dm-detail-question")}
          {field(m.askType, card.askType)}
          {card.resolution !== null ? field(m.resolution, card.resolution) : null}
          {field(
            m.options,
            card.options.length === 0 ? (
              m.noOptions
            ) : (
              <ul className="list-disc pl-5">
                {card.options.map((option) => (
                  <li key={option.id}>
                    <span className="font-mono text-xs">{option.id}</span> {option.label}
                  </li>
                ))}
              </ul>
            ),
            "amux-dm-detail-options",
          )}
          {card.unblocks ? field(m.unblocks, card.unblocks) : null}
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
        </dl>
      )}

      <div className="flex flex-col gap-3" data-testid="amux-dm-detail-proposal">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.proposal}</h3>
        <dl className="flex flex-col gap-3">{proposalFields(m, detail)}</dl>
        {detail.operatorAnswer !== null ? (
          <dl>{field(m.operatorAnswer, detail.operatorAnswer, "amux-dm-detail-operator-answer")}</dl>
        ) : null}
        {snapshot !== null ? <dl>{field(m.snapshot, snapshot, "amux-dm-detail-snapshot")}</dl> : null}
      </div>
      <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-dm-detail-judgeable" data-judgeable={detail.shown !== null}>
        {detail.shown !== null ? m.judgeable : m.notJudgeable}
      </p>
      {detail.shown !== null ? (
        <AmuxDecisionMakerJudgmentPanel
          requestId={row.requestId}
          shown={detail.shown}
          reloadHref={dmAdminRequestDetailHref(row.requestId)}
        />
      ) : null}
    </section>
  );
}

export function AmuxDecisionMakerRequestDetailPanel({ view }: { view: DmAdminRequestDetailView }) {
  const m = useAdminMessages(adminAmuxDecisionMakerRequestDetailMessages) as Messages;
  const list = useAdminMessages(adminAmuxDecisionMakerRequestsMessages) as ListMessages;
  return <AmuxDecisionMakerRequestDetailView m={m} list={list} view={view} />;
}
