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

export type ShadowRunRow = {
    taskProfileVersion: string;
    candidateFilterVersion: string;
    selectionVersion: string;
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
    /** True when any of the three has more than one value in the sample. */
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
            mixed:
                taskProfileVersions.length > 1 ||
                candidateFilterVersions.length > 1 ||
                selectionVersions.length > 1,
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
