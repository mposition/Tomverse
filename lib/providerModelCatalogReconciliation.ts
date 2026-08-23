import "server-only";

import { prisma } from "@/lib/prisma";
import { recordAutoDisableWorkItem } from "@/lib/modelLifecycleWorkItems";
import { countStoredModelUsage } from "@/lib/modelUsageFootprint";
import {
  AUTO_DISABLE_REASON,
  missingConfirmationRuns,
  planCatalogReconciliation,
  type CatalogReconciliationPlan,
} from "@/lib/providerModelCatalogCore";
import type { ProviderModelCatalogResult } from "@/lib/providerModelCatalogMonitor";

// F-05: the catalog monitor has always been able to prove that a provider
// stopped serving a model -- it escalates the entry to "likely_deprecated"
// once the model is absent from enough consecutive *successful* scans, and
// names it in the daily report. Nothing acted on that. lib/models.ts is a
// static seed and ModelRegistryEntry is the runtime source of truth, so a
// retired model stayed enabled and user-selectable until somebody edited the
// registry by hand. groq's llama-4-scout sat that way for six days, failing
// every call with HTTP 404 the whole time.
//
// This closes the loop against the registry's existing retirement fields
// rather than inventing a parallel mechanism, and it only ever disables --
// catalogDeleted is what the admin delete endpoint sets and what hides a row
// from every runtime read, so it stays a human decision. enabled:false is
// already enough to stop a model being selected.
//
// The decision itself lives in planCatalogReconciliation (pure, unit-tested);
// this module is the database boundary around it.

export { AUTO_DISABLE_REASON };

export type CatalogReconciliationResult = {
  ran: boolean;
  disabled: CatalogReconciliationPlan["disable"];
  restored: CatalogReconciliationPlan["restore"];
  held: CatalogReconciliationPlan["hold"];
};

/** Escape hatch for operators: set to "false" to leave the registry untouched
 *  and keep the monitor purely advisory, as it was before. */
const automationEnabled = () =>
  process.env.PROVIDER_MODEL_CATALOG_AUTO_DISABLE !== "false";

export async function reconcileCatalogWithRegistry(input: {
  results: readonly ProviderModelCatalogResult[];
  /** Defaults to the same value the monitor used to set "likely_deprecated",
   *  so the threshold that reports a model and the threshold that acts on it
   *  cannot drift apart. */
  confirmationRuns?: number;
}): Promise<CatalogReconciliationResult> {
  const disabled: CatalogReconciliationResult["disabled"] = [];
  const restored: CatalogReconciliationResult["restored"] = [];
  const held: CatalogReconciliationResult["held"] = [];

  if (!automationEnabled()) return { ran: false, disabled, restored, held };

  const confirmationRuns =
    input.confirmationRuns ??
    missingConfirmationRuns(process.env.PROVIDER_MODEL_MISSING_CONFIRMATION_RUNS);

  for (const result of input.results) {
    if (result.status !== "checked") continue;

    const registry = await prisma.modelRegistryEntry.findMany({
      where: { provider: result.provider, catalogDeleted: false },
      select: { id: true, apiModel: true, enabled: true, operationalReason: true },
    });

    const plan = planCatalogReconciliation({
      check: {
        provider: result.provider,
        status: result.status,
        missing: result.missing,
        mapped: result.mapped,
      },
      registry,
      confirmationRuns,
    });

    for (const item of plan.disable) {
      // Read before the transaction: it is three counts over tables this
      // transaction does not touch, and holding a write transaction open
      // across them would make a nightly scan contend with live traffic.
      const usage = await countStoredModelUsage(item.modelId);

      // The switch-off and the record of it commit together. A crash between
      // them would leave a model disabled with nothing saying why or who is
      // affected, which is the state ML-08 is about.
      await prisma.$transaction(async (tx) => {
        await tx.modelRegistryEntry.update({
          where: { id: item.modelId },
          data: {
            enabled: false,
            status: "disabled",
            operationalReason:
              `${AUTO_DISABLE_REASON} Missing from ${item.consecutiveMissing} consecutive scans as ${item.apiModel}.`.slice(
                0,
                500
              ),
          },
        });
        await recordAutoDisableWorkItem({
          tx,
          provider: result.provider,
          apiModel: item.apiModel,
          modelId: item.modelId,
          consecutiveMissing: item.consecutiveMissing,
          usage,
        });
      });
      disabled.push(item);
    }

    for (const item of plan.restore) {
      await prisma.modelRegistryEntry.update({
        where: { id: item.modelId },
        data: { enabled: true, status: "enabled", operationalReason: null },
      });
      restored.push(item);
    }

    held.push(...plan.hold);
  }

  return { ran: true, disabled, restored, held };
}
