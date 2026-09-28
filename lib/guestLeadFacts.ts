import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  GUEST_BRAND_TRIO_MODEL_IDS,
  GUEST_FALLBACK_MODEL_IDS,
  createGuestEligibilityCheck,
} from "@/lib/appDefaults";
import { effectiveGuestLeadModelId } from "@/lib/defaultModelConsole";
import { registryRowToModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

type LeadDb = PrismaClient | Prisma.TransactionClient;
type LeadRow = Parameters<typeof registryRowToModel>[0];

const LEAD_LOOKUP_IDS = [...GUEST_BRAND_TRIO_MODEL_IDS, ...GUEST_FALLBACK_MODEL_IDS];

/**
 * Rows the guest screen can actually resolve.
 *
 * `registryRowToModel` throws on a bad provider, API base URL or key
 * reference. `getRuntimeModels` already drops that row and keeps the rest.
 * This lookup is now on the model list and on every model write, so the same
 * throw has to stay inside one row: otherwise the list that would let an
 * operator repair it answers 500 instead.
 */
export function indexGuestLeadRows(rows: readonly LeadRow[]) {
  const byId = new Map<string, ReturnType<typeof registryRowToModel>>();
  for (const row of rows) {
    try {
      byId.set(row.id, registryRowToModel(row));
    } catch (error) {
      console.error("Ignoring invalid model registry row:", {
        modelId: row.id,
        error: error instanceof Error ? error.message : "Invalid registry row",
      });
    }
  }
  return byId;
}

/**
 * The stored guest-lead setting and the lead guests actually see.
 *
 * A missing row is not "no lead". Resolution uses the compiled trio, which is
 * the same answer the guest screen gives when the setting has never been
 * saved. Callers that only compared the raw row missed that lead.
 */
export async function readGuestLeadFacts(db: LeadDb = prisma): Promise<{
  stored: string | null;
  effective: string | null;
}> {
  const [setting, rows] = await Promise.all([
    db.appSetting.findUnique({
      where: { key: "guestDefaultModelId" },
      select: { value: true },
    }),
    db.modelRegistryEntry.findMany({
      where: { id: { in: LEAD_LOOKUP_IDS } },
    }),
  ]);
  const byId = indexGuestLeadRows(rows);
  const isEligible = (modelId: string) => {
    try {
      return createGuestEligibilityCheck((id) => byId.get(id))(modelId);
    } catch (error) {
      console.error("Ignoring invalid model registry row:", {
        modelId,
        error: error instanceof Error ? error.message : "Invalid registry row",
      });
      return false;
    }
  };
  const stored = setting?.value ?? null;
  return {
    stored,
    effective: effectiveGuestLeadModelId(stored, isEligible),
  };
}
