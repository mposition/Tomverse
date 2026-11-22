export const dynamic = "force-dynamic";

import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { loadAmuxExistingHierarchyTargets } from "@/lib/amux/ideaNodeDuplicateScanService";
import {
  AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV,
  amuxSessionIntakeConflictingSecretValues,
  isAmuxSessionIntakeClientAuthorized,
} from "@/lib/amux/ideaSessionIntakeReadbackCore";

/**
 * Owner decision 2026-11-22: the existing Initiative / Epic / Feature
 * hierarchy, for `npm run amux:idea -- prompt|check|submit`, so a plan a
 * coding session writes can attach to it. Read-only, behind the same
 * dedicated session intake credential as the intake itself; it returns only
 * the active nodes' id, level, title, parent id and Feature card number
 * prefix, which is what the box analysis prompt shows the model.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAmuxSessionIntakeClientAuthorized(request,
    process.env[AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV],
    amuxSessionIntakeConflictingSecretValues(process.env))) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  try {
    return amuxJsonNoStore({ nodes: await loadAmuxExistingHierarchyTargets() }, 200);
  } catch {
    return amuxJsonNoStore({ error: "hierarchy_unavailable" }, 503);
  }
}
