import { z } from "zod";

import { amuxMachineIdSchema } from "./claimContract.ts";
import { amuxV22OneShotRoleSupported, amuxV22OneShotRouteSupported,
  amuxV22RequiredTool } from "./v22WorkerClaimCore.ts";

/** Candidate metadata, not permission to execute. Task approval, price,
 * runtime lease, quota and the one-shot guards remain authoritative. */
export const AMUX_V22_WORKER_CATALOG_ENV = "TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON";
const MAX_BYTES = 131_072;
const metadataSchema = z.object({
  worker_name: amuxMachineIdSchema,
  provider: z.literal("anthropic"),
  model: z.string().min(1).max(160),
  routing_roles: z.array(z.string().refine(amuxV22OneShotRoleSupported)).min(1).max(4),
  tool_capabilities: z.array(z.enum(["repo_read", "repo_write"])).min(1).max(2),
}).strict().refine((row) => amuxV22OneShotRouteSupported(row.provider, row.model) &&
  new Set(row.routing_roles).size === row.routing_roles.length &&
  new Set(row.tool_capabilities).size === row.tool_capabilities.length &&
  row.routing_roles.every((role) => row.tool_capabilities.some(
    (capability) => capability === amuxV22RequiredTool(role))));
const catalogSchema = z.array(metadataSchema).min(1).max(128);

type BaseWorker = { worker_name: string; provider: string };
type Metadata = z.infer<typeof metadataSchema>;

/** Never mine the resident roster, infer roles from names or replace the
 * legacy catalog. Only already-admitted identities may receive an explicit
 * v22 profile, and all legacy lifecycle exclusions survive the overlay. */
export function parseAmuxV22WorkerCatalog<T extends BaseWorker>(
  raw: string | undefined, admitted: readonly T[] | null,
): Array<T & Metadata> | null {
  if (!raw?.trim() || !admitted?.length || Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
    return null;
  }
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return null; }
  const parsed = catalogSchema.safeParse(decoded);
  if (!parsed.success) return null;
  const baseByName = new Map(admitted.map((worker) => [worker.worker_name, worker]));
  if (baseByName.size !== admitted.length) return null;
  const seen = new Set<string>();
  const result: Array<T & Metadata> = [];
  for (const profile of parsed.data) {
    const base = baseByName.get(profile.worker_name);
    if (!base || !["claude", "anthropic"].includes(base.provider) ||
        seen.has(profile.worker_name)) return null;
    seen.add(profile.worker_name);
    // The explicit one-shot model does not rewrite a legacy CLI model alias.
    result.push({ ...base, ...profile });
  }
  return result.sort((a, b) => a.worker_name.localeCompare(b.worker_name));
}
