import { amuxWorkerCapabilityWithinCeiling, type AmuxWorkerCapability } from "./workerCapabilityCore.ts";
import {
  AMUX_WORKER_CATALOG_EXEMPT,
  amuxCatalogProviderClass,
  amuxWorkerLatchOpen,
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
 * R2b ships with its code latch off (version 35 section 5); the operator's
 * activation record turns it on. While it is false the Admin page reads
 * nothing for the shadow and says so.
 */
export const AMUX_WORKER_DERIVED_CATALOG_SHADOW_LATCH = false;
export const amuxWorkerDerivedCatalogShadowOpen = (): boolean => AMUX_WORKER_DERIVED_CATALOG_SHADOW_LATCH;

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

/** Whether a name comes from a code constant rather than the registry (version 34). */
export const amuxDerivedCatalogEntryIsConstant = (workerName: string): boolean =>
  AMUX_WORKER_CATALOG_EXEMPT.includes(workerName);
