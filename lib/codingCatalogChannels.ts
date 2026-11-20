// The external channels' view of the coding catalogue (owner decision
// 2026-11-20). Behind CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED, default off:
// off, nothing here reads the database and the external API offers what the
// chat registry serves, as before. On, the external API, Smart Adaptive, the
// coding-app settings and the tomverse CLI offer only the chat models the newest
// coding snapshot lists for their channel. The snapshot is an allow-list only:
// requests still run and bill through the chat registry's own path.
import "server-only";

import {
  codingCatalogExternalChannelsEnabled,
  codingCatalogRowSchema,
  externalChannelModelIds,
  snapshotIsCurrent,
  type CodingCatalogRow,
} from "@/lib/modelCatalogCore";
import type { ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";

export type ExternalCodingChannel = "api" | "cli";

let warnedNoSnapshot = 0;

/**
 * The chat model ids this channel may offer to this plan, or null when the
 * switch is off (no filter). No snapshot, or one past its coverage, offers
 * nothing: an unpublished catalogue does not fall back to the whole registry.
 */
export const externalChannelAllowlist = async (
  channel: ExternalCodingChannel,
  plan: ModelTier,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: Date = new Date()
): Promise<ReadonlySet<string> | null> => {
  if (!codingCatalogExternalChannelsEnabled(env)) return null;
  const [snapshot, active] = await Promise.all([
    prisma.modelCatalogSnapshot.findFirst({ where: { category: "coding" }, orderBy: { version: "desc" } }),
    prisma.modelCatalogEntry.findMany({
      where: { category: "coding", enabled: true, holdReason: null },
      select: { modelId: true },
    }),
  ]);
  if (!snapshot || !snapshotIsCurrent(snapshot.coverageUntil, now)) {
    // Once a minute at most: this is on every external request.
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
  const models = ((snapshot.payload as { models?: unknown[] } | null)?.models ?? []).flatMap((model): CodingCatalogRow[] => {
    const parsed = codingCatalogRowSchema.safeParse(model);
    return parsed.success ? [parsed.data] : [];
  });
  return externalChannelModelIds(models, {
    channel,
    plan,
    activeIds: new Set(active.map((row) => row.modelId)),
  });
};
