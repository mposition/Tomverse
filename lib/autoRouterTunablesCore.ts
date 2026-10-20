/**
 * The Auto router settings the optimizer may change on its own.
 *
 * Owner approval (2026-10-20, in chat): "설정 자동 적용 권한 승인합니다. 하지만
 * 운영자에게 알림은 가야됩니다." The analysis model proposes a change in the
 * same call that writes its report; what is decided here is whether the
 * change is admitted. That happens only when it is on a closed list, inside
 * that setting's range, and backed by evidence the cycle itself measured. A
 * person can undo it in Admin, and a timeout change that made routing worse
 * is undone by the next cycle (tunableRevertDecision).
 *
 * Pure, so every rule runs under test without a database or a model.
 */

/** The router's live deadline: raised when calls time out, lowered when they never come close. */
export const ROUTER_TIMEOUT_TUNABLE = { min: 3_000, max: 8_000, step: 500 } as const;

/** A model left out of the router's candidates for a while after its calls kept failing. */
export const MODEL_EXCLUSION_TUNABLE = { minHours: 1, maxHours: 48, maxActive: 3 } as const;

/** At most this many changes per cycle; the rest are reported as not applied. */
export const TUNABLE_CHANGES_PER_CYCLE = 2;

export const TUNABLE_SETTINGS = ["routerTimeoutMs", "excludeModel"] as const;
export type TunableSetting = (typeof TUNABLE_SETTINGS)[number];

/** Evidence floors: fewer decisions or answers than these prove nothing. */
const MIN_ROUTER_DECISIONS = 20;
/** Raise the deadline only when this share of router calls timed out or errored. */
const RAISE_WHEN_SHARE = 0.05;
/** Lower it only when nothing timed out and p90 latency sits this far under it. */
const LOWER_MARGIN_MS = 1_500;
/** Exclude a model only after this many failed answers, and at least half of its tries. */
const MIN_FAILED_ANSWERS = 2;
/**
 * After a tuned timeout is undone, no timeout change is taken for this long:
 * the statistics right after include the bad stretch, and re-applying on them
 * would make that stretch the new baseline.
 */
export const TIMEOUT_CHANGE_COOLDOWN_AFTER_REVERT_MS = 7 * 24 * 60 * 60 * 1000;
/** A timeout change is undone when timeouts and errors rose by this share. */
const REVERT_WHEN_WORSE_BY = 0.05;

export type RouterOutcomeShares = { decisions: number; timeoutOrErrorShare: number; p90LatencyMs: number | null };

export type TimeoutTunable = {
    value: number;
    previous: number;
    setAt: string;
    cycleId: string;
    reason: string;
    /** Router outcomes before the change, so the next cycle can tell if it helped. */
    before: RouterOutcomeShares;
};

export type ModelExclusion = { modelId: string; until: string; setAt: string; cycleId: string; reason: string };

export type AutoRouterTunables = {
    routerTimeoutMs: TimeoutTunable | null;
    excluded: ModelExclusion[];
    /** When a tuned timeout was last undone because routing got worse. */
    timeoutRevertedAt: string | null;
};

export const EMPTY_TUNABLES: AutoRouterTunables = { routerTimeoutMs: null, excluded: [], timeoutRevertedAt: null };

const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const inTimeoutRange = (value: number) =>
    Number.isInteger(value) && value >= ROUTER_TIMEOUT_TUNABLE.min && value <= ROUTER_TIMEOUT_TUNABLE.max;

const parseShares = (value: unknown): RouterOutcomeShares | null => {
    const raw = record(value);
    if (!raw || !finite(raw.decisions) || !finite(raw.timeoutOrErrorShare)) return null;
    return {
        decisions: raw.decisions,
        timeoutOrErrorShare: raw.timeoutOrErrorShare,
        p90LatencyMs: finite(raw.p90LatencyMs) ? raw.p90LatencyMs : null,
    };
};

/** The stored settings, or none of them when the row is missing or anything in it is off its shape. */
export const parseTunables = (raw: string | null | undefined): AutoRouterTunables => {
    if (!raw) return EMPTY_TUNABLES;
    let value: Record<string, unknown> | null;
    try {
        value = record(JSON.parse(raw));
    } catch {
        return EMPTY_TUNABLES;
    }
    if (!value) return EMPTY_TUNABLES;
    const timeout = record(value.routerTimeoutMs);
    const before = timeout ? parseShares(timeout.before) : null;
    const routerTimeoutMs =
        timeout &&
        finite(timeout.value) &&
        inTimeoutRange(timeout.value) &&
        finite(timeout.previous) &&
        typeof timeout.setAt === "string" &&
        typeof timeout.cycleId === "string" &&
        typeof timeout.reason === "string" &&
        before
            ? {
                  value: timeout.value,
                  previous: timeout.previous,
                  setAt: timeout.setAt,
                  cycleId: timeout.cycleId,
                  reason: timeout.reason,
                  before,
              }
            : null;
    const excluded = Array.isArray(value.excluded)
        ? value.excluded.flatMap((item): ModelExclusion[] => {
              const entry = record(item);
              if (
                  !entry ||
                  typeof entry.modelId !== "string" ||
                  typeof entry.until !== "string" ||
                  typeof entry.setAt !== "string" ||
                  typeof entry.cycleId !== "string" ||
                  typeof entry.reason !== "string"
              ) {
                  return [];
              }
              return [
                  {
                      modelId: entry.modelId,
                      until: entry.until,
                      setAt: entry.setAt,
                      cycleId: entry.cycleId,
                      reason: entry.reason,
                  },
              ];
          })
        : [];
    const timeoutRevertedAt =
        typeof value.timeoutRevertedAt === "string" && Number.isFinite(Date.parse(value.timeoutRevertedAt))
            ? value.timeoutRevertedAt
            : null;
    return { routerTimeoutMs, excluded, timeoutRevertedAt };
};

/** The live router's deadline: the tuned value, or the code's when none is set. */
export const effectiveRouterTimeoutMs = (tunables: AutoRouterTunables, codeDefault: number) =>
    tunables.routerTimeoutMs?.value ?? codeDefault;

/** The models out of the router's candidates at `now`; an expired exclusion has simply ended. */
export const activeExclusions = (tunables: AutoRouterTunables, now: number) =>
    tunables.excluded.filter((item) => Date.parse(item.until) > now);

/** The router's candidates without the excluded models -- never fewer than two, or none are dropped. */
export const withoutExcludedModels = <T extends { id: string }>(
    candidates: readonly T[],
    tunables: AutoRouterTunables,
    now: number
): T[] => {
    const out = new Set(activeExclusions(tunables, now).map((item) => item.modelId));
    const kept = candidates.filter((candidate) => !out.has(candidate.id));
    return kept.length >= 2 ? kept : [...candidates];
};

/** What one proposed change says, as the analysis model writes it. */
export type ProposedTunableChange = {
    setting: TunableSetting;
    value: number | null;
    modelId: string | null;
    hours: number | null;
    reason: string;
};

export const TUNABLE_REASON_MAX_CHARS = 300;

export type TunableRejection =
    | "malformed"
    | "unknown_setting"
    | "out_of_range"
    | "unchanged"
    | "no_evidence"
    | "not_a_candidate"
    | "no_same_credit_alternative"
    | "too_many_exclusions"
    | "over_cycle_limit"
    | "recently_reverted";

export type AdmittedTunableChange =
    | { setting: "routerTimeoutMs"; value: number; reason: string }
    | { setting: "excludeModel"; modelId: string; hours: number; reason: string };

/** What the cycle measured, which a change has to be backed by. */
export type TunableEvidence = {
    routerStats: {
        decisions: number;
        outcomes: { picked: number; invalid: number; error: number; timeout: number };
        latencyMs: { p50: number | null; p90: number | null };
    } | null;
    /** Answers per model in this cycle, from the direct comparisons. */
    answerStats: Readonly<Record<string, { answered: number; failed: number }>>;
    /** The router's candidates, with credits, as a live Auto turn sees them. */
    candidates: readonly { id: string; credits: number }[];
};

export const routerOutcomeShares = (stats: TunableEvidence["routerStats"]): RouterOutcomeShares | null =>
    stats && stats.decisions > 0
        ? {
              decisions: stats.decisions,
              timeoutOrErrorShare: (stats.outcomes.timeout + stats.outcomes.error) / stats.decisions,
              p90LatencyMs: stats.latencyMs.p90,
          }
        : null;

/** One proposal, raw as the model wrote it, into a change or a reason it is not one. */
export const parseProposedTunableChange = (raw: unknown): ProposedTunableChange | null => {
    const value = record(raw);
    if (!value || typeof value.reason !== "string") return null;
    if (!(TUNABLE_SETTINGS as readonly unknown[]).includes(value.setting)) return null;
    return {
        setting: value.setting as TunableSetting,
        value: finite(value.value) ? value.value : null,
        modelId: typeof value.modelId === "string" ? value.modelId : null,
        hours: finite(value.hours) ? value.hours : null,
        reason: value.reason.trim().slice(0, TUNABLE_REASON_MAX_CHARS),
    };
};

/**
 * Which proposed changes may be applied. Each is checked on its own against
 * its range and the cycle's evidence; the first TUNABLE_CHANGES_PER_CYCLE
 * that pass are admitted and later ones are refused as over the limit.
 */
export const admitTunableChanges = (input: {
    proposed: readonly unknown[];
    current: AutoRouterTunables;
    evidence: TunableEvidence;
    codeTimeoutMs: number;
    now: number;
}): { admitted: AdmittedTunableChange[]; rejected: { setting: string; reason: TunableRejection }[] } => {
    const admitted: AdmittedTunableChange[] = [];
    const rejected: { setting: string; reason: TunableRejection }[] = [];
    const shares = routerOutcomeShares(input.evidence.routerStats);
    const currentTimeout = effectiveRouterTimeoutMs(input.current, input.codeTimeoutMs);
    const excludedNow = new Set(activeExclusions(input.current, input.now).map((item) => item.modelId));

    for (const raw of input.proposed) {
        const change = parseProposedTunableChange(raw);
        const setting = change?.setting ?? String(record(raw)?.setting ?? "unknown");
        const refuse = (reason: TunableRejection) => rejected.push({ setting, reason });
        if (!change) {
            refuse((TUNABLE_SETTINGS as readonly unknown[]).includes(record(raw)?.setting) ? "malformed" : "unknown_setting");
            continue;
        }
        let candidate: AdmittedTunableChange | null = null;
        if (change.setting === "routerTimeoutMs") {
            const value = change.value;
            if (value === null || !inTimeoutRange(value) || value % ROUTER_TIMEOUT_TUNABLE.step !== 0) {
                refuse("out_of_range");
                continue;
            }
            if (value === currentTimeout) {
                refuse("unchanged");
                continue;
            }
            const revertedAt = input.current.timeoutRevertedAt ? Date.parse(input.current.timeoutRevertedAt) : null;
            if (revertedAt !== null && input.now - revertedAt < TIMEOUT_CHANGE_COOLDOWN_AFTER_REVERT_MS) {
                refuse("recently_reverted");
                continue;
            }
            if (!shares || shares.decisions < MIN_ROUTER_DECISIONS) {
                refuse("no_evidence");
                continue;
            }
            const raising = value > currentTimeout;
            const backed = raising
                ? shares.timeoutOrErrorShare >= RAISE_WHEN_SHARE
                : (input.evidence.routerStats?.outcomes.timeout ?? 1) === 0 &&
                  shares.p90LatencyMs !== null &&
                  shares.p90LatencyMs + LOWER_MARGIN_MS <= value;
            if (!backed) {
                refuse("no_evidence");
                continue;
            }
            candidate = { setting: "routerTimeoutMs", value, reason: change.reason };
        } else {
            const modelId = change.modelId;
            const hours = change.hours;
            if (
                !modelId ||
                hours === null ||
                !Number.isInteger(hours) ||
                hours < MODEL_EXCLUSION_TUNABLE.minHours ||
                hours > MODEL_EXCLUSION_TUNABLE.maxHours
            ) {
                refuse("out_of_range");
                continue;
            }
            const self = input.evidence.candidates.find((item) => item.id === modelId);
            if (!self) {
                refuse("not_a_candidate");
                continue;
            }
            if (excludedNow.has(modelId)) {
                refuse("unchanged");
                continue;
            }
            const stats = input.evidence.answerStats[modelId];
            // answered counts successful answers only: the share is of all tries.
            if (!stats || stats.failed < MIN_FAILED_ANSWERS || stats.failed * 2 < stats.answered + stats.failed) {
                refuse("no_evidence");
                continue;
            }
            const pending = admitted.filter((item) => item.setting === "excludeModel").length;
            if (excludedNow.size + pending >= MODEL_EXCLUSION_TUNABLE.maxActive) {
                refuse("too_many_exclusions");
                continue;
            }
            const out = new Set([
                ...excludedNow,
                ...admitted.flatMap((item) => (item.setting === "excludeModel" ? [item.modelId] : [])),
                modelId,
            ]);
            const alternative = input.evidence.candidates.some(
                (item) => item.credits === self.credits && !out.has(item.id)
            );
            if (!alternative) {
                refuse("no_same_credit_alternative");
                continue;
            }
            candidate = { setting: "excludeModel", modelId, hours, reason: change.reason };
        }
        if (admitted.length >= TUNABLE_CHANGES_PER_CYCLE) {
            refuse("over_cycle_limit");
            continue;
        }
        admitted.push(candidate);
    }
    return { admitted, rejected };
};

/** The stored settings after admitted changes; expired exclusions are dropped on the way. */
export const applyTunableChanges = (input: {
    current: AutoRouterTunables;
    changes: readonly AdmittedTunableChange[];
    cycleId: string;
    now: number;
    codeTimeoutMs: number;
    before: RouterOutcomeShares;
}): AutoRouterTunables => {
    const setAt = new Date(input.now).toISOString();
    let routerTimeoutMs = input.current.routerTimeoutMs;
    const excluded = activeExclusions(input.current, input.now);
    const timeoutRevertedAt = input.current.timeoutRevertedAt;
    for (const change of input.changes) {
        if (change.setting === "routerTimeoutMs") {
            routerTimeoutMs = {
                value: change.value,
                previous: effectiveRouterTimeoutMs({ routerTimeoutMs, excluded, timeoutRevertedAt }, input.codeTimeoutMs),
                setAt,
                cycleId: input.cycleId,
                reason: change.reason,
                before: input.before,
            };
        } else {
            excluded.push({
                modelId: change.modelId,
                until: new Date(input.now + change.hours * 60 * 60 * 1000).toISOString(),
                setAt,
                cycleId: input.cycleId,
                reason: change.reason,
            });
        }
    }
    return { routerTimeoutMs, excluded, timeoutRevertedAt };
};

/**
 * Whether the tuned timeout made routing worse since it was set: undo it when
 * enough decisions came after it and the timeout-or-error share rose by more
 * than REVERT_WHEN_WORSE_BY.
 */
export const tunableRevertDecision = (
    tuned: TimeoutTunable | null,
    after: RouterOutcomeShares | null
): "keep" | "revert" | "wait" => {
    if (!tuned) return "keep";
    if (!after || after.decisions < MIN_ROUTER_DECISIONS) return "wait";
    return after.timeoutOrErrorShare > tuned.before.timeoutOrErrorShare + REVERT_WHEN_WORSE_BY ? "revert" : "keep";
};

/**
 * The settings with the tuned timeout undone. It goes back to the code's
 * default, not to `previous`: an earlier tuned value was itself only a
 * proposal, and the default is the one value nobody tuned.
 */
export const revertedTimeout = (current: AutoRouterTunables, now: number): AutoRouterTunables => ({
    ...current,
    routerTimeoutMs: null,
    timeoutRevertedAt: new Date(now).toISOString(),
});

/** The analysis model's instruction for proposing a change, appended to the generator's. */
export const TUNABLE_GENERATOR_RULE = [
    "You may also propose up to two setting changes in settingChanges, only where the evidence above shows the need; otherwise leave it empty.",
    `routerTimeoutMs: the router's live deadline in milliseconds, ${ROUTER_TIMEOUT_TUNABLE.min}-${ROUTER_TIMEOUT_TUNABLE.max} in steps of ${ROUTER_TIMEOUT_TUNABLE.step}; raise it when routerStats shows timeouts or errors, lower it only when nothing timed out and p90 latency is far below it. Set value; leave modelId and hours null.`,
    `excludeModel: leave a candidate out of the router's choices for ${MODEL_EXCLUSION_TUNABLE.minHours}-${MODEL_EXCLUSION_TUNABLE.maxHours} hours when its answers in this cycle kept failing (answerStats). Set modelId to the exact candidate id and hours; leave value null.`,
    "Give each a one-sentence reason in Korean. A change outside these rules is not applied.",
].join("\n");

/** The schema part for proposed changes, nullable fields so a strict schema can require them all. */
export const tunableChangesSchema = () => ({
    type: "array" as const,
    items: {
        type: "object" as const,
        properties: {
            setting: { type: "string" as const, enum: [...TUNABLE_SETTINGS] },
            value: { type: ["number", "null"] as ("number" | "null")[] },
            modelId: { type: ["string", "null"] as ("string" | "null")[] },
            hours: { type: ["number", "null"] as ("number" | "null")[] },
            reason: { type: "string" as const },
        },
        required: ["setting", "value", "modelId", "hours", "reason"],
        additionalProperties: false,
    },
});
