import { amuxWorkerCapabilityWithinCeiling, type AmuxWorkerCapability } from "./workerCapabilityCore.ts";
import {
  AMUX_WORKER_CATALOG_EXEMPT,
  amuxCatalogProviderClass,
  amuxWorkerLatchOpen,
  amuxWorkerRoleRank,
  type AmuxWorkerRoleCeiling,
  type AmuxWorkerLatchEventKind,
  type AmuxWorkerRegistration,
} from "./workerRegistryCore.ts";

/**
 * Orchestration policy version 35, section 3 and stage R2b: the assignment
 * catalog derived from the registry, computed beside the catalog variables
 * (shadow) so the two can be compared before any consumer switches (R2c).
 * Nothing here is read by assignment. Pure: no database, no environment.
 */

/**
 * R2b shipped with its code latch off (version 35 section 5); version 43
 * (approved 2026-10-14) is the operator's activation record and sets it true,
 * so the Admin page reads the shadow and compares -- and nothing else opens:
 * assignment still follows the catalog variables until R2c. While it is false
 * the Admin page reads nothing for the shadow and says so.
 */
export const AMUX_WORKER_DERIVED_CATALOG_SHADOW_LATCH = true;
export const amuxWorkerDerivedCatalogShadowOpen = (): boolean => AMUX_WORKER_DERIVED_CATALOG_SHADOW_LATCH;

/**
 * R2c shipped with its own code latch off (version 35 section 5); version 53
 * is the operator's activation record, written after R1's observation and
 * R2b's equality observation had both ended, and sets it true. The seven
 * consumers then read the catalog the registry derives, one statement inside
 * their own boundary. While it is false the assignment catalog is the catalog
 * variables and reading it sends no statement.
 */
export const AMUX_WORKER_DERIVED_CATALOG_ASSIGNMENT_LATCH = true;
export const amuxWorkerDerivedCatalogAssignmentOpen = (): boolean => AMUX_WORKER_DERIVED_CATALOG_ASSIGNMENT_LATCH;

/**
 * R2d shipped with its own code latch off (version 35 section 5); version 54
 * (approved 2026-10-18, after the host bridge binaries were replaced) is the
 * operator's activation record and sets it true, so the bridge session list
 * route answers the derived catalog's names (without the engineering runner).
 * While it is false the route answers that the list is off, and the bridge
 * keeps its environment allowlist as before. The latch test fails unless the
 * latch and version 54's approval record move together.
 */
export const AMUX_WORKER_SESSION_LIST_LATCH = true;
export const amuxWorkerSessionListOpen = (): boolean => AMUX_WORKER_SESSION_LIST_LATCH;

/**
 * Orchestration policy version 55, section 1 (stage S1): the bridge-scope
 * route ships with its own code latch off. While it is false the route
 * answers `bridge_scope_off`, and a bridge started with `--worker` registers
 * nothing; bridges started without it never call the route. The activation
 * record (stage S3, a new policy version) turns it on.
 */
export const AMUX_WORKER_BRIDGE_SCOPE_LATCH = false;
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

/** One v22 profile, overlaid on its legacy entry as the v22 parser does. */
export type AmuxDerivedV22CatalogEntry = Omit<AmuxDerivedCatalogEntry, "provider" | "model"> & {
  provider: "anthropic";
  model: string;
};

export type AmuxDerivedCatalog = {
  legacy: AmuxDerivedCatalogEntry[];
  v22: AmuxDerivedV22CatalogEntry[];
};

/**
 * Version 35 section 3: `engineering-runner` cannot be registered (version
 * 34), so its catalog entry is a code constant the engineering agent policy
 * owns, equal to the catalog variable's entry as read on 2026-10-13. Whether
 * it is used is decided by the engineering adapter's latch and operating mode
 * (version 25). Changing it is a change to the engineering agent policy.
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
    if (capability.v22 !== null) {
      v22.push({
        ...entry,
        provider: "anthropic",
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

// ---------------------------------------------------------------------------
// The shadow comparison (R2b's end condition)

/** A legacy catalog entry as `getConfiguredAmuxWorkerCatalog()` returns it. */
export type AmuxEnvCatalogEntry = {
  worker_name: string;
  provider: string;
  model?: string | null;
  routing_roles: readonly string[];
  tool_capabilities?: readonly string[];
  archived?: boolean;
  paused?: boolean;
  isolated?: boolean;
  blocked?: boolean;
};

/** A v22 profile as the v22 catalog variable states it. */
export type AmuxEnvV22CatalogEntry = {
  worker_name: string;
  model: string;
  routing_roles: readonly string[];
  tool_capabilities: readonly string[];
};

export const AMUX_DERIVED_CATALOG_FIELDS = ["provider", "model", "routing_roles", "tool_capabilities", "v22"] as const;
export type AmuxDerivedCatalogField = (typeof AMUX_DERIVED_CATALOG_FIELDS)[number];

export const AMUX_DERIVED_CATALOG_VERDICTS = ["equal", "env_only", "derived_only", "differs"] as const;
export type AmuxDerivedCatalogVerdict = (typeof AMUX_DERIVED_CATALOG_VERDICTS)[number];

export type AmuxDerivedCatalogRow = {
  workerName: string;
  /** The catalog variable's side: assignable, held by a hold flag, or not listed. */
  env: "assignable" | "held" | "absent";
  derived: "present" | "absent";
  verdict: AmuxDerivedCatalogVerdict;
  /** The fields that differ when both sides list the worker; empty otherwise. */
  differences: AmuxDerivedCatalogField[];
};

export type AmuxDerivedCatalogComparison =
  | { status: "derived_unreadable" | "catalog_unreadable"; rows: [] }
  | { status: "equal" | "different"; rows: AmuxDerivedCatalogRow[] };

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = sortedUnique(a);
  const y = sortedUnique(b);
  return x.length === y.length && x.every((value, index) => value === y[index]);
};
const envModel = (model: string | null | undefined) => model?.trim() || null;
const envTags = (tags: readonly string[]) => tags.map((tag) => tag.trim().toLowerCase());

/**
 * Whether the derived catalog would assign what the catalog variables assign
 * today. A worker agrees when neither side would assign it (absent or held),
 * or when both list it with the same provider class, model, routing tags and
 * tools (lists compared as sets) and the same v22 profile or none. The hold
 * flags are not compared as fields: the registry's desired state and latch
 * stand for them (version 35 section 2).
 *
 * `legacy` and `v22` are null when the variable could not be read; v22 is []
 * when it is absent. `derived` is null when the registry side could not be
 * read. Either side unreadable is reported as such, never as a difference.
 */
export function compareAmuxDerivedCatalogWithEnv(input: {
  derived: AmuxDerivedCatalog | null;
  legacy: readonly AmuxEnvCatalogEntry[] | null;
  v22: readonly AmuxEnvV22CatalogEntry[] | null;
}): AmuxDerivedCatalogComparison {
  if (input.derived === null) return { status: "derived_unreadable", rows: [] };
  if (input.legacy === null || input.v22 === null) return { status: "catalog_unreadable", rows: [] };
  const derived = new Map(input.derived.legacy.map((entry) => [entry.worker_name, entry]));
  const derivedV22 = new Map(input.derived.v22.map((entry) => [entry.worker_name, entry]));
  const env = new Map(input.legacy.map((entry) => [entry.worker_name, entry]));
  const envV22 = new Map(input.v22.map((entry) => [entry.worker_name, entry]));
  const names = [...new Set([...derived.keys(), ...env.keys()])].sort();
  const rows = names.map((workerName): AmuxDerivedCatalogRow => {
    const ours = derived.get(workerName) ?? null;
    const theirs = env.get(workerName) ?? null;
    const envState = theirs === null ? "absent" :
      theirs.archived || theirs.paused || theirs.isolated || theirs.blocked ? "held" : "assignable";
    const derivedState = ours === null ? "absent" : "present";
    const row = (verdict: AmuxDerivedCatalogVerdict, differences: AmuxDerivedCatalogField[] = []): AmuxDerivedCatalogRow =>
      ({ workerName, env: envState, derived: derivedState, verdict, differences });
    if (ours === null) return row(envState === "assignable" ? "env_only" : "equal");
    if (theirs === null || envState !== "assignable") return row("derived_only");
    const differences: AmuxDerivedCatalogField[] = [];
    const theirClass = amuxCatalogProviderClass(theirs.provider.trim().toLowerCase());
    if (theirClass === null || theirClass !== amuxCatalogProviderClass(ours.provider)) differences.push("provider");
    if (envModel(theirs.model) !== ours.model) differences.push("model");
    if (!sameSet(envTags(theirs.routing_roles), ours.routing_roles)) differences.push("routing_roles");
    if (!sameSet(theirs.tool_capabilities ?? [], ours.tool_capabilities)) differences.push("tool_capabilities");
    const ourProfile = derivedV22.get(workerName) ?? null;
    const theirProfile = envV22.get(workerName) ?? null;
    const sameProfile = ourProfile === null || theirProfile === null
      ? ourProfile === theirProfile
      : ourProfile.model === theirProfile.model &&
        sameSet(ourProfile.routing_roles, theirProfile.routing_roles) &&
        sameSet(ourProfile.tool_capabilities, theirProfile.tool_capabilities);
    if (!sameProfile) differences.push("v22");
    return row(differences.length === 0 ? "equal" : "differs", differences);
  });
  return { status: rows.every((row) => row.verdict === "equal") ? "equal" : "different", rows };
}

/** What the Admin page shows: nothing read while the latch is off. */
export type AmuxDerivedCatalogShadowView =
  | { shadow: "off" }
  | { shadow: "on"; comparison: AmuxDerivedCatalogComparison };

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
