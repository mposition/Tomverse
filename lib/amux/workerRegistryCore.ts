/**
 * The AMUX worker registry, orchestration policy version 31
 * (docs/policy/development-agent-orchestration.md, "버전 31"), stage R1.
 *
 * Pure: the provider class table (section 2), the worker name grammar, the
 * desired states and the change rule a registry event must satisfy (section
 * 3), the effective assignment rule (section 3: desired `active`, no open
 * automatic-stop latch, latest observation ok), and the comparison of the
 * registry with the assignment catalog environment variable that ends R1
 * (section 8). No I/O.
 *
 * Every vocabulary here is compared with its CHECK by `npm run
 * check:enum-constraints`, and the change rule is the one the guard trigger of
 * migration 20261012100000_amux_worker_registry holds;
 * tests/amuxWorkerRegistryCore.test.mjs reads that migration and fails when
 * the two drift.
 *
 * Nothing here decides an assignment today. Until R2 the assignment catalog is
 * still `TOMVERSE_AMUX_WORKER_CATALOG_JSON`; the registry is recorded and
 * compared with it, never read in its place.
 */

/** Section 2's provider classes. A new class is a policy version. */
export const AMUX_WORKER_PROVIDER_CLASSES = ["claude", "codex", "cursor", "copilot"] as const;
export type AmuxWorkerProviderClass = (typeof AMUX_WORKER_PROVIDER_CLASSES)[number];

/** Version 16's routing roles, lowest first: `chore < implementation < contract`. */
export const AMUX_WORKER_ROLE_CEILINGS = ["chore", "implementation", "contract"] as const;
export type AmuxWorkerRoleCeiling = (typeof AMUX_WORKER_ROLE_CEILINGS)[number];

export type AmuxWorkerProviderClassDefinition = {
  cli: string;
  /**
   * Version 16's verified provider: only a verified class takes cross review,
   * version 22's author/reviewer pair and the Decision Maker.
   * `AMUX_VERIFIED_PROVIDERS` is unchanged by this table.
   */
  verified: boolean;
  /** The highest role a worker of this class may hold. */
  maxRole: AmuxWorkerRoleCeiling;
};

/**
 * Section 2's class table, as approved on 2026-10-12. Raising a ceiling,
 * marking a class verified, or adding a class is a new policy version; the
 * migration's CHECK pins the unverified ceilings to the same values.
 */
export const AMUX_WORKER_PROVIDER_CLASS_TABLE: Readonly<
  Record<AmuxWorkerProviderClass, Readonly<AmuxWorkerProviderClassDefinition>>
> = Object.freeze({
  claude: Object.freeze({ cli: "Claude Code", verified: true, maxRole: "contract" }),
  codex: Object.freeze({ cli: "Codex CLI", verified: true, maxRole: "contract" }),
  cursor: Object.freeze({ cli: "Cursor CLI", verified: false, maxRole: "implementation" }),
  copilot: Object.freeze({ cli: "GitHub Copilot CLI", verified: false, maxRole: "implementation" }),
});

/** Section 3: the class is the name's prefix; the rest is 1-24 of [a-z0-9]. */
export const AMUX_WORKER_NAME_PATTERN = /^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$/;

/**
 * How the assignment catalog names a worker: `AMUX_MACHINE_ID_PATTERN` in
 * lib/amux/claimContract.ts, copied so this module stays free of imports
 * (tests/amuxWorkerRegistryCore.test.mjs pins the two equal). A catalog name
 * outside the registry's grammar is legal there and appears in the comparison
 * as `unregistered`.
 */
export const AMUX_CATALOG_WORKER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,118}[A-Za-z0-9])?$/;

/** Section 3's desired states, set by a person only. */
export const AMUX_WORKER_DESIRED_STATES = ["requested", "active", "paused", "retired"] as const;
export type AmuxWorkerDesiredState = (typeof AMUX_WORKER_DESIRED_STATES)[number];

/**
 * The seven workers already in the assignment catalog, activated under
 * versions 23 and 27 before the registry existed. Section 8's R1 registers
 * them `active`; they are the only names whose first event may be `active`.
 * Any other worker reaches `active` only through section 5's trial evidence,
 * host safety observation and owner activation, which is R5 and does not exist
 * yet. The migration's guard holds the same seven.
 */
export const AMUX_WORKER_REGISTRY_BOOTSTRAP_ACTIVE = Object.freeze([
  "claude-chore",
  "claude-contract",
  "claude-impl",
  "claude-review",
  "codex-chore",
  "codex-contract",
  "codex-impl",
] as const);

export type AmuxWorkerSeedEntry = Readonly<{
  workerName: string;
  roleCeiling: AmuxWorkerRoleCeiling;
  desiredState: "requested" | "active";
}>;

/**
 * Section 8's R1 registration: the thirteen workers of version 27, section 1.
 * The catalog's seven are `active` at the role their session already has
 * (`claude-review` reviews contract cards, so its ceiling is `contract`); the
 * six Cursor and Copilot sessions are `requested`, at version 27's ceilings
 * (`-chore` up to `chore`, `-impl` and `-worker` up to `implementation`).
 */
export const AMUX_WORKER_REGISTRY_V31_SEED: readonly AmuxWorkerSeedEntry[] = Object.freeze([
  { workerName: "claude-chore", roleCeiling: "chore", desiredState: "active" },
  { workerName: "claude-contract", roleCeiling: "contract", desiredState: "active" },
  { workerName: "claude-impl", roleCeiling: "implementation", desiredState: "active" },
  { workerName: "claude-review", roleCeiling: "contract", desiredState: "active" },
  { workerName: "codex-chore", roleCeiling: "chore", desiredState: "active" },
  { workerName: "codex-contract", roleCeiling: "contract", desiredState: "active" },
  { workerName: "codex-impl", roleCeiling: "implementation", desiredState: "active" },
  { workerName: "cursor-chore", roleCeiling: "chore", desiredState: "requested" },
  { workerName: "cursor-impl", roleCeiling: "implementation", desiredState: "requested" },
  { workerName: "cursor-worker", roleCeiling: "implementation", desiredState: "requested" },
  { workerName: "copilot-chore", roleCeiling: "chore", desiredState: "requested" },
  { workerName: "copilot-impl", roleCeiling: "implementation", desiredState: "requested" },
  { workerName: "copilot-worker", roleCeiling: "implementation", desiredState: "requested" },
].map((entry) => Object.freeze(entry as AmuxWorkerSeedEntry)));

/** Section 3: the human audit actions, `amux.worker.*`. */
export const AMUX_WORKER_REGISTRY_AUDIT_ACTIONS = Object.freeze({
  register: "amux.worker.register",
  change: "amux.worker.change",
} as const);

export const AMUX_WORKER_REGISTRY_AUDIT_TARGET_TYPE = "AmuxWorkerRegistryEvent" as const;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export const isAmuxWorkerProviderClass = (value: unknown): value is AmuxWorkerProviderClass =>
  isOneOf(AMUX_WORKER_PROVIDER_CLASSES, value);
export const isAmuxWorkerRoleCeiling = (value: unknown): value is AmuxWorkerRoleCeiling =>
  isOneOf(AMUX_WORKER_ROLE_CEILINGS, value);
export const isAmuxWorkerDesiredState = (value: unknown): value is AmuxWorkerDesiredState =>
  isOneOf(AMUX_WORKER_DESIRED_STATES, value);

export const isAmuxWorkerName = (value: unknown): value is string =>
  typeof value === "string" && AMUX_WORKER_NAME_PATTERN.test(value);

/** The class a valid name belongs to, or null. */
export const amuxWorkerProviderClassOf = (workerName: unknown): AmuxWorkerProviderClass | null => {
  if (!isAmuxWorkerName(workerName)) return null;
  const prefix = workerName.slice(0, workerName.indexOf("-"));
  return isAmuxWorkerProviderClass(prefix) ? prefix : null;
};

export const amuxWorkerRoleRank = (role: AmuxWorkerRoleCeiling): number =>
  AMUX_WORKER_ROLE_CEILINGS.indexOf(role);

export const amuxWorkerRoleWithinClass = (
  providerClass: AmuxWorkerProviderClass,
  role: AmuxWorkerRoleCeiling,
): boolean =>
  amuxWorkerRoleRank(role) <= amuxWorkerRoleRank(AMUX_WORKER_PROVIDER_CLASS_TABLE[providerClass].maxRole);

/** The newest registry event of one worker, as the store reads it. */
export type AmuxWorkerRegistration = {
  workerName: string;
  providerClass: AmuxWorkerProviderClass;
  roleCeiling: AmuxWorkerRoleCeiling;
  desiredState: AmuxWorkerDesiredState;
  revision: number;
};

export type AmuxWorkerRegistryChange = {
  workerName: string;
  providerClass: AmuxWorkerProviderClass;
  roleCeiling: AmuxWorkerRoleCeiling;
  desiredState: AmuxWorkerDesiredState;
  /** The revision the person saw: 0 for a new worker. */
  expectedRevision: number;
};

/** A person's change, from untrusted input, or null. The class is the name's. */
export function parseAmuxWorkerRegistryChange(input: {
  workerName: unknown;
  roleCeiling: unknown;
  desiredState: unknown;
  expectedRevision: unknown;
}): AmuxWorkerRegistryChange | null {
  const providerClass = amuxWorkerProviderClassOf(input.workerName);
  if (providerClass === null) return null;
  if (!isAmuxWorkerRoleCeiling(input.roleCeiling)) return null;
  if (!isAmuxWorkerDesiredState(input.desiredState)) return null;
  const expectedRevision = input.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0) {
    return null;
  }
  return {
    workerName: input.workerName as string,
    providerClass,
    roleCeiling: input.roleCeiling,
    desiredState: input.desiredState,
    expectedRevision,
  };
}

export const AMUX_WORKER_REGISTRY_REFUSALS = [
  "role_above_class",
  "stale_revision",
  "first_state_invalid",
  "activation_requires_trial",
  "retired",
  "role_widening_requires_trial",
  "no_change",
] as const;
export type AmuxWorkerRegistryRefusal = (typeof AMUX_WORKER_REGISTRY_REFUSALS)[number];

/**
 * Why a change cannot be recorded over the worker's newest event, or null.
 * The guard trigger refuses the same cases, except `no_change`, which only
 * spares the audit log a record of nothing.
 *
 * - The role ceiling never exceeds the class's (section 2).
 * - The person must have seen the newest revision (compare-and-set).
 * - A worker starts `requested`, or `active` only if it is one of the seven
 *   already in the catalog (R1).
 * - `retired` is final; the name is not reused (section 3).
 * - No later event makes a worker `active` that was not: that is section 5's
 *   activation, R5.
 * - A wider role is a new trial: allowed only while the worker is `requested`.
 *   Narrowing is never refused (section 2: narrowing has no gate).
 */
export function amuxWorkerRegistryChangeRefusal(
  previous: AmuxWorkerRegistration | null,
  change: AmuxWorkerRegistryChange,
): AmuxWorkerRegistryRefusal | null {
  if (!amuxWorkerRoleWithinClass(change.providerClass, change.roleCeiling)) return "role_above_class";
  if (change.expectedRevision !== (previous?.revision ?? 0)) return "stale_revision";
  if (previous === null) {
    if (change.desiredState === "requested") return null;
    if (change.desiredState === "active" &&
        (AMUX_WORKER_REGISTRY_BOOTSTRAP_ACTIVE as readonly string[]).includes(change.workerName)) {
      return null;
    }
    return change.desiredState === "active" ? "activation_requires_trial" : "first_state_invalid";
  }
  if (previous.desiredState === "retired") return "retired";
  if (change.desiredState === "active" && previous.desiredState !== "active") {
    return "activation_requires_trial";
  }
  if (amuxWorkerRoleRank(change.roleCeiling) > amuxWorkerRoleRank(previous.roleCeiling) &&
      change.desiredState !== "requested") {
    return "role_widening_requires_trial";
  }
  if (change.desiredState === previous.desiredState && change.roleCeiling === previous.roleCeiling) {
    return "no_change";
  }
  return null;
}

/** The audit action of a change: the first event registers, any later one changes. */
export const amuxWorkerRegistryAuditAction = (previous: AmuxWorkerRegistration | null) =>
  previous === null ? AMUX_WORKER_REGISTRY_AUDIT_ACTIONS.register : AMUX_WORKER_REGISTRY_AUDIT_ACTIONS.change;

/**
 * The audit entry's metadata: what changed, no free text. The store adds the
 * event id.
 */
export function amuxWorkerRegistryAuditMetadata(
  previous: AmuxWorkerRegistration | null,
  change: AmuxWorkerRegistryChange,
  eventId: string,
): Record<string, string | number | null> {
  return {
    event_id: eventId,
    worker_name: change.workerName,
    provider_class: change.providerClass,
    role_ceiling: change.roleCeiling,
    desired_state: change.desiredState,
    revision: change.expectedRevision + 1,
    previous_role_ceiling: previous?.roleCeiling ?? null,
    previous_desired_state: previous?.desiredState ?? null,
  };
}

/** The newest event of each worker, from untrusted rows; a bad row is null. */
export function amuxWorkerRegistrationFromRow(row: {
  workerName: unknown;
  providerClass: unknown;
  roleCeiling: unknown;
  desiredState: unknown;
  revision: unknown;
}): AmuxWorkerRegistration | null {
  const providerClass = amuxWorkerProviderClassOf(row.workerName);
  if (providerClass === null || row.providerClass !== providerClass) return null;
  if (!isAmuxWorkerRoleCeiling(row.roleCeiling) || !isAmuxWorkerDesiredState(row.desiredState)) {
    return null;
  }
  const revision = typeof row.revision === "bigint" ? Number(row.revision) : row.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
  if (!amuxWorkerRoleWithinClass(providerClass, row.roleCeiling)) return null;
  return {
    workerName: row.workerName as string,
    providerClass,
    roleCeiling: row.roleCeiling,
    desiredState: row.desiredState,
    revision,
  };
}

// ---------------------------------------------------------------------------
// Effective assignment (section 3)

/** Section 4's observation kinds. Only `ok` counts toward assignment. */
export const AMUX_WORKER_OBSERVATION_STATUSES = ["ok", "not_ready", "stopped", "halted", "drift"] as const;
export type AmuxWorkerObservationStatus = (typeof AMUX_WORKER_OBSERVATION_STATUSES)[number];

/** Section 7: the system opens a latch, the owner releases it. */
export const AMUX_WORKER_LATCH_EVENT_KINDS = ["opened", "released"] as const;
export type AmuxWorkerLatchEventKind = (typeof AMUX_WORKER_LATCH_EVENT_KINDS)[number];

/** The system opens a latch; a person releases it. */
export const AMUX_WORKER_LATCH_ACTOR_KINDS = ["system", "human"] as const;

/** Section 5(1): only `passed` passes; `failed` and `unknown` do not. */
export const AMUX_WORKER_TRIAL_OUTCOMES = ["passed", "failed", "unknown"] as const;
export type AmuxWorkerTrialOutcome = (typeof AMUX_WORKER_TRIAL_OUTCOMES)[number];

export const isAmuxWorkerObservationStatus = (value: unknown): value is AmuxWorkerObservationStatus =>
  isOneOf(AMUX_WORKER_OBSERVATION_STATUSES, value);
export const isAmuxWorkerLatchEventKind = (value: unknown): value is AmuxWorkerLatchEventKind =>
  isOneOf(AMUX_WORKER_LATCH_EVENT_KINDS, value);
export const isAmuxWorkerTrialOutcome = (value: unknown): value is AmuxWorkerTrialOutcome =>
  isOneOf(AMUX_WORKER_TRIAL_OUTCOMES, value);

/** Activation gate 2: three trial cards and US$5 per worker, three failures for a latch. */
export const AMUX_WORKER_TRIAL_CARD_COUNT = 3;
export const AMUX_WORKER_TRIAL_COST_CAP_MICRO_USD = 5_000_000;
export const AMUX_WORKER_LATCH_CONSECUTIVE_FAILURES = 3;

/**
 * Section 7: the latch is open when its newest event is an opening. `null`
 * is a worker with no latch event at all. This cannot express a latch that
 * could not be read: `amuxWorkerEffectiveState()` takes that as `undefined`
 * and reports `latch_unreadable` before it ever asks this function.
 */
export const amuxWorkerLatchOpen = (newestKind: AmuxWorkerLatchEventKind | null): boolean =>
  newestKind === "opened";

export const AMUX_WORKER_UNASSIGNABLE_REASONS = [
  "not_registered",
  "not_active",
  "latch_unreadable",
  "latch_open",
  "no_observation",
  "observation_not_ok",
] as const;
export type AmuxWorkerUnassignableReason = (typeof AMUX_WORKER_UNASSIGNABLE_REASONS)[number];

export type AmuxWorkerEffectiveState = {
  assignable: boolean;
  /** Every condition that fails, in the order above; empty when assignable. */
  reasons: AmuxWorkerUnassignableReason[];
};

/**
 * Section 3: assigned only when the desired state is `active`, no automatic
 * stop latch is open, and the latest observation is ok. Every failing
 * condition is reported, so the Admin screen shows all of them at once.
 * `latch` is `undefined` when the latch could not be read: fail closed.
 */
export function amuxWorkerEffectiveState(input: {
  registration: AmuxWorkerRegistration | null;
  latchNewestKind: AmuxWorkerLatchEventKind | null | undefined;
  latestObservationStatus: AmuxWorkerObservationStatus | null;
}): AmuxWorkerEffectiveState {
  const reasons: AmuxWorkerUnassignableReason[] = [];
  if (input.registration === null) reasons.push("not_registered");
  else if (input.registration.desiredState !== "active") reasons.push("not_active");
  if (input.latchNewestKind === undefined) reasons.push("latch_unreadable");
  else if (amuxWorkerLatchOpen(input.latchNewestKind)) reasons.push("latch_open");
  if (input.latestObservationStatus === null) reasons.push("no_observation");
  else if (input.latestObservationStatus !== "ok") reasons.push("observation_not_ok");
  return { assignable: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Registry vs the assignment catalog (R1's end condition)

/**
 * The provider spellings the catalog uses for each class. The catalog is
 * lower-cased by `getConfiguredAmuxWorkerCatalog()` before it reaches here.
 */
const CATALOG_PROVIDER_CLASS: Readonly<Record<string, AmuxWorkerProviderClass>> = Object.freeze({
  claude: "claude",
  anthropic: "claude",
  codex: "codex",
  openai: "codex",
  cursor: "cursor",
  copilot: "copilot",
  "github-copilot": "copilot",
});

export const amuxCatalogProviderClass = (provider: string): AmuxWorkerProviderClass | null =>
  Object.hasOwn(CATALOG_PROVIDER_CLASS, provider) ? CATALOG_PROVIDER_CLASS[provider] : null;

export type AmuxCatalogWorker = {
  worker_name: string;
  provider: string;
  archived: boolean;
  paused: boolean;
  isolated: boolean;
  blocked: boolean;
};

export const AMUX_WORKER_CATALOG_VERDICTS = [
  "match",
  "exempt",
  "registry_only",
  "catalog_only",
  "unregistered",
  "provider_mismatch",
] as const;

/**
 * Version 34: catalog entries the comparison leaves out by name, because
 * another policy governs them. `engineering-runner` is the engineering
 * adapter's worker identity (versions 12 and 25, docs/policy/engineering-agent.md),
 * not a resident AMUX runner worker, and its name is outside the registry's
 * grammar. An exempt entry counts as agreement and is shown as such; it
 * changes nothing about the entry's assignment. Adding a name is a policy
 * version.
 */
export const AMUX_WORKER_CATALOG_EXEMPT: readonly string[] = Object.freeze(["engineering-runner"]);

const isCatalogExempt = (workerName: string): boolean => AMUX_WORKER_CATALOG_EXEMPT.includes(workerName);
export type AmuxWorkerCatalogVerdict = (typeof AMUX_WORKER_CATALOG_VERDICTS)[number];

export type AmuxWorkerCatalogRow = {
  workerName: string;
  registryState: AmuxWorkerDesiredState | null;
  catalog: "assignable" | "held" | "absent";
  verdict: AmuxWorkerCatalogVerdict;
};

export type AmuxWorkerCatalogComparison =
  | { status: "registry_unreadable" | "catalog_unreadable"; rows: [] }
  | { status: "match" | "mismatch"; rows: AmuxWorkerCatalogRow[] };

/**
 * Whether the registry and `TOMVERSE_AMUX_WORKER_CATALOG_JSON` agree on who
 * may be assigned. A worker agrees when the registry says `active` and the
 * catalog lists it assignable (present, not archived, paused, isolated or
 * blocked), or when neither does. A catalog entry with no registry event, or
 * whose provider is not the name's class, never agrees: the registry is the
 * single source (section 3) -- except a name version 34 exempts
 * (`AMUX_WORKER_CATALOG_EXEMPT`), which is `exempt` and counts as agreement.
 * Roles are not compared: the catalog's routing
 * tags and version 16's three roles are different vocabularies.
 *
 * `null` for either side is unreadable, never empty.
 */
export function compareAmuxWorkerRegistryWithCatalog(
  registry: readonly AmuxWorkerRegistration[] | null,
  catalog: readonly AmuxCatalogWorker[] | null,
): AmuxWorkerCatalogComparison {
  if (registry === null) return { status: "registry_unreadable", rows: [] };
  if (catalog === null) return { status: "catalog_unreadable", rows: [] };
  const registered = new Map(registry.map((row) => [row.workerName, row]));
  const listed = new Map(catalog.map((row) => [row.worker_name, row]));
  const names = [...new Set([...registered.keys(), ...listed.keys()])].sort();
  const rows = names.map((workerName): AmuxWorkerCatalogRow => {
    const registration = registered.get(workerName) ?? null;
    const entry = listed.get(workerName) ?? null;
    const catalogState = entry === null ? "absent" :
      entry.archived || entry.paused || entry.isolated || entry.blocked ? "held" : "assignable";
    const registryState = registration?.desiredState ?? null;
    let verdict: AmuxWorkerCatalogVerdict;
    if (entry !== null && registration === null) {
      verdict = isCatalogExempt(workerName) ? "exempt" : "unregistered";
    }
    else if (entry !== null && amuxCatalogProviderClass(entry.provider) !== amuxWorkerProviderClassOf(workerName)) {
      verdict = "provider_mismatch";
    } else if (registryState === "active") {
      verdict = catalogState === "assignable" ? "match" : "registry_only";
    } else {
      verdict = catalogState === "assignable" ? "catalog_only" : "match";
    }
    return { workerName, registryState, catalog: catalogState, verdict };
  });
  const agrees = (verdict: AmuxWorkerCatalogVerdict) => verdict === "match" || verdict === "exempt";
  return { status: rows.every((row) => agrees(row.verdict)) ? "match" : "mismatch", rows };
}

// ---------------------------------------------------------------------------
// The Admin screen (R1)

/**
 * Section 8: each stage ships with its code latch off; the operator's
 * activation record turns it on. R1 shipped it false; version 32 (approved
 * 2026-10-12) is that record and sets it true, so the owner may write the
 * registry -- and nothing else opens: assignment still follows the catalog
 * variable until R2. While it is false the registry route refuses every
 * write. Reading is never latched.
 */
export const AMUX_WORKER_REGISTRY_WRITES_LATCH = true;

/** The latch as the route and the page read it: one place to look. */
export const amuxWorkerRegistryWritesOpen = (): boolean => AMUX_WORKER_REGISTRY_WRITES_LATCH;

export type AmuxWorkerRegistryAdminRow = {
  workerName: string;
  providerClass: AmuxWorkerProviderClass;
  verified: boolean;
  classMaxRole: AmuxWorkerRoleCeiling;
  roleCeiling: AmuxWorkerRoleCeiling;
  desiredState: AmuxWorkerDesiredState;
  revision: number;
  changedAt: string;
  latch: AmuxWorkerLatchEventKind | null;
  observation: AmuxWorkerObservationStatus | null;
  assignable: boolean;
  reasons: AmuxWorkerUnassignableReason[];
};

export type AmuxWorkerRegistryAdminSeedRow = AmuxWorkerSeedEntry & { registered: boolean };

export type AmuxWorkerRegistryAdminView = {
  writesLatch: boolean;
  /** False when a stored registry row is one the guard would not have accepted. */
  registryReadable: boolean;
  rows: AmuxWorkerRegistryAdminRow[];
  comparison: AmuxWorkerCatalogComparison;
  /** Null while the registry cannot be read: nothing is offered for registration. */
  seed: AmuxWorkerRegistryAdminSeedRow[] | null;
};

/**
 * What AMUX › Execution › Workers shows, from one read of the registry and
 * the catalog environment variable. Section 3: the desired state and the
 * effective state are shown apart.
 */
export function buildAmuxWorkerRegistryAdminView(input: {
  registrations: ReadonlyArray<AmuxWorkerRegistration & { changedAt: string }> | null;
  latches: ReadonlyMap<string, AmuxWorkerLatchEventKind>;
  observations: ReadonlyMap<string, AmuxWorkerObservationStatus>;
  catalog: readonly AmuxCatalogWorker[] | null;
  writesLatch?: boolean;
}): AmuxWorkerRegistryAdminView {
  const writesLatch = input.writesLatch ?? amuxWorkerRegistryWritesOpen();
  const registrations = input.registrations;
  const comparison = compareAmuxWorkerRegistryWithCatalog(registrations, input.catalog);
  if (registrations === null) {
    return { writesLatch, registryReadable: false, rows: [], comparison, seed: null };
  }
  const rows = [...registrations]
    .sort((a, b) => a.workerName.localeCompare(b.workerName))
    .map((registration): AmuxWorkerRegistryAdminRow => {
      const latch = input.latches.get(registration.workerName) ?? null;
      const observation = input.observations.get(registration.workerName) ?? null;
      const effective = amuxWorkerEffectiveState({
        registration,
        latchNewestKind: latch,
        latestObservationStatus: observation,
      });
      const definition = AMUX_WORKER_PROVIDER_CLASS_TABLE[registration.providerClass];
      return {
        workerName: registration.workerName,
        providerClass: registration.providerClass,
        verified: definition.verified,
        classMaxRole: definition.maxRole,
        roleCeiling: registration.roleCeiling,
        desiredState: registration.desiredState,
        revision: registration.revision,
        changedAt: registration.changedAt,
        latch,
        observation,
        assignable: effective.assignable,
        reasons: effective.reasons,
      };
    });
  const registered = new Set(registrations.map((row) => row.workerName));
  const seed = AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => ({
    ...entry,
    registered: registered.has(entry.workerName),
  }));
  return { writesLatch, registryReadable: true, rows, comparison, seed };
}

/** The seed entries an owner may still register, in seed order. */
export const amuxWorkerSeedEntriesToRegister = (
  view: Pick<AmuxWorkerRegistryAdminView, "seed">,
): AmuxWorkerSeedEntry[] =>
  (view.seed ?? [])
    .filter((entry) => !entry.registered)
    .map(({ workerName, roleCeiling, desiredState }) => ({ workerName, roleCeiling, desiredState }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const isIso = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const CATALOG_STATES: readonly string[] = ["assignable", "held", "absent"];

const parseAdminRow = (value: unknown): AmuxWorkerRegistryAdminRow | null => {
  if (!isRecord(value)) return null;
  const providerClass = amuxWorkerProviderClassOf(value.workerName);
  if (providerClass === null || value.providerClass !== providerClass) return null;
  if (!isAmuxWorkerRoleCeiling(value.roleCeiling) || !isAmuxWorkerRoleCeiling(value.classMaxRole)) return null;
  if (!isAmuxWorkerDesiredState(value.desiredState)) return null;
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
  if (!isIso(value.changedAt) || !isBool(value.verified) || !isBool(value.assignable)) return null;
  if (value.latch !== null && !isAmuxWorkerLatchEventKind(value.latch)) return null;
  if (value.observation !== null && !isAmuxWorkerObservationStatus(value.observation)) return null;
  if (!Array.isArray(value.reasons) ||
      !value.reasons.every((reason) => isOneOf(AMUX_WORKER_UNASSIGNABLE_REASONS, reason))) {
    return null;
  }
  return value as AmuxWorkerRegistryAdminRow;
};

const parseComparison = (value: unknown): AmuxWorkerCatalogComparison | null => {
  if (!isRecord(value) || !Array.isArray(value.rows)) return null;
  if (value.status === "registry_unreadable" || value.status === "catalog_unreadable") {
    return value.rows.length === 0 ? { status: value.status, rows: [] } : null;
  }
  if (value.status !== "match" && value.status !== "mismatch") return null;
  for (const row of value.rows) {
    // A comparison row names a registry worker or a catalog entry. The catalog
    // names its workers by the AMUX machine-id rule, which is wider than the
    // registry's grammar, so only a registry name may carry a registry state.
    if (!isRecord(row) || typeof row.workerName !== "string" ||
        !AMUX_CATALOG_WORKER_NAME_PATTERN.test(row.workerName)) {
      return null;
    }
    if (row.registryState !== null &&
        (!isAmuxWorkerName(row.workerName) || !isAmuxWorkerDesiredState(row.registryState))) {
      return null;
    }
    if (typeof row.catalog !== "string" || !CATALOG_STATES.includes(row.catalog)) return null;
    if (!isOneOf(AMUX_WORKER_CATALOG_VERDICTS, row.verdict)) return null;
    // The server marks a row exempt only for an exempt name the catalog lists
    // and the registry cannot hold.
    if (row.verdict === "exempt" &&
        (!isCatalogExempt(row.workerName) || row.registryState !== null || row.catalog === "absent")) {
      return null;
    }
  }
  return value as AmuxWorkerCatalogComparison;
};

/**
 * The registry route's GET body, or null when it is not exactly that shape.
 * A body that does not parse is a failed read, never a guessed registry.
 */
export function parseAmuxWorkerRegistryAdminView(body: unknown): AmuxWorkerRegistryAdminView | null {
  if (!isRecord(body) || !isBool(body.writesLatch) || !isBool(body.registryReadable)) return null;
  if (!Array.isArray(body.rows)) return null;
  const rows: AmuxWorkerRegistryAdminRow[] = [];
  for (const row of body.rows) {
    const parsed = parseAdminRow(row);
    if (parsed === null) return null;
    rows.push(parsed);
  }
  const comparison = parseComparison(body.comparison);
  if (comparison === null) return null;
  let seed: AmuxWorkerRegistryAdminSeedRow[] | null = null;
  if (body.seed !== null) {
    if (!Array.isArray(body.seed) || body.seed.length !== AMUX_WORKER_REGISTRY_V31_SEED.length) return null;
    seed = [];
    for (const [index, entry] of body.seed.entries()) {
      const expected = AMUX_WORKER_REGISTRY_V31_SEED[index];
      if (!isRecord(entry) || entry.workerName !== expected.workerName ||
          entry.roleCeiling !== expected.roleCeiling || entry.desiredState !== expected.desiredState ||
          !isBool(entry.registered)) {
        return null;
      }
      seed.push({ ...expected, registered: entry.registered });
    }
  }
  if (!body.registryReadable && (seed !== null || rows.length > 0)) return null;
  return { writesLatch: body.writesLatch, registryReadable: body.registryReadable, rows, comparison, seed };
}
