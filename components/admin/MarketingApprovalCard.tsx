"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { MarketingPostThumb } from "@/components/admin/MarketingPostThumb";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { adminMarketingAgentMessages } from "@/lib/adminMessages/marketingAgent";
import type { AdminTone } from "@/lib/adminUiCore";

type Row = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** What the panel owns and this card only draws: clocks, channel names and the guard's words. */
export type MarketingCardFormat = {
  /** "3 hours ago", measured from the server's read, or null. */
  relative: (iso: unknown) => string | null;
  /** "2026-11-07 13:42 AEST", or null. */
  stamp: (iso: unknown) => string | null;
  channelName: (channel: unknown) => string;
  guardWord: (decision: unknown) => string;
  guardTone: (decision: unknown) => "success" | "warning" | "danger" | "neutral";
};

const TONE: Record<"success" | "warning" | "danger" | "neutral", AdminTone> = {
  success: "ok",
  warning: "warn",
  danger: "bad",
  neutral: "idle",
};

/**
 * One post waiting for a person.
 *
 * `full` is the approval tab's big card: the picture, the words exactly as
 * they will go out, the checks the Guard and the store already made, and the
 * row's own controls (`rail`, the same rail every Marketing row uses, so the
 * compare-and-set values, the confirmation and the step-up path are the ones
 * the routes expect). `compact` is the Overview's: the picture, two lines of
 * the words and the rail.
 */
export function MarketingApprovalCard({
  row,
  variant,
  format,
  rail,
  assets,
  statusTag,
}: {
  row: Row;
  variant: "full" | "compact";
  format: MarketingCardFormat;
  rail: ReactNode;
  /** The attached-files line the Assets tab's previews belong to (full only). */
  assets?: ReactNode;
  /** The status word, drawn when the post is not simply waiting. */
  statusTag?: ReactNode;
}) {
  const m = useAdminMessages(adminMarketingAgentMessages);
  const words = str(row.renderedText) || str(row.excerpt);
  const guard = format.guardTone(row.guardDecision);
  const codes = Array.isArray(row.guardCodes) ? (row.guardCodes as unknown[]).filter((c): c is string => typeof c === "string" && c !== "") : [];
  const assetCount = Array.isArray(row.assetIds) ? row.assetIds.length : 0;
  const header = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-200">
        {format.channelName(row.channel)}
      </span>
      <span className="font-mono uppercase text-zinc-400">{str(row.locale)}</span>
      <span className="text-zinc-500" title={format.stamp(row.createdAt) ?? ""}>
        {format.relative(row.createdAt) ?? ""}
      </span>
      {statusTag}
    </div>
  );

  if (variant === "compact") {
    return (
      <article data-testid="marketing-pending-card" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-3">
        <MarketingPostThumb assetIds={row.assetIds} />
        {header}
        <p className="line-clamp-3 text-sm font-semibold leading-5 text-zinc-100">{words}</p>
        <div className="mt-auto">{rail}</div>
      </article>
    );
  }

  const checks: { ok: boolean; text: string }[] = [
    { ok: guard === "success", text: m.checkGuard(format.guardWord(row.guardDecision)) },
    ...(codes.length > 0 ? [{ ok: guard === "success", text: m.checkGuardCodes(codes.join(" · ")) }] : []),
    typeof row.claimCount === "number"
      ? { ok: true, text: m.checkClaims(row.claimCount) }
      : { ok: false, text: m.checkClaimsUnknown },
    assetCount > 0 ? { ok: true, text: m.checkAssets(assetCount) } : { ok: true, text: m.checkNoAssets },
    typeof row.approvalExpiresAt === "string"
      ? { ok: true, text: m.checkExpires(format.stamp(row.approvalExpiresAt) ?? "") }
      : { ok: true, text: m.checkNoExpiry },
  ];

  return (
    <article
      data-testid="marketing-row"
      className="grid min-w-0 gap-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <MarketingPostThumb assetIds={row.assetIds} />
        <p className="text-xs text-zinc-500">{str(row.accountSlug)}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {header}
        {/* The whole post as it will go out, line breaks included: a person approves these words. */}
        <p
          data-testid="marketing-queue-text"
          className="whitespace-pre-line rounded-xl bg-zinc-800 p-4 text-sm leading-6 text-zinc-100"
        >
          {words}
        </p>
        {assets}
        <div>
          <p className="text-xs font-bold text-zinc-400">{m.checksTitle}</p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {checks.map((check) => (
              <li key={check.text} className="flex items-start gap-2 text-sm text-zinc-200">
                {check.ok ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
                )}
                {check.text}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AdminStatusChip tone={TONE[guard]}>{format.guardWord(row.guardDecision)}</AdminStatusChip>
          <span className="text-xs text-zinc-500">{m.approvalNote}</span>
        </div>
        {rail}
      </div>
    </article>
  );
}
