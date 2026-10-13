"use client";

import { useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxDecisionMakerJudgmentMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import {
  DM_DECLARATION_ACCURACIES,
  DM_DECLARATION_ITEMS,
  type DmDeclarationAccuracyValue,
  type DmDeclarationItem,
  type DmShownProposal,
} from "@/lib/amux/decisionMakerJudgmentCore";

const JUDGMENT_PATH = "/api/admin/amux/decision-maker/judgments";
/** §10: a person's edited answer is at most 8 KiB of UTF-8. */
export const DM_OPERATOR_ANSWER_MAX_BYTES = 8 * 1024;

type Messages = (typeof adminAmuxDecisionMakerJudgmentMessages)["en"];

export type DmJudgmentKindChoice = "confirm" | "edit_confirm" | "reject";

export type DmJudgmentDraft = {
  accuracy: DmDeclarationAccuracyValue;
  mismatchedItems: DmDeclarationItem[];
  operatorAnswer: string;
};

/**
 * Where a judgment stands on this page. `sending` and the three settled
 * states lock every control: a recorded judgment closed the request, a
 * refusal means the page no longer shows what the ledger holds, and an
 * unknown outcome must be read again before anything is sent.
 */
export type DmJudgmentState =
  | { phase: "editing" }
  | { phase: "sending"; kind: DmJudgmentKindChoice }
  | { phase: "recorded"; kind: DmJudgmentKindChoice }
  | { phase: "refused"; reason: string; bodyRefusal: string | null }
  | { phase: "unknown" };

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * Whether a send may start: the page is editing, the draft has no problem,
 * and the panel still serves the request it was mounted for. The detail
 * keys the panel by its request, so a different request mounts a new panel;
 * this refuses a send even if that key were ever lost, rather than record one
 * request's judgment under another's id.
 */
export const dmJudgmentSendAllowed = (input: {
  state: DmJudgmentState;
  problem: string | null;
  mountedFor: string;
  requestId: string;
}) => input.state.phase === "editing" && input.problem === null && input.mountedFor === input.requestId;

/** Why a judgment cannot be sent from this draft; null when it can. */
export const dmJudgmentDraftProblem = (
  m: Messages,
  kind: DmJudgmentKindChoice,
  draft: DmJudgmentDraft,
): string | null => {
  if (draft.accuracy === "mismatched" && draft.mismatchedItems.length === 0) return m.itemsRequired;
  if (kind === "edit_confirm") {
    if (draft.operatorAnswer.trim() === "") return m.answerRequired;
    if (utf8Bytes(draft.operatorAnswer) > DM_OPERATOR_ANSWER_MAX_BYTES) return m.answerTooLong;
  }
  return null;
};

/**
 * The body the route receives. A confirmation names the values Admin showed
 * (§6), exactly as they were read; a rejection names none. The mismatched
 * items keep the policy's order.
 */
export const dmJudgmentBody = (
  requestId: string,
  kind: DmJudgmentKindChoice,
  shown: DmShownProposal,
  draft: DmJudgmentDraft,
) => ({
  requestId,
  kind,
  ...(kind === "reject" ? {} : { shown }),
  accuracy:
    draft.accuracy === "mismatched"
      ? { accuracy: "mismatched", mismatchedItems: DM_DECLARATION_ITEMS.filter((item) => draft.mismatchedItems.includes(item)) }
      : { accuracy: draft.accuracy },
  ...(kind === "edit_confirm" ? { operatorAnswer: draft.operatorAnswer } : {}),
});

export type DmJudgmentIo = {
  post: (body: ReturnType<typeof dmJudgmentBody>) => Promise<Response>;
  failureOf: (response: Response) => Promise<AdminApiFailure>;
};

/**
 * Statuses the route answers before its transaction starts (a bad or
 * oversized body, no session or permission, a stale step-up, the rate limit),
 * or that a proxy answers without reaching it. Nothing was written, so the
 * page still shows what the ledger holds and the person may send again.
 */
const DM_JUDGMENT_NO_WRITE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 413, 428, 429]);
/** 503 answers whose body says the transaction did not commit. */
const DM_JUDGMENT_ROLLED_BACK_ERRORS: ReadonlySet<unknown> = new Set(["judgment_failed", "dm_digest_keys_unavailable"]);

const bodyOf = async (response: Response): Promise<Record<string, unknown> | null> => {
  try {
    const body = (await response.clone().json()) as unknown;
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * One judgment, sent once (foundation principle 7). A recorded judgment and
 * the store's refusal settle the page; nothing is released after them. A
 * refusal before the transaction, or a 503 whose body says it rolled back,
 * wrote nothing: the failure is shown and the controls come back. Every other
 * answer -- `outcome_unknown`, a body that could not be read, any other
 * status, no answer at all -- may mean it was recorded, so the page says the
 * outcome is unknown and offers only a reload.
 */
export async function runDmJudgment(
  body: ReturnType<typeof dmJudgmentBody>,
  io: DmJudgmentIo,
  update: (changes: { state?: DmJudgmentState; failure?: AdminApiFailure | null }) => void,
): Promise<void> {
  update({ state: { phase: "sending", kind: body.kind as DmJudgmentKindChoice }, failure: null });
  let response: Response;
  try {
    response = await io.post(body);
  } catch {
    // No answer may still mean it was recorded. The unknown outcome's own words
    // say to read it again; a network notice would say to send it again.
    update({ state: { phase: "unknown" }, failure: null });
    return;
  }
  const answer = await bodyOf(response);
  if (response.ok && answer?.recorded === true) {
    update({ state: { phase: "recorded", kind: body.kind as DmJudgmentKindChoice } });
    return;
  }
  if (response.status === 409 && answer?.error === "judgment_refused" && typeof answer.reason === "string") {
    update({
      state: {
        phase: "refused",
        reason: answer.reason,
        bodyRefusal: typeof answer.bodyRefusal === "string" ? answer.bodyRefusal : null,
      },
    });
    return;
  }
  if (DM_JUDGMENT_NO_WRITE_STATUSES.has(response.status) || (response.status === 503 && DM_JUDGMENT_ROLLED_BACK_ERRORS.has(answer?.error))) {
    update({ state: { phase: "editing" }, failure: await io.failureOf(response) });
    return;
  }
  update({ state: { phase: "unknown" }, failure: null });
}

const buttonClass =
  "min-h-11 rounded border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The judgment controls for one open proposal (docs/policy/amux-decision-maker.md
 * §2-6, §4, §6), without hooks, so a test can call it and read the tree.
 */
export function AmuxDecisionMakerJudgmentView({
  m,
  requestId,
  irreversible,
  draft,
  state,
  failure,
  reloadHref,
  onDraft,
  onSend,
}: {
  m: Messages;
  requestId: string;
  irreversible: boolean;
  draft: DmJudgmentDraft;
  state: DmJudgmentState;
  failure: AdminApiFailure | null;
  reloadHref: string;
  onDraft: (draft: DmJudgmentDraft) => void;
  onSend: (kind: DmJudgmentKindChoice) => void;
}) {
  const locked = state.phase !== "editing";
  const problem = (kind: DmJudgmentKindChoice) => dmJudgmentDraftProblem(m, kind, draft);
  const settled =
    state.phase === "recorded"
      ? m.recorded[state.kind]
      : state.phase === "refused"
        ? `${m.refused[state.reason as keyof Messages["refused"]] ?? m.failed}${
            state.bodyRefusal !== null ? ` ${m.bodyRefusals[state.bodyRefusal as keyof Messages["bodyRefusals"]] ?? ""}` : ""
          }`
        : state.phase === "unknown"
          ? m.unknown
          : null;
  return (
    <section
      className="flex flex-col gap-3 rounded border border-zinc-200 p-3 dark:border-zinc-700"
      data-testid="amux-dm-judgment"
      data-request-id={requestId}
      data-phase={state.phase}
    >
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h3>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-dm-judgment-not-approval">
        {m.notApproval}
      </p>
      {irreversible ? (
        <p className="text-sm font-semibold text-red-800 dark:text-red-200" data-testid="amux-dm-judgment-irreversible">
          {m.irreversible}
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-1" disabled={locked}>
        <legend className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.accuracyLegend}</legend>
        {DM_DECLARATION_ACCURACIES.map((value) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name={`amux-dm-accuracy-${requestId}`}
              value={value}
              checked={draft.accuracy === value}
              onChange={() => onDraft({ ...draft, accuracy: value, mismatchedItems: value === "mismatched" ? draft.mismatchedItems : [] })}
              data-testid={`amux-dm-judgment-accuracy-${value}`}
            />
            {m.accuracies[value]}
          </label>
        ))}
        {draft.accuracy === "mismatched" ? (
          <fieldset className="flex flex-col gap-1 pl-6">
            <legend className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{m.itemsLegend}</legend>
            {DM_DECLARATION_ITEMS.map((item) => (
              <label key={item} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.mismatchedItems.includes(item)}
                  onChange={(event) =>
                    onDraft({
                      ...draft,
                      mismatchedItems: event.target.checked
                        ? [...draft.mismatchedItems, item]
                        : draft.mismatchedItems.filter((entry) => entry !== item),
                    })
                  }
                  data-testid={`amux-dm-judgment-item-${item}`}
                />
                {m.items[item]}
              </label>
            ))}
          </fieldset>
        ) : null}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{m.answerLabel}</span>
        <textarea
          className="min-h-24 rounded border border-zinc-300 p-2 text-base dark:border-zinc-600 dark:bg-zinc-900"
          value={draft.operatorAnswer}
          disabled={locked}
          onChange={(event) => onDraft({ ...draft, operatorAnswer: event.target.value })}
          data-testid="amux-dm-judgment-answer"
        />
        <span className="text-xs text-zinc-600 dark:text-zinc-400">{m.answerBytes(utf8Bytes(draft.operatorAnswer))}</span>
      </label>

      <div className="flex flex-wrap gap-2">
        {(["confirm", "edit_confirm", "reject"] as const).map((kind) => {
          const why = problem(kind);
          const label = kind === "confirm" ? m.confirm : kind === "edit_confirm" ? m.editConfirm : m.reject;
          return (
            <button
              key={kind}
              type="button"
              className={buttonClass}
              disabled={locked || why !== null}
              title={why ?? undefined}
              aria-describedby={why !== null ? `amux-dm-judgment-why-${kind}` : undefined}
              onClick={() => onSend(kind)}
              data-testid={`amux-dm-judgment-${kind}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {(["confirm", "edit_confirm", "reject"] as const).map((kind) => {
        const why = problem(kind);
        return why !== null && !locked ? (
          <p key={kind} id={`amux-dm-judgment-why-${kind}`} className="text-xs text-zinc-600 dark:text-zinc-400">
            {why}
          </p>
        ) : null;
      })}

      {state.phase === "sending" ? (
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-dm-judgment-sending">
          {m.sending}
        </p>
      ) : null}
      {settled !== null ? (
        <div role="status" className="flex flex-col gap-1 text-sm text-zinc-900 dark:text-zinc-100" data-testid="amux-dm-judgment-settled">
          <p>{settled}</p>
          {/* A full reload, so the page reads the ledger again. */}
          <a href={reloadHref} className="text-blue-700 underline dark:text-blue-300" data-testid="amux-dm-judgment-reload">
            {m.reload}
          </a>
        </div>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} returnTo={reloadHref} /> : null}
    </section>
  );
}

/**
 * The judgment for one open proposal. A judgment needs `ops:write` and a
 * recent step-up, both checked by the route; a stale step-up is answered 428
 * and rendered with the way back (AdminApiFailureNotice,
 * docs/ui-contracts/admin-console-ia.md rule 7). The sequencing is
 * runDmJudgment()'s: sent once, and never sent again over an unknown outcome.
 */
export function AmuxDecisionMakerJudgmentPanel({
  requestId,
  shown,
  reloadHref,
}: {
  requestId: string;
  shown: DmShownProposal;
  reloadHref: string;
}) {
  const m = useAdminMessages(adminAmuxDecisionMakerJudgmentMessages) as Messages;
  const { locale } = useAdminLocale();
  const [draft, setDraft] = useState<DmJudgmentDraft>({ accuracy: "not_judged", mismatchedItems: [], operatorAnswer: "" });
  const [state, setState] = useState<DmJudgmentState>({ phase: "editing" });
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [mountedFor] = useState(requestId);
  const io: DmJudgmentIo = {
    post: (body) =>
      adminFetch(JUDGMENT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.failed, locale }),
  };
  const apply = (changes: { state?: DmJudgmentState; failure?: AdminApiFailure | null }) => {
    if (changes.state) setState(changes.state);
    if ("failure" in changes) setFailure(changes.failure ?? null);
  };
  return (
    <AmuxDecisionMakerJudgmentView
      m={m}
      requestId={requestId}
      irreversible={shown.irreversible}
      draft={draft}
      state={state}
      failure={failure}
      reloadHref={reloadHref}
      onDraft={setDraft}
      onSend={(kind) => {
        if (!dmJudgmentSendAllowed({ state, problem: dmJudgmentDraftProblem(m, kind, draft), mountedFor, requestId })) return;
        void runDmJudgment(dmJudgmentBody(requestId, kind, shown, draft), io, apply);
      }}
    />
  );
}
