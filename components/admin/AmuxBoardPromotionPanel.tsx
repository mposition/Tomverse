"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxBoardPromotionMessages } from "@/lib/adminMessages/amuxBoardPromotion";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-board-promotion");

type PromotionBody = {
  approvalId?: string;
  status?: string;
  refusal?: string | null;
  applyPermitted?: boolean;
  cardCount?: number;
  error?: string;
  code?: string;
};

export function AmuxBoardPromotionPanel() {
  const messages = useAdminMessages(adminAmuxBoardPromotionMessages);
  const [requestText, setRequestText] = useState("");
  const [approvalId, setApprovalId] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PromotionBody | null>(null);

  const send = async (action: string, body: string) => {
    setPending(true);
    try {
      const response = await adminFetch(`/api/admin/amux/board-promotion?action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const payload = (await response.json()) as PromotionBody;
      setResult(payload);
      if (payload.approvalId) setApprovalId(payload.approvalId);
    } catch {
      setResult({ error: "board_promotion_failed" });
    } finally {
      setPending(false);
    }
  };

  const refusedForStepUp =
    result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
  const applyReady = result?.applyPermitted === true && approvalId.trim().length > 0;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-board-promotion-panel">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h1>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-board-promotion-request">
        {messages.requestLabel}
        <textarea
          id="amux-board-promotion-request"
          className="min-h-40 w-full rounded-md border border-zinc-300 bg-white p-3 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={requestText}
          onChange={(event) => setRequestText(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-board-promotion-approval">
        {messages.approvalLabel}
        <input
          id="amux-board-promotion-approval"
          className="min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={approvalId}
          onChange={(event) => setApprovalId(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          disabled={pending || requestText.trim().length === 0}
          onClick={() => send("preview", requestText)}
        >
          {messages.preview}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || requestText.trim().length === 0}
          onClick={() => send("prepare", requestText)}
        >
          {messages.prepare}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || approvalId.trim().length === 0}
          onClick={() => send("approve", JSON.stringify({ approvalId }))}
        >
          {messages.approve}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || approvalId.trim().length === 0}
          onClick={() => send("reject", JSON.stringify({ approvalId }))}
        >
          {messages.reject}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || approvalId.trim().length === 0}
          onClick={() => send("expire", JSON.stringify({ approvalId }))}
        >
          {messages.expire}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending}
          onClick={() => send("expire-due", "{}")}
        >
          {messages.expireDue}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || !applyReady}
          aria-describedby="amux-board-promotion-apply-reason"
          onClick={() => send("apply", JSON.stringify({ approvalId }))}
        >
          {messages.apply}
        </button>
      </div>
      <p id="amux-board-promotion-apply-reason" className="text-sm text-zinc-700 dark:text-zinc-300">
        {applyReady ? messages.applyPermitted("true") : messages.applyDisabled}
      </p>
      {refusedForStepUp ? (
        <a className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100" href={STEP_UP_HREF}>
          {messages.renewSignIn}
        </a>
      ) : null}
      {result ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100" role="status">
          {result.error ? <p>{messages.error(result.error)}</p> : null}
          {result.status ? <p>{messages.status(result.status)}</p> : null}
          {result.refusal ? <p>{messages.refusal(result.refusal)}</p> : null}
          {typeof result.cardCount === "number" ? <p>{messages.cards(result.cardCount)}</p> : null}
          {typeof result.applyPermitted === "boolean" ? (
            <p>{messages.applyPermitted(result.applyPermitted ? "true" : "false")}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
