"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Send, X } from "lucide-react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { AdminCopyWorkBriefButton } from "@/components/admin/AdminCopyWorkBriefButton";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { card } from "@/components/admin/qaReleaseTabParts";
import { adminFetch } from "@/lib/adminFetch";
import { describeAdminApiFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";
import { adminProductResearchScoutMessages } from "@/lib/adminMessages/productResearchScout";
import { aestStamp } from "@/lib/agentOffice/time";
import { ciAdviceWorkBrief, type CiAdviceConsole, type CiAdviceItem } from "@/lib/qaReleaseCiAdviceActionsCore";
import type { QaReleaseCiAdviceRecord, QaReleaseCiAdviceSuggestion } from "@/lib/qaReleaseCiAdviceCore";

type Props = { advice: CiAdviceConsole | QaReleaseCiAdviceRecord | null; canWrite?: boolean; canSend?: boolean };

/** Reset local action results only when the server supplies a different snapshot. */
export function QaReleaseCiAdviceSection(props: Props) {
  if (!props.advice || props.advice.answeredAt === null) return null;
  return <CiAdviceItems key={JSON.stringify(props.advice)} {...props} advice={props.advice} />;
}

function CiAdviceItems({ advice, canWrite = false, canSend = false }: Props & { advice: NonNullable<Props["advice"]> }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const actions = useAdminMessages(adminProductResearchScoutMessages);
  const routing = useAdminMessages(adminAutoRouterOptimizerMessages);
  const { locale } = useAdminLocale();
  const router = useRouter();
  const [items, setItems] = useState<Array<QaReleaseCiAdviceSuggestion | CiAdviceItem>>(advice.suggestions);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
  const [failure, setFailure] = useState<{ id: string; detail: AdminApiFailure } | null>(null);
  const act = async (id: string, action: "complete" | "dismiss" | "send") => {
    setBusy({ id, action }); setFailure(null);
    try {
      const response = await adminFetch(`/api/admin/qa-release/ci-advice/${id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        setFailure({ id, detail: await readAdminApiFailure(response, { fallback: actions.failed, locale }) });
        router.refresh();
        return;
      }
      const body = await response.json();
      setItems((before) => before.map((item) => "id" in item && item.id === id ? { ...item, ...body.item } : item));
      router.refresh();
    } catch {
      setFailure({ id, detail: describeAdminApiFailure({ status: 0, fallback: actions.failed, locale }) });
    } finally { setBusy(null); }
  };
  const buttonClass = "inline-flex min-h-11 items-center gap-1 rounded-xl border border-zinc-600 px-3 text-xs font-bold text-zinc-200 disabled:opacity-50";
  const isClosed = (item: QaReleaseCiAdviceSuggestion | CiAdviceItem) => "status" in item && ["completed", "dismissed", "sent"].includes(item.status);
  const closed = items.filter(isClosed);
  const visible = [...items.filter((item) => !isClosed(item)), ...(showClosed ? closed.slice(0, 20) : [])];
  return (
    <section className={`${card} flex min-w-0 flex-col gap-3`} data-testid="qa-release-ci-advice">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-zinc-100">{m.ciAdviceTitle}</h2>
        <span className="text-xs text-zinc-500">{m.ciAdviceAt.replace("{at}", aestStamp(advice.answeredAt ?? advice.askedAt))}</span>
      </div>
      {closed.length > 0 ? <button type="button" className="self-start text-xs text-zinc-400 underline underline-offset-4" aria-expanded={showClosed} onClick={() => setShowClosed((before) => !before)} data-testid="qa-release-ci-advice-history">
        {m.ciAdviceHistory.replace("{shown}", String(Math.min(20, closed.length))).replace("{total}", String(closed.length))}
      </button> : null}
      {items.length === 0 ? (
        <p className="text-sm text-zinc-400">{m.ciAdviceNone}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-zinc-800">
          {visible.map((suggestion, index) => {
            const item = "id" in suggestion ? suggestion as CiAdviceItem : null;
            const status = item?.status === "completed" ? "done" : item?.status === "sent" ? "sent_to_amux" : item?.status;
            return <li key={item?.id ?? index} id={item ? `ci-advice-${item.id}` : undefined} data-testid="qa-release-ci-advice-item" className="flex min-w-0 flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="min-w-0 break-words text-sm font-medium text-zinc-100">{suggestion.title}</span>
                {suggestion.savesMinutes !== null ? (
                  <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                    {m.ciAdviceSaves.replace("{minutes}", String(suggestion.savesMinutes))}
                  </span>
                ) : null}
              </div>
              <p className="break-words text-xs text-zinc-400">{suggestion.why}</p>
              <p className="break-words text-xs text-zinc-300">{suggestion.change}</p>
              {item ? <>
                <p className="text-xs text-zinc-400" data-testid="qa-release-ci-advice-status">
                  {routing.recommendationStatuses[status as keyof typeof routing.recommendationStatuses]}
                  {item.at ? ` · ${aestStamp(item.at)}` : ""}
                  {item.amuxIdeaId ? ` · ${item.amuxIdeaId}` : ""}
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <button type="button" className={buttonClass} disabled={busy !== null || !canWrite || item.status !== "open"} onClick={() => void act(item.id, "complete")} data-testid="qa-release-ci-advice-complete"><Check className="h-3.5 w-3.5" aria-hidden />{actions.complete}</button>
                  <button type="button" className={buttonClass} disabled={busy !== null || !canWrite || item.status !== "open"} onClick={() => void act(item.id, "dismiss")} data-testid="qa-release-ci-advice-dismiss"><X className="h-3.5 w-3.5" aria-hidden />{actions.dismiss}</button>
                  <button type="button" className={buttonClass} disabled={busy !== null || !canSend || !["open", "sending_to_amux"].includes(item.status)} onClick={() => void act(item.id, "send")} data-testid="qa-release-ci-advice-send"><Send className="h-3.5 w-3.5" aria-hidden />{busy?.id === item.id && busy.action === "send" ? actions.sending : actions.send}</button>
                  <AdminCopyWorkBriefButton brief={() => ciAdviceWorkBrief(item)} labels={{ copy: actions.copyBrief, copied: actions.briefCopied, failed: actions.briefCopyFailed }} className={buttonClass} testId="qa-release-ci-advice-copy" icon={<Copy className="h-3.5 w-3.5" aria-hidden />} />
                </div>
                {failure?.id === item.id ? <AdminApiFailureNotice failure={failure.detail} returnTo="/admin/release?tab=qa" testId="qa-release-ci-advice-failure" /> : null}
              </> : null}
            </li>
          })}
        </ol>
      )}
    </section>
  );
}
