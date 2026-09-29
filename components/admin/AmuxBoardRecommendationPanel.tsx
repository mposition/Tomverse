"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxBoardRecommendationMessages } from "@/lib/adminMessages/amuxBoardRecommendation";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-promotion?tab=recommendation");

type RecommendationBody = {
  snapshotId?: string;
  decisionId?: string;
  status?: string;
  refusal?: string | null;
  applyPermitted?: boolean;
  includedCount?: number;
  included?: Array<{ cardId: string; scoreTotal: number; expectedRevision: number; sourceDigest: string | null }>;
  excluded?: Array<{ cardId: string; scoreTotal: number; exclusionCode: string | null }>;
  error?: string;
  code?: string;
};

const cellClass = "border-b border-zinc-200 px-2 py-1 align-top dark:border-zinc-700";

export function AmuxBoardRecommendationPanel() {
  const messages = useAdminMessages(adminAmuxBoardRecommendationMessages);
  const [requestText, setRequestText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RecommendationBody | null>(null);

  const send = async (action: string) => {
    setPending(true);
    try {
      const response = await adminFetch(`/api/admin/amux/board-recommendation?action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestText,
      });
      setResult((await response.json()) as RecommendationBody);
    } catch {
      setResult({ error: "board_recommendation_failed" });
    } finally {
      setPending(false);
    }
  };

  const refusedForStepUp =
    result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-board-recommendation-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-board-recommendation-request">
        {messages.requestLabel}
        <textarea
          id="amux-board-recommendation-request"
          className="min-h-40 w-full rounded-md border border-zinc-300 bg-white p-3 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={requestText}
          onChange={(event) => setRequestText(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          disabled={pending || requestText.trim().length === 0}
          onClick={() => send("preview")}
        >
          {messages.preview}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || requestText.trim().length === 0}
          onClick={() => send("prepare")}
        >
          {messages.prepare}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || requestText.trim().length === 0}
          onClick={() => send("decide")}
        >
          {messages.decide}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || requestText.trim().length === 0}
          onClick={() => send("capacity")}
        >
          {messages.capacity}
        </button>
      </div>
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
          {typeof result.includedCount === "number" ? <p>{messages.included(result.includedCount)}</p> : null}
          {typeof result.applyPermitted === "boolean" ? (
            <p>{messages.applyPermitted(result.applyPermitted ? "true" : "false")}</p>
          ) : null}
          {result.snapshotId ? <p className="font-mono text-xs">{messages.snapshot(result.snapshotId)}</p> : null}
        </div>
      ) : null}
      {result?.included && result.included.length > 0 ? (
        <div className="overflow-x-auto" data-testid="amux-recommendation-included">
          <table className="w-full text-left text-sm text-zinc-800 dark:text-zinc-100">
            <caption className="py-1 text-left font-medium">{messages.includedHeading}</caption>
            <thead>
              <tr>
                <th scope="col" className={cellClass}>{messages.columnCard}</th>
                <th scope="col" className={cellClass}>{messages.columnScore}</th>
                <th scope="col" className={cellClass}>{messages.columnRevision}</th>
                <th scope="col" className={cellClass}>{messages.columnSourceDigest}</th>
              </tr>
            </thead>
            <tbody>
              {result.included.map((row) => (
                <tr key={row.cardId}>
                  <td className={`${cellClass} font-mono text-xs`}>{row.cardId}</td>
                  <td className={cellClass}>{row.scoreTotal}</td>
                  <td className={cellClass}>{row.expectedRevision}</td>
                  <td className={`${cellClass} break-all font-mono text-xs`}>{row.sourceDigest ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {result?.excluded && result.excluded.length > 0 ? (
        <div className="overflow-x-auto" data-testid="amux-recommendation-excluded">
          <table className="w-full text-left text-sm text-zinc-800 dark:text-zinc-100">
            <caption className="py-1 text-left font-medium">{messages.excludedHeading}</caption>
            <thead>
              <tr>
                <th scope="col" className={cellClass}>{messages.columnCard}</th>
                <th scope="col" className={cellClass}>{messages.columnScore}</th>
                <th scope="col" className={cellClass}>{messages.columnExclusion}</th>
              </tr>
            </thead>
            <tbody>
              {result.excluded.map((row) => (
                <tr key={row.cardId}>
                  <td className={`${cellClass} font-mono text-xs`}>{row.cardId}</td>
                  <td className={cellClass}>{row.scoreTotal}</td>
                  <td className={cellClass}>{row.exclusionCode ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
