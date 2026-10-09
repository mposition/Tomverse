import "server-only";

import {
  AUTO_ROLLOUT_READINESS_VERSION,
  autoRolloutReadiness,
} from "@/lib/autoRolloutReadiness";
import type { PublicBuildInfo } from "@/lib/buildInfo";
import { activeManifestHashKey } from "@/lib/manifestHashKeyring";
import { dispatchInstrumentationMode } from "@/lib/routingInstrumentationMode";
import { isRouterShadowEnabled } from "@/lib/routingShadow";

/** Runtime diagnostics only: neither an attestation nor evidence for old rows. */
export function autoRoutingRuntimeReadback(
  build: PublicBuildInfo,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now
) {
  const observedAt = now();
  let manifestKeyringConfigured = false;
  try {
    activeManifestHashKey(environment);
    manifestKeyringConfigured = true;
  } catch {
    // Even a malformed key id is operator input. Return no parser error prose.
  }

  return {
    observedAt: new Date(observedAt).toISOString(),
    build,
    readiness: {
      version: AUTO_ROLLOUT_READINESS_VERSION,
      ...autoRolloutReadiness(undefined, () => observedAt),
    },
    shadowEnabled: isRouterShadowEnabled(environment),
    dispatchInstrumentationMode: dispatchInstrumentationMode(environment),
    manifestKeyringConfigured,
  };
}
