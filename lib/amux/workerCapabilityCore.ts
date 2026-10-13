/**
 * AMUX worker capabilities, orchestration policy version 35 (R2 design),
 * stage R2a: what each registered worker can do -- its model, routing tags,
 * tools and optional v22 one-shot profile -- and the rule that ties those to
 * the worker's role ceiling.
 *
 * Pure. The assignment path only checks that a card's `requiredRoutingRole`
 * is among a worker's tags, so a tag is an authority. Version 35's table maps
 * each tag and each v22 role to what it needs, and the rule is applied in
 * three places: when a capability is written (`amuxWorkerCapabilityRefusal`),
 * when the catalog is derived (`amuxWorkerCapabilityWithinCeiling`, because a
 * ceiling may have been narrowed since), and at selection (R2c).
 *
 * Migration 20261013100000_amux_worker_capability holds the same closed lists;
 * tests/amuxWorkerCapabilityCore.test.mjs reads it and fails when they drift.
 * Nothing here assigns anything until R2c.
 */

import {
  amuxV22OneShotRoleSupported,
  amuxV22OneShotRouteSupported,
  amuxV22RequiredTool,
} from "./v22WorkerClaimCore.ts";
import {
  AMUX_WORKER_CATALOG_EXEMPT,
  AMUX_WORKER_PROVIDER_CLASS_TABLE,
  amuxWorkerRoleRank,
  type AmuxWorkerRegistration,
  type AmuxWorkerRoleCeiling,
} from "./workerRegistryCore.ts";

/** What a tag or v22 role needs of the worker: any ceiling, a minimum ceiling, or a verified class. */
export type AmuxWorkerCapabilityRequirement = "any" | "implementation" | "contract" | "verified";

/**
 * Version 35's closed routing-tag list and what each needs. Adding a tag is a
 * reviewed code change (and a migration, since the CHECK holds the list).
 */
export const AMUX_WORKER_ROUTING_TAG_REQUIREMENTS: Readonly<Record<string, AmuxWorkerCapabilityRequirement>> =
  Object.freeze({
    chore: "any",
    bugfix: "any",
    tests: "any",
    multi_file: "any",
    reasoning: "any",
    integration: "any",
    long_running: "any",
    fallback: "any",
    implementation: "implementation",
    contract: "contract",
    architecture: "contract",
    security: "contract",
    review: "verified",
  });
export const AMUX_WORKER_ROUTING_TAGS = Object.freeze(Object.keys(AMUX_WORKER_ROUTING_TAG_REQUIREMENTS).sort());

/** Version 35's v22 one-shot roles: investigate is read-only and needs no ceiling. */
export const AMUX_WORKER_V22_ROLE_REQUIREMENTS: Readonly<Record<string, AmuxWorkerCapabilityRequirement>> =
  Object.freeze({
    investigate: "any",
    implement: "implementation",
    design: "contract",
    review: "verified",
  });
export const AMUX_WORKER_V22_ROLES = Object.freeze(Object.keys(AMUX_WORKER_V22_ROLE_REQUIREMENTS).sort());
export const AMUX_WORKER_V22_TOOLS = Object.freeze(["repo_read", "repo_write"] as const);

export const AMUX_WORKER_CAPABILITY_LIMITS = Object.freeze({
  modelMaxLength: 160,
  tagsMax: 64,
  toolsMax: 16,
  toolMaxLength: 64,
  v22RolesMax: 4,
});

/** Section 3 of version 35: owner-written, audited in the same transaction. */
export const AMUX_WORKER_CAPABILITY_AUDIT_ACTION = "amux.worker.capability" as const;
export const AMUX_WORKER_CAPABILITY_AUDIT_TARGET_TYPE = "AmuxWorkerCapabilityEvent" as const;

/**
 * R2a shipped with its code latch off (version 31 section 8, version 35 section
 * 5); version 36 (approved 2026-10-13) is the operator's activation record and
 * sets it true, so the owner may record capabilities -- and nothing else opens:
 * assignment still follows the catalog variables until R2c. While it is false
 * the route refuses every write. Reading is never latched.
 */
export const AMUX_WORKER_CAPABILITY_WRITES_LATCH = true;
export const amuxWorkerCapabilityWritesOpen = (): boolean => AMUX_WORKER_CAPABILITY_WRITES_LATCH;

export type AmuxWorkerV22Profile = {
  model: string;
  roles: string[];
  tools: string[];
};

export type AmuxWorkerCapability = {
  model: string | null;
  routingTags: string[];
  toolCapabilities: string[];
  v22: AmuxWorkerV22Profile | null;
};

export const AMUX_WORKER_CAPABILITY_REFUSALS = [
  "not_registered",
  "retired",
  "model_invalid",
  "tags_empty",
  "tags_too_many",
  "tag_unknown",
  "tag_duplicate",
  "tag_above_ceiling",
  "tag_requires_verified",
  "tools_invalid",
  "v22_not_claude",
  "v22_model_unsupported",
  "v22_roles_invalid",
  "v22_role_unknown",
  "v22_role_above_ceiling",
  "v22_role_requires_verified",
  "v22_tools_invalid",
  "v22_tool_missing",
] as const;
export type AmuxWorkerCapabilityRefusal = (typeof AMUX_WORKER_CAPABILITY_REFUSALS)[number];

const uniqueSorted = (values: readonly string[]) => [...new Set(values)].sort();

/** Whether a worker with this registration meets a requirement. */
export function amuxWorkerMeetsRequirement(
  registration: Pick<AmuxWorkerRegistration, "providerClass" | "roleCeiling">,
  requirement: AmuxWorkerCapabilityRequirement,
): boolean {
  if (requirement === "any") return true;
  if (requirement === "verified") return AMUX_WORKER_PROVIDER_CLASS_TABLE[registration.providerClass].verified;
  return amuxWorkerRoleRank(registration.roleCeiling) >= amuxWorkerRoleRank(requirement as AmuxWorkerRoleCeiling);
}

const requirementRefusal = (
  requirement: AmuxWorkerCapabilityRequirement,
  above: AmuxWorkerCapabilityRefusal,
  verified: AmuxWorkerCapabilityRefusal,
) => (requirement === "verified" ? verified : above);

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Why this capability cannot be recorded for this worker, or null. Checked
 * against the worker's newest registry event. The migration's guard refuses
 * the same cases.
 */
export function amuxWorkerCapabilityRefusal(
  registration: AmuxWorkerRegistration | null,
  capability: AmuxWorkerCapability,
): AmuxWorkerCapabilityRefusal | null {
  if (registration === null) return "not_registered";
  if (registration.desiredState === "retired") return "retired";
  const { model, routingTags, toolCapabilities, v22 } = capability;
  if (model !== null && (!isString(model) || model.length < 1 || model.length > AMUX_WORKER_CAPABILITY_LIMITS.modelMaxLength)) {
    return "model_invalid";
  }
  if (routingTags.length === 0) return "tags_empty";
  if (routingTags.length > AMUX_WORKER_CAPABILITY_LIMITS.tagsMax) return "tags_too_many";
  if (new Set(routingTags).size !== routingTags.length) return "tag_duplicate";
  for (const tag of routingTags) {
    const requirement = AMUX_WORKER_ROUTING_TAG_REQUIREMENTS[tag];
    if (!Object.hasOwn(AMUX_WORKER_ROUTING_TAG_REQUIREMENTS, tag) || requirement === undefined) return "tag_unknown";
    if (!amuxWorkerMeetsRequirement(registration, requirement)) {
      return requirementRefusal(requirement, "tag_above_ceiling", "tag_requires_verified");
    }
  }
  if (toolCapabilities.length > AMUX_WORKER_CAPABILITY_LIMITS.toolsMax ||
      new Set(toolCapabilities).size !== toolCapabilities.length ||
      toolCapabilities.some((tool) => !isString(tool) || tool.length < 1 || tool.length > AMUX_WORKER_CAPABILITY_LIMITS.toolMaxLength)) {
    return "tools_invalid";
  }
  if (v22 !== null) {
    if (registration.providerClass !== "claude") return "v22_not_claude";
    if (!amuxV22OneShotRouteSupported("anthropic", v22.model)) return "v22_model_unsupported";
    if (v22.roles.length < 1 || v22.roles.length > AMUX_WORKER_CAPABILITY_LIMITS.v22RolesMax ||
        new Set(v22.roles).size !== v22.roles.length) {
      return "v22_roles_invalid";
    }
    if (v22.tools.length < 1 || v22.tools.length > AMUX_WORKER_V22_TOOLS.length ||
        new Set(v22.tools).size !== v22.tools.length ||
        v22.tools.some((tool) => !(AMUX_WORKER_V22_TOOLS as readonly string[]).includes(tool))) {
      return "v22_tools_invalid";
    }
    for (const role of v22.roles) {
      const requirement = AMUX_WORKER_V22_ROLE_REQUIREMENTS[role];
      if (!Object.hasOwn(AMUX_WORKER_V22_ROLE_REQUIREMENTS, role) || requirement === undefined ||
          !amuxV22OneShotRoleSupported(role)) {
        return "v22_role_unknown";
      }
      if (!amuxWorkerMeetsRequirement(registration, requirement)) {
        return requirementRefusal(requirement, "v22_role_above_ceiling", "v22_role_requires_verified");
      }
      if (!v22.tools.includes(amuxV22RequiredTool(role) ?? "")) return "v22_tool_missing";
    }
  }
  return null;
}

/**
 * The capability as the catalog may use it under the worker's ceiling now:
 * tags and v22 roles the ceiling no longer allows are dropped (version 35
 * section 2: the ceiling may be narrowed after the capability was written).
 * Null when nothing assignable is left.
 */
export function amuxWorkerCapabilityWithinCeiling(
  registration: AmuxWorkerRegistration,
  capability: AmuxWorkerCapability,
): AmuxWorkerCapability | null {
  const allowed = (requirement: AmuxWorkerCapabilityRequirement | undefined) =>
    requirement !== undefined && amuxWorkerMeetsRequirement(registration, requirement);
  const routingTags = capability.routingTags.filter((tag) =>
    Object.hasOwn(AMUX_WORKER_ROUTING_TAG_REQUIREMENTS, tag) && allowed(AMUX_WORKER_ROUTING_TAG_REQUIREMENTS[tag]));
  if (routingTags.length === 0) return null;
  let v22 = capability.v22;
  if (v22 !== null) {
    const roles = v22.roles.filter((role) =>
      Object.hasOwn(AMUX_WORKER_V22_ROLE_REQUIREMENTS, role) && allowed(AMUX_WORKER_V22_ROLE_REQUIREMENTS[role]));
    v22 = roles.length > 0 && registration.providerClass === "claude" ? { ...v22, roles } : null;
  }
  return { ...capability, routingTags, v22 };
}

// ---------------------------------------------------------------------------
// Import from the catalog variables (version 35 section 2)

export type AmuxCatalogCapabilityEntry = {
  worker_name: string;
  provider: string;
  model?: string | null;
  routing_roles: readonly string[];
  tool_capabilities?: readonly string[];
};

export type AmuxV22CatalogCapabilityEntry = {
  worker_name: string;
  provider: string;
  model: string;
  routing_roles: readonly string[];
  tool_capabilities: readonly string[];
};

export type AmuxWorkerCapabilityImportRow = {
  workerName: string;
  /** The capability the catalog variables describe, or null when none does. */
  proposed: AmuxWorkerCapability | null;
  refusal: AmuxWorkerCapabilityRefusal | null;
};

/**
 * What the one-time import would write: one proposal per registered,
 * non-retired worker the legacy catalog lists, with its v22 profile when the
 * v22 catalog has one, and the refusal the write would meet. Exempt names
 * (version 34) and names the registry does not hold are not imported. The
 * catalogs' hold flags are not capabilities and are not carried.
 */
export function amuxWorkerCapabilityImport(
  registrations: readonly AmuxWorkerRegistration[],
  legacy: readonly AmuxCatalogCapabilityEntry[],
  v22: readonly AmuxV22CatalogCapabilityEntry[] | null,
): AmuxWorkerCapabilityImportRow[] {
  const registered = new Map(registrations.map((row) => [row.workerName, row]));
  const v22ByName = new Map((v22 ?? []).map((row) => [row.worker_name, row]));
  const rows: AmuxWorkerCapabilityImportRow[] = [];
  for (const entry of [...legacy].sort((a, b) => a.worker_name.localeCompare(b.worker_name))) {
    if (AMUX_WORKER_CATALOG_EXEMPT.includes(entry.worker_name)) continue;
    const registration = registered.get(entry.worker_name);
    if (!registration || registration.desiredState === "retired") continue;
    const profile = v22ByName.get(entry.worker_name) ?? null;
    const proposed: AmuxWorkerCapability = {
      model: entry.model?.trim() || null,
      routingTags: uniqueSorted(entry.routing_roles.map((tag) => tag.trim().toLowerCase())),
      toolCapabilities: uniqueSorted(entry.tool_capabilities ?? []),
      v22: profile === null ? null : {
        model: profile.model,
        roles: uniqueSorted(profile.routing_roles),
        tools: uniqueSorted(profile.tool_capabilities),
      },
    };
    rows.push({ workerName: entry.worker_name, proposed, refusal: amuxWorkerCapabilityRefusal(registration, proposed) });
  }
  return rows;
}

/** Two capabilities are the same when every field is (lists compared as sets). */
export function amuxWorkerCapabilitiesEqual(a: AmuxWorkerCapability | null, b: AmuxWorkerCapability | null): boolean {
  if (a === null || b === null) return a === b;
  const sameList = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && uniqueSorted(x).every((value, index) => value === uniqueSorted(y)[index]);
  if (a.model !== b.model || !sameList(a.routingTags, b.routingTags) || !sameList(a.toolCapabilities, b.toolCapabilities)) {
    return false;
  }
  if (a.v22 === null || b.v22 === null) return a.v22 === b.v22;
  return a.v22.model === b.v22.model && sameList(a.v22.roles, b.v22.roles) && sameList(a.v22.tools, b.v22.tools);
}

// ---------------------------------------------------------------------------
// The Admin view (R2a)

export type AmuxWorkerCapabilityAdminRow = {
  workerName: string;
  desiredState: AmuxWorkerRegistration["desiredState"];
  roleCeiling: AmuxWorkerRoleCeiling;
  /** The newest recorded capability, or null when none is. */
  current: { revision: number; capability: AmuxWorkerCapability; changedAt: string } | null;
  /** What the catalog variables describe for this worker, or null when they describe nothing. */
  proposed: AmuxWorkerCapability | null;
  /** The refusal the proposal would meet, or null. */
  refusal: AmuxWorkerCapabilityRefusal | null;
  /** Whether the proposal is already what is recorded. */
  same: boolean;
};

export type AmuxWorkerCapabilityAdminView = {
  writesLatch: boolean;
  /**
   * False when either catalog variable could not be read: nothing is
   * proposed. A v22 variable that is set but does not parse is unreadable,
   * never an empty list -- importing over it would erase recorded profiles.
   */
  catalogReadable: boolean;
  rows: AmuxWorkerCapabilityAdminRow[];
};

/**
 * The v22 profiles the import reads: [] only when the variable is absent.
 * Any value that is present -- blank or whitespace included -- goes to the
 * parser, so a value it cannot read is null and blocks the import instead of
 * being proposed as "no profiles" over what is recorded.
 */
export function amuxWorkerCapabilityV22Catalog<T>(
  raw: string | undefined,
  parse: (raw: string) => readonly T[] | null,
): readonly T[] | null {
  return raw === undefined ? [] : parse(raw);
}

/** One row per registered, non-retired worker, in name order. */
export function buildAmuxWorkerCapabilityAdminView(input: {
  registrations: readonly AmuxWorkerRegistration[];
  current: ReadonlyMap<string, { revision: number; capability: AmuxWorkerCapability; changedAt: string }>;
  legacy: readonly AmuxCatalogCapabilityEntry[] | null;
  /** The v22 profiles; [] when the variable is unset, null when it is set and unreadable. */
  v22: readonly AmuxV22CatalogCapabilityEntry[] | null;
  writesLatch?: boolean;
}): AmuxWorkerCapabilityAdminView {
  const catalogReadable = input.legacy !== null && input.v22 !== null;
  const imports = catalogReadable ? amuxWorkerCapabilityImport(input.registrations, input.legacy!, input.v22) : [];
  const proposals = new Map(imports.map((row) => [row.workerName, row]));
  const rows = [...input.registrations]
    .filter((registration) => registration.desiredState !== "retired")
    .sort((a, b) => a.workerName.localeCompare(b.workerName))
    .map((registration): AmuxWorkerCapabilityAdminRow => {
      const current = input.current.get(registration.workerName) ?? null;
      const proposal = proposals.get(registration.workerName) ?? null;
      return {
        workerName: registration.workerName,
        desiredState: registration.desiredState,
        roleCeiling: registration.roleCeiling,
        current,
        proposed: proposal?.proposed ?? null,
        refusal: proposal?.refusal ?? null,
        same: proposal !== null && current !== null && amuxWorkerCapabilitiesEqual(current.capability, proposal.proposed),
      };
    });
  return { writesLatch: input.writesLatch ?? amuxWorkerCapabilityWritesOpen(), catalogReadable, rows };
}

/** The proposals an owner may import now: readable, not refused, not already recorded. */
export const amuxWorkerCapabilityImportsToWrite = (view: Pick<AmuxWorkerCapabilityAdminView, "rows">) =>
  view.rows
    .filter((row) => row.proposed !== null && row.refusal === null && !row.same)
    .map((row) => ({ workerName: row.workerName, expectedRevision: row.current?.revision ?? 0, capability: row.proposed! }));

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string");

const parseCapability = (value: unknown): AmuxWorkerCapability | null => {
  if (!isPlainRecord(value)) return null;
  if (value.model !== null && typeof value.model !== "string") return null;
  if (!isStringArray(value.routingTags, AMUX_WORKER_CAPABILITY_LIMITS.tagsMax) ||
      !isStringArray(value.toolCapabilities, AMUX_WORKER_CAPABILITY_LIMITS.toolsMax)) {
    return null;
  }
  let v22: AmuxWorkerV22Profile | null = null;
  if (value.v22 !== null) {
    if (!isPlainRecord(value.v22) || typeof value.v22.model !== "string" ||
        !isStringArray(value.v22.roles, AMUX_WORKER_CAPABILITY_LIMITS.v22RolesMax) ||
        !isStringArray(value.v22.tools, AMUX_WORKER_V22_TOOLS.length)) {
      return null;
    }
    v22 = { model: value.v22.model, roles: [...value.v22.roles], tools: [...value.v22.tools] };
  }
  return { model: value.model as string | null, routingTags: [...value.routingTags], toolCapabilities: [...value.toolCapabilities], v22 };
};

const ROLE_CEILINGS: readonly string[] = ["chore", "implementation", "contract"];
const DESIRED_STATES: readonly string[] = ["requested", "active", "paused", "retired"];

/**
 * The capability route's GET body, or null when it is not exactly that shape.
 * A body that does not parse is a failed read, never a guessed capability.
 */
export function parseAmuxWorkerCapabilityAdminView(body: unknown): AmuxWorkerCapabilityAdminView | null {
  if (!isPlainRecord(body) || typeof body.writesLatch !== "boolean" || typeof body.catalogReadable !== "boolean" ||
      !Array.isArray(body.rows)) {
    return null;
  }
  const rows: AmuxWorkerCapabilityAdminRow[] = [];
  for (const row of body.rows) {
    if (!isPlainRecord(row) || typeof row.workerName !== "string" || !/^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$/.test(row.workerName)) {
      return null;
    }
    if (typeof row.desiredState !== "string" || !DESIRED_STATES.includes(row.desiredState) || row.desiredState === "retired") return null;
    if (typeof row.roleCeiling !== "string" || !ROLE_CEILINGS.includes(row.roleCeiling)) return null;
    if (typeof row.same !== "boolean") return null;
    let current: AmuxWorkerCapabilityAdminRow["current"] = null;
    if (row.current !== null) {
      if (!isPlainRecord(row.current) || typeof row.current.revision !== "number" || !Number.isSafeInteger(row.current.revision) ||
          row.current.revision < 1 || typeof row.current.changedAt !== "string" || Number.isNaN(Date.parse(row.current.changedAt))) {
        return null;
      }
      const capability = parseCapability(row.current.capability);
      if (capability === null) return null;
      current = { revision: row.current.revision, capability, changedAt: row.current.changedAt };
    }
    let proposed: AmuxWorkerCapability | null = null;
    if (row.proposed !== null) {
      proposed = parseCapability(row.proposed);
      if (proposed === null) return null;
    }
    if (row.refusal !== null && !(AMUX_WORKER_CAPABILITY_REFUSALS as readonly unknown[]).includes(row.refusal)) return null;
    if (row.refusal !== null && proposed === null) return null;
    rows.push({
      workerName: row.workerName,
      desiredState: row.desiredState as AmuxWorkerCapabilityAdminRow["desiredState"],
      roleCeiling: row.roleCeiling as AmuxWorkerRoleCeiling,
      current,
      proposed,
      refusal: row.refusal as AmuxWorkerCapabilityRefusal | null,
      same: row.same,
    });
  }
  if (!body.catalogReadable && rows.some((row) => row.proposed !== null)) return null;
  return { writesLatch: body.writesLatch, catalogReadable: body.catalogReadable, rows };
}
