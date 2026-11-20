// The external channels' view of the coding catalogue (owner decision
// 2026-11-20). Behind CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED, default off:
// off, nothing here reads the database and the external API offers what the
// chat registry serves, as before. On, the external API, Smart Adaptive, the
// coding-app settings and the tomverse CLI offer only the chat models the newest
// coding snapshot lists for their channel and the coding judge still admits
// now. The snapshot is an allow-list only: requests still run and bill through
// the chat registry's own path.
import "server-only";

import {
  chatModelFacts,
  loadCodingCatalog,
  loadCodingProviderTerms,
  parseSnapshotRows,
  servableCodingRows,
} from "@/lib/modelCatalog";
import {
  codingCatalogExternalChannelsEnabled,
  codingPlanReaches,
  externalChannelModelIds,
  snapshotIsCurrent,
} from "@/lib/modelCatalogCore";
import type { AiModel, ModelTier } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

export type ExternalCodingChannel = "api" | "cli";

let warnedNoSnapshot = 0;

/**
 * The chat model ids this channel may offer to this plan, or null when the
 * switch is off (no filter).
 *
 * A model must be in the newest snapshot for the channel at a plan this
 * account reaches (publishing is the step that exposes it) and must still be
 * admitted now -- on, not held, the channel still ticked, its current minimum
 * plan reached, its provider's conditions still allowing it -- so a hold, a
 * raised plan or a re-check that refuses a model takes effect at once, not at
 * the next publish. No snapshot, or one past its coverage, offers nothing: an
 * unpublished catalogue does not fall back to the whole registry.
 */
export const externalChannelAllowlist = async (
  channel: ExternalCodingChannel,
  plan: ModelTier,
  options: { runtime?: readonly AiModel[]; env?: Readonly<Record<string, string | undefined>>; now?: Date } = {}
): Promise<ReadonlySet<string> | null> => {
  if (!codingCatalogExternalChannelsEnabled(options.env ?? process.env)) return null;
  const now = options.now ?? new Date();
  const snapshot = await prisma.modelCatalogSnapshot.findFirst({ where: { category: "coding" }, orderBy: { version: "desc" } });
  if (!snapshot || !snapshotIsCurrent(snapshot.coverageUntil, now)) {
    // Once a minute per instance at most: this is on every external request.
    if (now.getTime() - warnedNoSnapshot > 60_000) {
      warnedNoSnapshot = now.getTime();
      console.warn(
        JSON.stringify({
          event: "coding_catalog_external_channels_no_snapshot",
          channel,
          state: snapshot ? "stale" : "missing",
          version: snapshot?.version ?? null,
        })
      );
    }
    return new Set();
  }
  const runtime = options.runtime ?? (await getRuntimeModels());
  const entries = await loadCodingCatalog(prisma, {
    now,
    context: { chat: runtime.map(chatModelFacts), providerTerms: await loadCodingProviderTerms(prisma) },
  });
  // The current row's channel and plan narrow the published row's: a plan
  // raised or a channel unticked since publishing applies now.
  const admitted = servableCodingRows(entries).filter(
    (row) => row.channels.includes(channel) && codingPlanReaches(plan, row.minimumPlan)
  );
  return externalChannelModelIds(parseSnapshotRows((snapshot.payload as { models?: unknown[] } | null)?.models ?? []), {
    channel,
    plan,
    activeIds: new Set(admitted.map((row) => row.modelId)),
  });
};
