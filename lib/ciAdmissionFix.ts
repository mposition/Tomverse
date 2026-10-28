import "server-only";

import type { PrismaClient } from "@prisma/client";

import { ciFixView, type CiFixView } from "@/lib/ciAdmissionFixCore";
import {
  REVIEW_ORCHESTRATOR_STALE_AFTER_MS,
  REVIEW_ORCHESTRATOR_STATUS_KEY,
  parseStoredReviewStatus,
} from "@/lib/reviewOrchestratorStatusCore";

/**
 * The CI auto-fix's latest tries as the review server last reported them
 * (lib/ciAdmissionFixCore.ts), for CI admission's screen and round. A missing
 * or unreadable report is an empty view: nothing is decided on it.
 */
export async function readCiFixView(db: Pick<PrismaClient, "appSetting">, nowMs: number = Date.now()): Promise<CiFixView> {
  const row = await db.appSetting.findUnique({ where: { key: REVIEW_ORCHESTRATOR_STATUS_KEY } });
  return ciFixView(row ? parseStoredReviewStatus(row.value) : null, nowMs, REVIEW_ORCHESTRATOR_STALE_AFTER_MS);
}
