/**
 * The Guard on what a video or image says (operator decision 2026-10-31: the
 * media CLI writes its own scripts from the generator context, with no script
 * table or approval screen, so the words inside a file go through the Guard
 * instead).
 *
 * Each locale's transcript -- the narration and every on-screen line -- is
 * judged as new copy by the draft intake's own path: the facts resolved and
 * sealed in the caller's transaction (`resolveMarketingFactsWithSnapshot`), the
 * same Guard (`guardDraft`), the same context. Only a `reject` refuses the
 * submission; a person sees every asset before it is used anyway, so the
 * approval codes say nothing a person does not already do.
 *
 * The Guard asks for an account. An asset is not one account's, so the scope
 * is the asset itself (`asset:<id>`), with no posting history, on the first
 * channel it allows: the reject rules read the words, the claims and the
 * facts, not the channel.
 */

import "server-only";

import { resolveMarketingFactsWithSnapshot } from "@/lib/marketingFactResolution";
import { guardDraft, type MarketingRejectCode } from "@/lib/marketingGuardCore";
import { resolveMarketingGuardContext } from "@/lib/marketingGuardContext";
import type { MarketingAssetSubmission } from "@/lib/marketingAssetSubmission";
import type { MarketingTransaction } from "@/lib/marketingStore";

export type MarketingAssetTranscriptVerdict =
  | { readonly pass: true }
  /** The codes only: a transcript's words are not repeated back. */
  | { readonly pass: false; readonly codes: readonly MarketingRejectCode[] };

export async function guardMarketingAssetTranscript(
  tx: MarketingTransaction,
  submission: MarketingAssetSubmission,
): Promise<MarketingAssetTranscriptVerdict> {
  const channel = submission.asset.allowedChannels[0];
  const channelId = `asset:${submission.asset.id}`;
  const claimIds = [...submission.asset.claimIds];
  const codes = new Set<MarketingRejectCode>();
  for (const [locale, text] of Object.entries(submission.transcript ?? {}).sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    if (typeof text !== "string") continue;
    const { facts } = await resolveMarketingFactsWithSnapshot(tx, {
      claimIds,
      assetIds: [],
      channelId,
      channel,
      locale,
    });
    const verdict = guardDraft({
      draft: { renderedText: text, locale, channel, channelId, claimIds, assetIds: [] },
      facts,
      templates: [],
      context: resolveMarketingGuardContext(),
    });
    if (verdict.verdict === "reject") for (const code of verdict.codes) codes.add(code);
  }
  return codes.size === 0 ? { pass: true } : { pass: false, codes: [...codes].sort() };
}
