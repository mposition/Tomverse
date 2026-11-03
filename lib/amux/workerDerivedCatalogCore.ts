import { amuxWorkerCapabilityWithinCeiling, type AmuxWorkerCapability } from "./workerCapabilityCore.ts";
import { amuxV22ProviderForClass, type AmuxV22Provider } from "./v22WorkerClaimCore.ts";
import {
  AMUX_WORKER_CATALOG_EXEMPT,
  amuxWorkerLatchOpen,
  amuxWorkerRoleRank,
  type AmuxWorkerRoleCeiling,
  type AmuxWorkerLatchEventKind,
  type AmuxWorkerRegistration,
} from "./workerRegistryCore.ts";

/**
 * Orchestration policy version 35, section 3: the assignment catalog derived
 * from the registry. Stage R2c (version 53) made it the only catalog every
 * assignment path reads, and stage R2e removed the catalog variables it was
 * compared with (R2b) and could fall back to, along with R2b's and R2c's code
 * latches. Pure: no database, no environment.
 */

/**
 * Orchestration policy version 55, section 1: the bridge-scope route's code
 * latch. Stage S1 shipped it off, so the route answered `bridge_scope_off`
 * and a bridge started with `--worker` registered nothing. Stage S3 turns it
 * on (owner approval in chat, recorded in the PR, per the 2026-10-19
 * direction). Bridges started without `--worker` never call the route, so
 * this alone changes no assignment; the host then moves each worker to its
 * own unit under section 3.1. Turning it off again stops new registrations
 * but is not a rollback by itself (section 3.1).
 */
export const AMUX_WORKER_BRIDGE_SCOPE_LATCH = true;
export const amuxWorkerBridgeScopeOpen = (): boolean => AMUX_WORKER_BRIDGE_SCOPE_LATCH;

/** Which bridge kind serves a worker (version 55, section 1). */
export type AmuxWorkerBridgeKind = "session" | "v22";
export type AmuxWorkerBridgeScopeEntry = { name: string; kind: AmuxWorkerBridgeKind };

/**
 * Version 55, section 1: every worker the derived catalog lists, without the
 * code constants, with its kind -- `v22` when its capability carries a v22
 * profile, `session` otherwise. Both come from what the owner records in
 * Admin (the registry and the capability table). Pure; name order.
 */
export function amuxWorkerBridgeScope(derived: AmuxDerivedCatalog): AmuxWorkerBridgeScopeEntry[] {
  const v22 = new Set(derived.v22.map((entry) => entry.worker_name));
  return derived.legacy
    .map((entry) => entry.worker_name)
    .filter((name) => !amuxDerivedCatalogEntryIsConstant(name))
    .sort()
    .map((name) => ({ name, kind: v22.has(name) ? "v22" : "session" }));
}

/** One entry in the shape the legacy catalog's consumers read. */
export type AmuxDerivedCatalogEntry = {
  worker_name: string;
  provider: string;
  model: string | null;
  routing_roles: string[];
  tool_capabilities: string[];
  archived: false;
  paused: false;
  isolated: false;
  blocked: false;
};

/** One v22 profile, overlaid on its legacy entry. */
export type AmuxDerivedV22CatalogEntry = Omit<AmuxDerivedCatalogEntry, "provider" | "model"> & {
  provider: AmuxV22Provider;
  model: string;
};

export type AmuxDerivedCatalog = {
  legacy: AmuxDerivedCatalogEntry[];
  v22: AmuxDerivedV22CatalogEntry[];
};

/**
 * Version 35 section 3: `engineering-runner` cannot be registered (version
 * 34), so its catalog entry is a code constant the engineering agent policy
 * owns, equal to the catalog variable's entry as read on 2026-10-13 (the
 * variable itself is gone since R2e). Whether it is used is decided by the
 * engineering adapter's latch and operating mode (version 25). Changing it is
 * a change to the engineering agent policy.
 */
export const AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY: Readonly<AmuxDerivedCatalogEntry> = Object.freeze({
  worker_name: "engineering-runner",
  provider: "claude",
  model: "claude-opus-5",
  routing_roles: Object.freeze(["engineering"]) as unknown as string[],
  tool_capabilities: Object.freeze([]) as unknown as string[],
  archived: false,
  paused: false,
  isolated: false,
  blocked: false,
});

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();
const byName = <T extends { worker_name: string }>(a: T, b: T) => a.worker_name.localeCompare(b.worker_name);

/**
 * Section 3's rule: a worker's capability becomes a catalog entry when its
 * desired state is `active`, no automatic stop latch is open and a capability
 * is recorded -- under the ceiling it has now, so a tag or v22 role a narrowed
 * ceiling no longer allows is dropped. `engineering-runner` is added from its
 * constant. Any input that could not be read makes the whole catalog absent
 * (null), never a shorter list: no one is assigned (fail closed).
 */
export function deriveAmuxWorkerCatalog(input: {
  registrations: readonly AmuxWorkerRegistration[] | null;
  capabilities: ReadonlyMap<string, { capability: AmuxWorkerCapability }> | null;
  latches: ReadonlyMap<string, AmuxWorkerLatchEventKind> | null;
  /** TOMVERSE_AMUX_V22_MULTI_PROVIDER: without it only Claude profiles run v22. */
  multiProvider?: boolean;
}): AmuxDerivedCatalog | null {
  if (input.registrations === null || input.capabilities === null || input.latches === null) return null;
  const legacy: AmuxDerivedCatalogEntry[] = [];
  const v22: AmuxDerivedV22CatalogEntry[] = [];
  for (const registration of input.registrations) {
    if (registration.desiredState !== "active") continue;
    if (amuxWorkerLatchOpen(input.latches.get(registration.workerName) ?? null)) continue;
    const recorded = input.capabilities.get(registration.workerName);
    if (recorded === undefined) continue;
    const capability = amuxWorkerCapabilityWithinCeiling(registration, recorded.capability);
    if (capability === null) continue;
    const entry: AmuxDerivedCatalogEntry = {
      worker_name: registration.workerName,
      provider: registration.providerClass,
      model: capability.model,
      routing_roles: sortedUnique(capability.routingTags),
      tool_capabilities: sortedUnique(capability.toolCapabilities),
      archived: false,
      paused: false,
      isolated: false,
      blocked: false,
    };
    legacy.push(entry);
    const v22Provider = amuxV22ProviderForClass(registration.providerClass);
    if (capability.v22 !== null && v22Provider !== null &&
        (v22Provider === "anthropic" || input.multiProvider === true)) {
      v22.push({
        ...entry,
        provider: v22Provider,
        model: capability.v22.model,
        routing_roles: sortedUnique(capability.v22.roles),
        tool_capabilities: sortedUnique(capability.v22.tools),
      });
    }
  }
  const runner = AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY;
  legacy.push({
    ...runner,
    routing_roles: [...runner.routing_roles],
    tool_capabilities: [...runner.tool_capabilities],
  });
  return { legacy: legacy.sort(byName), v22: v22.sort(byName) };
}

/**
 * Orchestration policy version 45 (version 35 section 2, at selection): the
 * level a legacy card asks of a worker. Version 16's role judgement is not
 * built, so a card has no v16 role; its `requiredRoutingRole` stands in:
 * a v16 role name is that level, `review` is `contract` (the reviewed
 * card's level is unknown, so the highest), any other tag is `chore`, and
 * no tag asks nothing.
 */
export function amuxCardRoleLevel(requiredRoutingRole: string | null): AmuxWorkerRoleCeiling | null {
  if (requiredRoutingRole === null) return null;
  const tag = requiredRoutingRole.trim().toLowerCase();
  if (tag === "chore" || tag === "implementation" || tag === "contract") return tag;
  if (tag === "review") return "contract";
  return "chore";
}

/**
 * Whether a worker's ceiling lets it be a candidate for a card. A code
 * constant (`engineering-runner`) is governed by its own policy and is not
 * held to a registry ceiling; a registered worker with no known ceiling is
 * not a candidate for a card that asks a level.
 */
export function amuxWorkerCeilingAllowsCard(
  workerName: string,
  ceiling: AmuxWorkerRoleCeiling | undefined,
  requiredRoutingRole: string | null,
): boolean {
  if (amuxDerivedCatalogEntryIsConstant(workerName)) return true;
  const level = amuxCardRoleLevel(requiredRoutingRole);
  if (level === null) return true;
  if (ceiling === undefined) return false;
  return amuxWorkerRoleRank(ceiling) >= amuxWorkerRoleRank(level);
}

/** Whether a name comes from a code constant rather than the registry (version 34). */
export const amuxDerivedCatalogEntryIsConstant = (workerName: string): boolean =>
  AMUX_WORKER_CATALOG_EXEMPT.includes(workerName);
