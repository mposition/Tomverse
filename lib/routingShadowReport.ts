/**
 * Reading shadow routing back — the analysis half of step 3.
 *
 * Shadow runs record what the Router would have chosen beside what actually
 * ran. This turns a table of those into the few numbers a person needs before
 * anyone is switched over.
 *
 * **Agreement is not quality, and this refuses to imply otherwise.** `ROUTE-01`
 * grades the Router on a win-rate against the fixed-model baseline, measured on
 * an evaluation set. Agreement with the user's own pick is a different thing
 * entirely: a Router that always echoed the user would agree 100% of the time
 * and be worth nothing, and a Router that is right where the user was wrong
 * shows up here as disagreement. So this reports agreement as *what it is* — a
 * measure of how much would change if Auto were switched on — and never as a
 * score.
 *
 * What it is genuinely good for is the blast radius: which models Auto would
 * move traffic away from, which filters actually fire, whether the decision is
 * fast enough for `ROUTE-02`, and whether the Router ever fails to produce a
 * candidate at all.
 *
 * Pure. The caller supplies rows; this decides what they mean.
 */

/**
 * Stands for a row that recorded no scoring-policy version.
 *
 * A real key rather than a filter, so a sample that mixes pre-policy rows with
 * post-policy ones says so instead of quietly comparing one against a subset
 * of itself.
 */
export const NO_POLICY_VERSION = "none";

export type ShadowRunRow = {
    taskProfileVersion: string;
    candidateFilterVersion: string;
    selectionVersion: string;
    /**
     * The scoring policy the decision ran under. Null on a row written before
     * the policy had a version of its own, and on a manual turn the Router
     * never decided.
     */
    selectionPolicyVersion?: string | null;
    profileKind: string;
    plan: string;
    selectedModelId: string | null;
    selectionReason: string;
    userSelectedModelId: string;
    eligibleCount: number;
    rejectedByReason: Record<string, number>;
    decisionMicros: number;
};

export type VersionMix = {
    taskProfileVersions: string[];
    candidateFilterVersions: string[];
    selectionVersions: string[];
    /** `none` stands for a row that recorded no policy version. */
    selectionPolicyVersions: string[];
    /** True when any of the four has more than one value in the sample. */
    mixed: boolean;
};

export type SwitchPair = {
    from: string;
    to: string;
    count: number;
};

export type GroupAgreement = {
    key: string;
    decided: number;
    agreed: number;
    /** Null when the group decided nothing — a rate over zero is not zero. */
    agreementRate: number | null;
};

export type ShadowReport = {
    rows: number;
    versions: VersionMix;
    /** Rows where the Router produced a model. */
    decided: number;
    /**
     * Rows where nothing survived the filters. Deliberately not counted as
     * disagreement: the Router did not pick differently, it could not pick.
     * Under Auto these are the requests that would have had nowhere to go.
     */
    undecided: number;
    agreed: number;
    /** Over `decided`, never over `rows`. Null when nothing was decided. */
    agreementRate: number | null;
    /** Most common "user chose X, Router would have chosen Y" pairs. */
    switches: SwitchPair[];
    byTaskKind: GroupAgreement[];
    byPlan: GroupAgreement[];
    /** How often each selection reason produced the decision. */
    selectionReasons: Record<string, number>;
    /** How often each hard filter refused a model, summed over rows. */
    rejectionReasons: Record<string, number>;
    decisionMicrosP50: number;
    decisionMicrosP95: number;

    /**
     * How often the filters left anything to choose from at all.
     *
     * Distinct from the agreement rate and more consequential: a request the
     * Router could not answer is one Auto would have to refuse, so this is the
     * ceiling on how much of the traffic Auto could serve even if every choice
     * it made were perfect.
     */
    candidateAvailabilityRate: number | null;
    /** Eligible-set size, so "one candidate" and "nine" are distinguishable. */
    eligibleCountP50: number;
    eligibleCountP95: number;
    /**
     * What the Router would pick, as a distribution. The switch pairs say what
     * would move; this says where it would move *to*, which is the number that
     * shows a Router collapsing onto one model.
     */
    selectedModelCounts: Record<string, number>;
    /**
     * Turns held on the current model by the margin-and-hysteresis rule.
     * Every one is a turn where a challenger scored higher and the Router
     * stayed put on purpose, so a rate near zero means stickiness is not doing
     * anything and a rate near one means it is doing everything.
     */
    stickyHeldRate: number | null;
};

const percentile = (sorted: readonly number[], fraction: number) => {
    if (sorted.length === 0) return 0;
    const rank = Math.ceil(fraction * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

const groupAgreement = (
    rows: readonly ShadowRunRow[],
    keyOf: (row: ShadowRunRow) => string
): GroupAgreement[] => {
    const groups = new Map<string, { decided: number; agreed: number }>();
    for (const row of rows) {
        // Undecided rows are excluded from the denominator here for the same
        // reason as the total: they are not a different choice.
        if (row.selectedModelId === null) continue;
        const key = keyOf(row);
        const group = groups.get(key) ?? { decided: 0, agreed: 0 };
        group.decided += 1;
        if (row.selectedModelId === row.userSelectedModelId) group.agreed += 1;
        groups.set(key, group);
    }
    return [...groups.entries()]
        .map(([key, group]) => ({
            key,
            decided: group.decided,
            agreed: group.agreed,
            agreementRate:
                group.decided === 0 ? null : group.agreed / group.decided,
        }))
        .sort((left, right) => right.decided - left.decided);
};

export function buildShadowReport(
    rows: readonly ShadowRunRow[],
    { maxSwitches = 10 }: { maxSwitches?: number } = {}
): ShadowReport {
    const distinct = (pick: (row: ShadowRunRow) => string) =>
        [...new Set(rows.map(pick))].sort();
    const taskProfileVersions = distinct((row) => row.taskProfileVersion);
    const candidateFilterVersions = distinct(
        (row) => row.candidateFilterVersion
    );
    const selectionVersions = distinct((row) => row.selectionVersion);
    const selectionPolicyVersions = distinct(
        (row) => row.selectionPolicyVersion ?? NO_POLICY_VERSION
    );

    let decided = 0;
    let agreed = 0;
    const switchCounts = new Map<string, Map<string, number>>();
    const selectionReasons: Record<string, number> = {};
    const rejectionReasons: Record<string, number> = {};
    const selectedModelCounts: Record<string, number> = {};
    const micros: number[] = [];
    const eligibleCounts: number[] = [];

    for (const row of rows) {
        micros.push(row.decisionMicros);
        eligibleCounts.push(row.eligibleCount);
        selectionReasons[row.selectionReason] =
            (selectionReasons[row.selectionReason] ?? 0) + 1;
        for (const [reason, count] of Object.entries(
            row.rejectedByReason ?? {}
        )) {
            rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + count;
        }
        if (row.selectedModelId === null) continue;
        decided += 1;
        selectedModelCounts[row.selectedModelId] =
            (selectedModelCounts[row.selectedModelId] ?? 0) + 1;
        if (row.selectedModelId === row.userSelectedModelId) {
            agreed += 1;
            continue;
        }
        // Keyed by the pair itself rather than by a joined string: a
        // separator has to be a byte no model id can contain, and the obvious
        // choice -- a literal NUL -- makes the whole file binary as far as git
        // is concerned (lib/memoryExtractionLaunch.ts records that lesson).
        // A nested map needs no separator at all.
        const byTarget =
            switchCounts.get(row.userSelectedModelId) ?? new Map<string, number>();
        byTarget.set(
            row.selectedModelId,
            (byTarget.get(row.selectedModelId) ?? 0) + 1
        );
        switchCounts.set(row.userSelectedModelId, byTarget);
    }

    const switches = [...switchCounts.entries()]
        .flatMap(([from, targets]) =>
            [...targets.entries()].map(([to, count]) => ({ from, to, count }))
        )
        .sort((left, right) =>
            right.count !== left.count
                ? right.count - left.count
                : // Stable beyond the count, so two runs over the same data
                  // print the same order.
                  `${left.from}${left.to}` < `${right.from}${right.to}`
                  ? -1
                  : 1
        )
        .slice(0, maxSwitches);

    const sortedMicros = [...micros].sort((left, right) => left - right);
    const sortedEligible = [...eligibleCounts].sort((left, right) => left - right);

    return {
        rows: rows.length,
        versions: {
            taskProfileVersions,
            candidateFilterVersions,
            selectionVersions,
            selectionPolicyVersions,
            mixed:
                taskProfileVersions.length > 1 ||
                candidateFilterVersions.length > 1 ||
                selectionVersions.length > 1 ||
                selectionPolicyVersions.length > 1,
        },
        decided,
        undecided: rows.length - decided,
        agreed,
        agreementRate: decided === 0 ? null : agreed / decided,
        switches,
        byTaskKind: groupAgreement(rows, (row) => row.profileKind),
        byPlan: groupAgreement(rows, (row) => row.plan),
        selectionReasons,
        rejectionReasons,
        decisionMicrosP50: percentile(sortedMicros, 0.5),
        decisionMicrosP95: percentile(sortedMicros, 0.95),
        // Over every row, not over the decided ones: the question is what
        // fraction of real traffic had a candidate, and dividing by the rows
        // that had one would answer 100% every time.
        candidateAvailabilityRate: rows.length === 0 ? null : decided / rows.length,
        eligibleCountP50: percentile(sortedEligible, 0.5),
        eligibleCountP95: percentile(sortedEligible, 0.95),
        selectedModelCounts,
        stickyHeldRate:
            decided === 0 ? null : (selectionReasons.sticky ?? 0) / decided,
    };
}


export type SelectionShareDelta = {
    modelId: string;
    baselineCount: number;
    baselineShare: number;
    candidateCount: number;
    candidateShare: number;
    /** Candidate share minus baseline share. Positive means it gained turns. */
    shareDelta: number;
};

export type SelectionDistributionComparison = {
    /** Which column the two sides were split on. */
    groupedBy: SelectionDistributionKey;
    baseline: string;
    candidate: string;
    baselineDecided: number;
    candidateDecided: number;
    /**
     * Every model either side selected, ordered by how much its share moved.
     * A model present on one side only appears with a zero on the other, which
     * is the entry that matters most: it is a model the change made reachable
     * or unreachable.
     */
    models: SelectionShareDelta[];
    /**
     * Half the summed absolute share difference: the fraction of decided turns
     * that would land on a different model under the candidate policy.
     *
     * Null when either side decided nothing, because a distance from an empty
     * distribution is not zero -- it is undefined, and reporting zero would
     * read as "nothing changed".
     */
    totalVariationDistance: number | null;
    baselineSelectionReasons: Record<string, number>;
    candidateSelectionReasons: Record<string, number>;
    /** False when either side has no decided rows, which makes the rest noise. */
    comparable: boolean;
};

export type SelectionDistributionKey =
    | "selectionPolicyVersion"
    | "selectionVersion";

const distributionKeyOf = (
    row: ShadowRunRow,
    key: SelectionDistributionKey
): string =>
    key === "selectionVersion"
        ? row.selectionVersion
        : (row.selectionPolicyVersion ?? NO_POLICY_VERSION);

/**
 * Which values of a version column the sample actually holds, largest first.
 *
 * The caller needs this before it can name a baseline and a candidate, and it
 * is also the answer to "why is there no comparison": one key means the sample
 * spans one policy, so there is nothing to compare it with.
 */
export const selectionDistributionKeys = (
    rows: readonly ShadowRunRow[],
    key: SelectionDistributionKey = "selectionPolicyVersion"
): { key: string; rows: number; decided: number }[] => {
    const groups = new Map<string, { rows: number; decided: number }>();
    for (const row of rows) {
        const value = distributionKeyOf(row, key);
        const group = groups.get(value) ?? { rows: 0, decided: 0 };
        group.rows += 1;
        if (row.selectedModelId !== null) group.decided += 1;
        groups.set(value, group);
    }
    return [...groups.entries()]
        .map(([value, group]) => ({ key: value, ...group }))
        .sort((left, right) =>
            right.rows !== left.rows
                ? right.rows - left.rows
                : left.key < right.key
                  ? -1
                  : 1
        );
};

/**
 * How one policy version's selections differ from another's.
 *
 * This is the shape the rollout's exit condition asks for: not "is the Router
 * good" -- shadow data cannot answer that, and `ROUTE-01` is where that
 * question lives -- but "where would Auto send traffic under the new policy
 * that it did not send under the old one". Shares rather than counts, because
 * the two sides are never the same size; a model that appears on one side only
 * is kept with a zero on the other, since that is exactly the case the score
 * snapshot was widened for.
 *
 * Undecided rows are excluded from both sides for the same reason the
 * agreement rate excludes them: a turn with no candidate is not a different
 * choice. The counts stay visible so a policy that decided far less often
 * cannot hide behind a stable-looking distribution.
 *
 * Pure. The caller supplies rows; this decides what they mean.
 */
export function compareSelectionDistributions(
    rows: readonly ShadowRunRow[],
    {
        baseline,
        candidate,
        groupedBy = "selectionPolicyVersion",
    }: {
        baseline: string;
        candidate: string;
        groupedBy?: SelectionDistributionKey;
    }
): SelectionDistributionComparison {
    const countsFor = (value: string) => {
        const models: Record<string, number> = {};
        const reasons: Record<string, number> = {};
        let decided = 0;
        for (const row of rows) {
            if (distributionKeyOf(row, groupedBy) !== value) continue;
            reasons[row.selectionReason] = (reasons[row.selectionReason] ?? 0) + 1;
            if (row.selectedModelId === null) continue;
            decided += 1;
            models[row.selectedModelId] = (models[row.selectedModelId] ?? 0) + 1;
        }
        return { models, reasons, decided };
    };

    const left = countsFor(baseline);
    const right = countsFor(candidate);
    const comparable = left.decided > 0 && right.decided > 0;

    const modelIds = [
        ...new Set([...Object.keys(left.models), ...Object.keys(right.models)]),
    ];
    const models = modelIds
        .map((modelId) => {
            const baselineCount = left.models[modelId] ?? 0;
            const candidateCount = right.models[modelId] ?? 0;
            const baselineShare =
                left.decided === 0 ? 0 : baselineCount / left.decided;
            const candidateShare =
                right.decided === 0 ? 0 : candidateCount / right.decided;
            return {
                modelId,
                baselineCount,
                candidateCount,
                baselineShare,
                candidateShare,
                shareDelta: candidateShare - baselineShare,
            };
        })
        .sort((first, second) => {
            const byMove =
                Math.abs(second.shareDelta) - Math.abs(first.shareDelta);
            // Stable beyond the movement, so two runs over the same data print
            // the same order.
            return byMove !== 0
                ? byMove
                : first.modelId < second.modelId
                  ? -1
                  : 1;
        });

    return {
        groupedBy,
        baseline,
        candidate,
        baselineDecided: left.decided,
        candidateDecided: right.decided,
        models,
        totalVariationDistance: comparable
            ? models.reduce(
                  (total, entry) => total + Math.abs(entry.shareDelta),
                  0
              ) / 2
            : null,
        baselineSelectionReasons: left.reasons,
        candidateSelectionReasons: right.reasons,
        comparable,
    };
}
