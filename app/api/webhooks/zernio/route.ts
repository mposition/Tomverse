export const dynamic = "force-dynamic";
// The signature covers the raw bytes; verifying it needs node:crypto and a body
// that has not been through a parse and a re-serialise.
export const runtime = "nodejs";

import { buildZernioAdapterFromEnv } from "@/app/api/_marketing/zernioAdapter";
import {
  marketingWebhookShadowExists,
  recordMarketingWebhookShadow,
  runMarketingTransaction,
} from "@/lib/marketingStore";
import { MARKETING_WEBHOOK_SHADOW_KEY } from "@/lib/marketingAutomationAccess";
import { marketingWebhookIsStaging } from "@/lib/marketingWebhookCore";
import { handleZernioWebhook } from "@/lib/marketingWebhookReceiver";
import { consumeMarketingWebhookFaultArm } from "@/lib/marketingWebhookSettings";
import { prisma } from "@/lib/prisma";

/**
 * Zernio's webhook, received in staging only, recorded in shadow only
 * (S2 plan, S2e). Production answers 404 and reads nothing.
 *
 * `ZERNIO_WEBHOOK_SECRET` is read here and nowhere else. The status query a
 * shadow report compares against uses a short budget: Zernio wants a 2xx
 * within five seconds and retries otherwise, and a retry is deduped anyway.
 */
const STATUS_QUERY_BUDGET_MS = 3_000;

export async function POST(request: Request) {
  return handleZernioWebhook(request, {
    isStaging: () => marketingWebhookIsStaging(),
    secret: process.env.ZERNIO_WEBHOOK_SECRET,
    adapter: buildZernioAdapterFromEnv(STATUS_QUERY_BUDGET_MS),
    consumeFaultArm: (eventIdDigest) =>
      // Read committed, its own transaction: of two deliveries racing for one
      // arm, the second waits on the row and then matches nothing.
      runMarketingTransaction(prisma, (tx) =>
        consumeMarketingWebhookFaultArm(tx, { eventIdDigest }),
      ),
    shadowEnabled: async () => {
      const row = await prisma.appSetting.findUnique({
        where: { key: MARKETING_WEBHOOK_SHADOW_KEY },
        select: { value: true },
      });
      return row?.value === "true";
    },
    resolveChannel: async (accountIds) => {
      if (accountIds.length === 0) return null;
      const rows = await prisma.marketingChannel.findMany({
        where: { provider: "zernio", externalAccountRef: { in: [...accountIds] } },
        select: { id: true },
        take: 2,
      });
      // One account, one channel. None is not ours; several is not one answer.
      return rows.length === 1 ? rows[0] : null;
    },
    recordShadow: async (input) => {
      try {
        await runMarketingTransaction(prisma, (tx) => recordMarketingWebhookShadow(tx, input));
        return "recorded";
      } catch (error) {
        // The shadow index refused a second report of this event -- or something
        // else failed. Asked of the row, not of the error's wording.
        if (await marketingWebhookShadowExists(prisma, input.eventIdDigest)) return "duplicate";
        throw error;
      }
    },
  });
}
