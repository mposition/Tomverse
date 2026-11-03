/**
 * The AMUX worker registry, orchestration policy version 31
 * (docs/policy/development-agent-orchestration.md, "버전 31"), stage R1.
 *
 * Pure: the provider class table (section 2), the worker name grammar, the
 * desired states and the change rule a registry event must satisfy (section
 * 3), and the effective assignment rule (section 3: desired `active`, no open
 * automatic-stop latch, latest observation ok). No I/O.
 *
 * Every vocabulary here is compared with its CHECK by `npm run
 * check:enum-constraints`, and the change rule is the one the guard trigger
 * holds (migration 20261012100000_amux_worker_registry, its body replaced by
 * 20261020200000_amux_worker_registry_direct_activation);
 * tests/amuxWorkerRegistryStore.test.mjs reads that guard and fails when the
 * two drift.
 *
 * Since R2c (version 53) the assignment catalog is derived from this registry
 * (lib/amux/workerDerivedCatalogCore.ts); R1's comparison with the catalog
 * environment variable went with the variable at R2e.
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

/**
 * A worker name: 1-40 lower-case letters, digits and hyphens, neither first
 * nor last a hyphen. Owner decision 2026-10-27: the class (the CLI it runs) is
 * chosen at registration and recorded with it, never read from the name.
 */
export const AMUX_WORKER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * How the assignment catalog names a worker: `AMUX_MACHINE_ID_PATTERN` in
 * lib/amux/claimContract.ts, copied so this module stays free of imports
 * (tests/amuxWorkerRegistryCore.test.mjs pins the two equal). It is wider
 * than the registry's grammar: a runtime row may carry a name the registry
 * cannot hold, such as the engineering adapter's runner.
 */
export const AMUX_CATALOG_WORKER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,118}[A-Za-z0-9])?$/;

/** Section 3's desired states, set by a person only. */
export const AMUX_WORKER_DESIRED_STATES = ["requested", "active", "paused", "retired"] as const;
export type AmuxWorkerDesiredState = (typeof AMUX_WORKER_DESIRED_STATES)[number];

export type AmuxWorkerSeedEntry = Readonly<{
  workerName: string;
  providerClass: AmuxWorkerProviderClass;
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
  { workerName: "claude-chore", providerClass: "claude", roleCeiling: "chore", desiredState: "active" },
  { workerName: "claude-contract", providerClass: "claude", roleCeiling: "contract", desiredState: "active" },
  { workerName: "claude-impl", providerClass: "claude", roleCeiling: "implementation", desiredState: "active" },
  { workerName: "claude-review", providerClass: "claude", roleCeiling: "contract", desiredState: "active" },
  { workerName: "codex-chore", providerClass: "codex", roleCeiling: "chore", desiredState: "active" },
  { workerName: "codex-contract", providerClass: "codex", roleCeiling: "contract", desiredState: "active" },
  { workerName: "codex-impl", providerClass: "codex", roleCeiling: "implementation", desiredState: "active" },
  { workerName: "cursor-chore", providerClass: "cursor", roleCeiling: "chore", desiredState: "requested" },
  { workerName: "cursor-impl", providerClass: "cursor", roleCeiling: "implementation", desiredState: "requested" },
  { workerName: "cursor-worker", providerClass: "cursor", roleCeiling: "implementation", desiredState: "requested" },
  { workerName: "copilot-chore", providerClass: "copilot", roleCeiling: "chore", desiredState: "requested" },
  { workerName: "copilot-impl", providerClass: "copilot", roleCeiling: "implementation", desiredState: "requested" },
  { workerName: "copilot-worker", providerClass: "copilot", roleCeiling: "implementation", desiredState: "requested" },
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

/**
 * A registrable name. The engineering adapter's runner is never one (version
 * 34): the old prefix grammar refused it by its shape, the free grammar does
 * by name, as the migration's CHECK does.
 */
export const isAmuxWorkerName = (value: unknown): value is string =>
  typeof value === "string" && AMUX_WORKER_NAME_PATTERN.test(value) && !AMUX_WORKER_CATALOG_EXEMPT.includes(value);

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

/** A person's change, from untrusted input, or null. The class is chosen, not read from the name. */
export function parseAmuxWorkerRegistryChange(input: {
  workerName: unknown;
  providerClass: unknown;
  roleCeiling: unknown;
  desiredState: unknown;
  expectedRevision: unknown;
}): AmuxWorkerRegistryChange | null {
  if (!isAmuxWorkerName(input.workerName)) return null;
  const providerClass = input.providerClass;
  if (!isAmuxWorkerProviderClass(providerClass)) return null;
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
  "class_changed",
  "stale_revision",
  "first_state_invalid",
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
 * - A worker starts `requested` or `active`.
 * - `retired` is final; the name is not reused (section 3).
 * - The owner may make a `requested` or `paused` worker `active` directly,
 *   with no trial period (operator decision, 2026-10-20).
 * - A wider role is allowed only while the new event is `requested`.
 *   Narrowing is never refused (section 2: narrowing has no gate).
 */
export function amuxWorkerRegistryChangeRefusal(
  previous: AmuxWorkerRegistration | null,
  change: AmuxWorkerRegistryChange,
): AmuxWorkerRegistryRefusal | null {
  if (!amuxWorkerRoleWithinClass(change.providerClass, change.roleCeiling)) return "role_above_class";
  if (change.expectedRevision !== (previous?.revision ?? 0)) return "stale_revision";
  if (previous === null) {
    return change.desiredState === "requested" || change.desiredState === "active" ? null : "first_state_invalid";
  }
  if (previous.desiredState === "retired") return "retired";
  // A name keeps the class it was registered with (the guard raises CLASS_CHANGED).
  if (change.providerClass !== previous.providerClass) return "class_changed";
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
  const providerClass = row.providerClass;
  if (!isAmuxWorkerName(row.workerName) || !isAmuxWorkerProviderClass(providerClass)) return null;
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

/**
 * Version 34: catalog entries that are code constants rather than registry
 * workers, because another policy governs them. `engineering-runner` is the
 * engineering adapter's worker identity (versions 12 and 25,
 * docs/policy/engineering-agent.md), not a resident AMUX runner worker, and
 * its name is outside the registry's grammar, so the derived catalog carries
 * it as a constant (lib/amux/workerDerivedCatalogCore.ts) and the selection
 * ceiling check leaves it to its own policy. Adding a name is a policy
 * version.
 */
export const AMUX_WORKER_CATALOG_EXEMPT: readonly string[] = Object.freeze(["engineering-runner"]);

// ---------------------------------------------------------------------------
// The Admin screen (R1)

/**
 * Section 8: each stage ships with its code latch off; the operator's
 * activation record turns it on. R1 shipped it false; version 32 (approved
 * 2026-10-12) is that record and sets it true, so the owner may write the
 * registry. While it is false the registry route refuses every write. Reading
 * is never latched.
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
  /** Null while the registry cannot be read: nothing is offered for registration. */
  seed: AmuxWorkerRegistryAdminSeedRow[] | null;
};

/**
 * What AMUX › Operations settings › Workers shows, from one read of the registry.
 * Section 3: the desired state and the effective state are shown apart.
 */
export function buildAmuxWorkerRegistryAdminView(input: {
  registrations: ReadonlyArray<AmuxWorkerRegistration & { changedAt: string }> | null;
  latches: ReadonlyMap<string, AmuxWorkerLatchEventKind>;
  observations: ReadonlyMap<string, AmuxWorkerObservationStatus>;
  writesLatch?: boolean;
}): AmuxWorkerRegistryAdminView {
  const writesLatch = input.writesLatch ?? amuxWorkerRegistryWritesOpen();
  const registrations = input.registrations;
  if (registrations === null) {
    return { writesLatch, registryReadable: false, rows: [], seed: null };
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
  return { writesLatch, registryReadable: true, rows, seed };
}

/** The seed entries an owner may still register, in seed order. */
export const amuxWorkerSeedEntriesToRegister = (
  view: Pick<AmuxWorkerRegistryAdminView, "seed">,
): AmuxWorkerSeedEntry[] =>
  (view.seed ?? [])
    .filter((entry) => !entry.registered)
    .map(({ workerName, providerClass, roleCeiling, desiredState }) =>
      ({ workerName, providerClass, roleCeiling, desiredState }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const isIso = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));

const parseAdminRow = (value: unknown): AmuxWorkerRegistryAdminRow | null => {
  if (!isRecord(value)) return null;
  if (!isAmuxWorkerName(value.workerName) || !isAmuxWorkerProviderClass(value.providerClass)) return null;
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
  let seed: AmuxWorkerRegistryAdminSeedRow[] | null = null;
  if (body.seed !== null) {
    if (!Array.isArray(body.seed) || body.seed.length !== AMUX_WORKER_REGISTRY_V31_SEED.length) return null;
    seed = [];
    for (const [index, entry] of body.seed.entries()) {
      const expected = AMUX_WORKER_REGISTRY_V31_SEED[index];
      if (!isRecord(entry) || entry.workerName !== expected.workerName ||
          entry.providerClass !== expected.providerClass ||
          entry.roleCeiling !== expected.roleCeiling || entry.desiredState !== expected.desiredState ||
          !isBool(entry.registered)) {
        return null;
      }
      seed.push({ ...expected, registered: entry.registered });
    }
  }
  if (!body.registryReadable && (seed !== null || rows.length > 0)) return null;
  return { writesLatch: body.writesLatch, registryReadable: body.registryReadable, rows, seed };
}
