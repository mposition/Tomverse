/**
 * The Guard on what a video or image says (operator decision 2026-10-31: the
 * media CLI writes its own scripts from the generator context, with no script
 * table or approval screen, so the words inside a file go through the Guard
 * instead).
 *
 * Each locale's transcript -- the narration and every on-screen line --, its
 * alt text and a video's chapter titles (owner decision 2026-11-07: they go
 * into a YouTube description) are judged together as new copy by the draft
 * intake's own path: the
 * facts resolved and sealed in the caller's transaction
 * (`resolveMarketingFactsWithSnapshot`), the same Guard (`guardDraft`), the
 * same context. Only a `reject` refuses the
 * submission; a person sees every asset before it is used anyway, so the
 * approval codes say nothing a person does not already do.
 *
 * The Guard asks for an account. An asset is not one account's, so the scope
 * is the asset itself (`asset:<id>`), with no posting history, on the first
 * channel it allows: the reject rules read the words, the claims and the
 * facts, not the channel.
 */

import "server-only";

import { takeAuditChainLock } from "@/lib/adminAudit";
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
  // The audit chain lock first, before the registry's rows are held FOR SHARE:
  // a person's decision takes the chain lock and then updates an asset row, so
  // holding the rows and then waiting for the chain would deadlock with it. The
  // draft intake takes the same order; the submission's own lock is re-entrant.
  await takeAuditChainLock(tx);
  const codes = new Set<MarketingRejectCode>();
  // Every locale the file speaks or is described in: its transcript and its
  // alt text are both copy a reader gets. The alt text always has a locale, so
  // the declared claims are judged even for an image that says nothing.
  const transcript = (submission.transcript ?? {}) as Record<string, string | undefined>;
  const alt = submission.asset.alt as Record<string, string | undefined>;
  const chapters = submission.chapters ?? [];
  const chapterLocales = chapters.flatMap((chapter) => Object.keys(chapter.title));
  const locales = [...new Set([...Object.keys(transcript), ...Object.keys(alt), ...chapterLocales])].sort();
  for (const locale of locales) {
    // One title per line, as the description will carry them.
    const titles = chapters
      .map((chapter) => (chapter.title as Record<string, string | undefined>)[locale])
      .filter((title): title is string => typeof title === "string");
    const text = [transcript[locale], alt[locale], titles.length > 0 ? titles.join("\n") : undefined]
      .filter((part): part is string => typeof part === "string")
      .join("\n\n");
    // Per locale: the facts are sealed for one locale, so each is resolved for its own.
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
