import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
import { AMUX_V22_WORKER_CATALOG_ENV, parseAmuxV22WorkerCatalog } from "@/lib/amux/v22WorkerCatalogCore";
import { amuxWorkerCapabilityV22Catalog } from "@/lib/amux/workerCapabilityCore";
import { readAmuxWorkerCapabilitiesOrThrow } from "@/lib/amux/workerCapabilityStore";
import {
  amuxWorkerDerivedCatalogShadowOpen,
  compareAmuxDerivedCatalogWithEnv,
  deriveAmuxWorkerCatalog,
  type AmuxDerivedCatalogShadowView,
} from "@/lib/amux/workerDerivedCatalogCore";
import { readAmuxWorkerRegistryOrThrow } from "@/lib/amux/workerRegistryStore";

/**
 * AMUX › Execution › Workers, derived catalog (orchestration policy version
 * 35, section 3 and stage R2b): the catalog the registry would give, beside
 * the catalog variables this server holds. A shadow only -- no consumer reads
 * it until R2c, and nothing here assigns or writes anything.
 *
 * With R2b's code latch off, nothing is read. A failed read throws; the page
 * shows it as unavailable, never as a difference.
 */
export async function readAmuxDerivedCatalogShadowForAdmin(): Promise<AmuxDerivedCatalogShadowView> {
  if (!amuxWorkerDerivedCatalogShadowOpen()) return { shadow: "off" };
  const registry = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryRead, (tx) =>
    readAmuxWorkerRegistryOrThrow(tx),
  );
  const capabilities = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityRead, (tx) =>
    readAmuxWorkerCapabilitiesOrThrow(tx),
  );
  const legacy = getConfiguredAmuxWorkerCatalog();
  const derived = deriveAmuxWorkerCatalog({
    registrations: registry.registrations,
    capabilities,
    latches: registry.latches,
  });
  return {
    shadow: "on",
    comparison: compareAmuxDerivedCatalogWithEnv({
      derived,
      legacy,
      v22: amuxWorkerCapabilityV22Catalog(process.env[AMUX_V22_WORKER_CATALOG_ENV], (raw) =>
        parseAmuxV22WorkerCatalog(raw, legacy),
      ),
    }),
  };
}
