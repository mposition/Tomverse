/**
 * The staging webhook shadow's storage transaction (S2e), apart from the store.
 *
 * Its own file because it is a pipeline file: every byte here is in the
 * webhook pipeline fingerprint (lib/marketingAutomationAccess.ts), and a signed
 * staging verification record goes stale when any of them changes. Kept inside
 * the store, every unrelated store change would have staled the record too.
 *
 * It writes no marketing table itself: the report goes through the store's
 * `insertMarketingReport`, the one writer of that table.
 */
import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { MARKETING_REPORT_AUDIT_TARGET_TYPE } from "@/lib/marketingAuditEvidence";
import {
  MARKETING_S2E_ACTIONS,
  insertMarketingReport,
  marketingDatabaseNow,
  type MarketingDatabase,
  type MarketingTransaction,
} from "@/lib/marketingStore";

/**
 * One staging shadow report of a signed webhook event, with its audit entry.
 *
 * The report and the system audit commit together or not at all. A second
 * delivery of the same event fails the insert on
 * `MarketingReport_webhook_shadow_event_key` and the transaction rolls back --
 * so a duplicate leaves no report and no audit entry. The caller recognises
 * that unique violation and answers the delivery as already recorded; nothing
 * here asks first, because asking first is a race the index does not have.
 *
 * Shadow means shadow: no post is read for update and none is changed.
 */
export async function recordMarketingWebhookShadow(
  database: MarketingTransaction,
  rawInput: {
    readonly eventIdDigest: string;
    readonly eventType: string;
    readonly channelId: string;
    readonly derivedStatus: string;
    readonly statusQueryMatch: boolean;
  },
): Promise<{ readonly reportId: string }> {
  const input = {
    eventIdDigest: String(rawInput.eventIdDigest),
    eventType: String(rawInput.eventType),
    channelId: String(rawInput.channelId),
    derivedStatus: String(rawInput.derivedStatus),
    statusQueryMatch: rawInput.statusQueryMatch === true,
  };
  // The audit chain first, as every writer here takes it.
  await takeAuditChainLock(database);
  const now = await marketingDatabaseNow(database);
  const report = await insertMarketingReport(database, {
    kind: "webhook_shadow",
    periodStart: now,
    periodEnd: now,
    // Parsed against the strict `webhook_shadow` schema inside: a digest that
    // is not lowercase SHA-256 or a status off the closed list is refused here.
    payload: input,
    sourceVersion: "marketing-webhook-shadow-v1",
  });
  await writeSystemAuditLog({
    tx: database,
    systemActor: "marketing-webhook",
    action: MARKETING_S2E_ACTIONS.shadowRecorded,
    targetType: MARKETING_REPORT_AUDIT_TARGET_TYPE,
    targetId: report.id,
    summary: "Recorded a signed webhook event in shadow, without applying it.",
    metadata: {
      eventIdDigest: input.eventIdDigest,
      eventType: input.eventType,
      channelId: input.channelId,
      derivedStatus: input.derivedStatus,
      statusQueryMatch: input.statusQueryMatch,
    },
  });
  return { reportId: report.id };
}

/**
 * Whether a shadow report of this event already exists.
 *
 * Asked after an insert failed, not before one: the index is what refuses a
 * duplicate, and this only tells a caller whether the failure it caught was
 * that refusal. Matching on the stored digest rather than on how Prisma
 * describes an expression index in its error keeps the answer about the row,
 * not about an error format nobody here controls.
 */
export async function marketingWebhookShadowExists(
  database: MarketingDatabase,
  eventIdDigest: string,
): Promise<boolean> {
  const found = await database.marketingReport.findFirst({
    where: {
      kind: "webhook_shadow",
      payload: { path: ["eventIdDigest"], equals: String(eventIdDigest) },
    },
    select: { id: true },
  });
  return found !== null;
}
