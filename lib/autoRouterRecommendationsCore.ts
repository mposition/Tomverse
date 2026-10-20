/**
 * The operator's handling of an Auto router optimizer cycle's recommendations.
 *
 * A cycle's report (summary.report, lib/autoRouterOptimizerCore.ts) carries
 * recommendations of three kinds. A `guidance` one is already part of the same
 * cycle's proposed guidance. A `code` or `setting` one is only displayed, so it
 * gets a status an operator sets in Admin -- open (the default), done, or
 * dismissed -- and a deterministic work instruction to paste into a coding
 * session. No model is called here, and nothing leaves Admin.
 *
 * The status rides in the cycle's summary JSON as
 * `recommendationStatus: { "<index>": { status, at, by } }`, where the index
 * is the recommendation's place in `report.recommendations`. A recommendation
 * with no entry is open. No migration: the summary column already holds the
 * report.
 *
 * Pure, so the whole decision runs under test without a database.
 */

/** What an operator may set in Admin. */
export const RECOMMENDATION_STATUSES = ["open", "done", "dismissed"] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/**
 * What only the coding agent's internal API sets (owner approval 2026-10-20:
 * an agent on the Ubuntu runner may open develop PRs on its own; merging stays
 * a person's). It takes an open code recommendation (claimed), then reports a
 * PR or a failure. An operator can still set any of the three above over them.
 */
export const AGENT_RECOMMENDATION_STATUSES = ["claimed", "pr_opened", "failed"] as const;
export type AgentRecommendationStatus = (typeof AGENT_RECOMMENDATION_STATUSES)[number];
export type StoredRecommendationStatus = RecommendationStatus | AgentRecommendationStatus;

/**
 * As shown: a claim whose lease ran out with no result is needs_lookup. It is
 * derived, never stored, and never turned back into open by itself -- the
 * agent may have pushed and opened a PR it could not report, so a person
 * looks before the recommendation is offered again.
 */
export type DisplayedRecommendationStatus = StoredRecommendationStatus | "needs_lookup";

const STORED_RECOMMENDATION_STATUSES: readonly string[] = [
    ...RECOMMENDATION_STATUSES,
    ...AGENT_RECOMMENDATION_STATUSES,
];

/** How long the agent holds a claim before it shows as needs_lookup. */
export const REC_AGENT_LEASE_MS = 2 * 60 * 60 * 1000;

/** Why the agent did not open a PR; a closed list, so the report cannot carry prose. */
export const RECOMMENDATION_FAILURE_REASONS = [
    "out_of_scope",
    "no_change",
    "tests",
    "review_reject",
    "review_unknown",
    "timeout",
    "agent_error",
    // What the runner on the Ubuntu host can tell besides (tools/auto-rec-agent/lib/contract.mjs).
    "lease_expired",
    "setup_failed",
    "runner_error",
    "rate_limited",
    "push_rejected",
    "push_failed",
    "pr_failed",
] as const;
export type RecommendationFailureReason = (typeof RECOMMENDATION_FAILURE_REASONS)[number];

/** The one repository the agent may open a PR in. */
const PR_URL = /^https:\/\/github\.com\/mposition\/Tomverse\/pull\/[1-9][0-9]{0,6}$/;

export const admitRecommendationPrUrl = (value: unknown): string | null =>
    typeof value === "string" && PR_URL.test(value) ? value : null;

/** Guidance recommendations are applied by their own cycle; only these two wait for a person. */
export const ACTIONABLE_RECOMMENDATION_KINDS = ["code", "setting"] as const;
export type ActionableRecommendationKind = (typeof ACTIONABLE_RECOMMENDATION_KINDS)[number];

export const isRecommendationStatus = (value: unknown): value is RecommendationStatus =>
    typeof value === "string" && (RECOMMENDATION_STATUSES as readonly string[]).includes(value);

const isStoredRecommendationStatus = (value: unknown): value is StoredRecommendationStatus =>
    typeof value === "string" && STORED_RECOMMENDATION_STATUSES.includes(value);

const isActionableKind = (value: unknown): value is ActionableRecommendationKind =>
    typeof value === "string" && (ACTIONABLE_RECOMMENDATION_KINDS as readonly string[]).includes(value);

export type RecommendationStatusEntry = {
    status: StoredRecommendationStatus;
    at: string;
    by: string;
    /** claimed only: when the claim shows as needs_lookup. */
    leaseUntil?: string;
    /**
     * Issued with each claim and kept on its result: a result is stored only
     * against the claim it names, so a late result of an earlier claim of the
     * same recommendation never lands on a later one.
     */
    claimId?: string;
    /** pr_opened only. */
    prUrl?: string;
    /** failed only. */
    reason?: RecommendationFailureReason;
};

export type ActionableRecommendation = {
    /** Place in the report's recommendations; the key of its status entry. */
    index: number;
    kind: ActionableRecommendationKind;
    text: string;
    status: DisplayedRecommendationStatus;
    at: string | null;
    by: string | null;
    prUrl: string | null;
    reason: string | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The stored status entries, ignoring any that are malformed. */
export const recommendationStatusEntries = (summary: unknown): Map<number, RecommendationStatusEntry> => {
    const entries = new Map<number, RecommendationStatusEntry>();
    const stored = record(record(summary)?.recommendationStatus);
    if (!stored) return entries;
    for (const [key, raw] of Object.entries(stored)) {
        const index = Number(key);
        const value = record(raw);
        if (!Number.isInteger(index) || index < 0 || !value) continue;
        if (!isStoredRecommendationStatus(value.status)) continue;
        if (typeof value.at !== "string" || typeof value.by !== "string") continue;
        entries.set(index, {
            status: value.status,
            at: value.at,
            by: value.by,
            ...(typeof value.leaseUntil === "string" ? { leaseUntil: value.leaseUntil } : {}),
            ...(typeof value.claimId === "string" ? { claimId: value.claimId } : {}),
            ...(typeof value.prUrl === "string" ? { prUrl: value.prUrl } : {}),
            ...((RECOMMENDATION_FAILURE_REASONS as readonly unknown[]).includes(value.reason)
                ? { reason: value.reason as RecommendationFailureReason }
                : {}),
        });
    }
    return entries;
};

/** A stored entry as shown at `now`: an expired claim is needs_lookup. */
export const displayedRecommendationStatus = (
    entry: RecommendationStatusEntry | undefined,
    now: number
): DisplayedRecommendationStatus => {
    if (!entry) return "open";
    if (entry.status === "claimed") {
        const until = entry.leaseUntil ? Date.parse(entry.leaseUntil) : Number.NaN;
        if (!Number.isFinite(until) || until <= now) return "needs_lookup";
    }
    return entry.status;
};

/** The report's code and setting recommendations with their status; guidance ones are left out. */
export const actionableRecommendations = (summary: unknown, now: number = Date.now()): ActionableRecommendation[] => {
    const recommendations = record(record(summary)?.report)?.recommendations;
    if (!Array.isArray(recommendations)) return [];
    const entries = recommendationStatusEntries(summary);
    return recommendations.flatMap((item, index): ActionableRecommendation[] => {
        const value = record(item);
        if (!value || !isActionableKind(value.kind) || typeof value.text !== "string") return [];
        const entry = entries.get(index);
        return [
            {
                index,
                kind: value.kind,
                text: value.text,
                status: displayedRecommendationStatus(entry, now),
                at: entry?.at ?? null,
                by: entry?.by ?? null,
                prUrl: entry?.prUrl ?? null,
                reason: entry?.reason ?? null,
            },
        ];
    });
};

/** The report's findings, as the cycle stored them. */
export const reportFindings = (summary: unknown): string[] => {
    const findings = record(record(summary)?.report)?.findings;
    return Array.isArray(findings) ? findings.filter((item): item is string => typeof item === "string") : [];
};

/**
 * The summary with one recommendation's status set. Every other field,
 * including the other recommendations' statuses, is kept as it was.
 */
export const withRecommendationStatus = (
    summary: unknown,
    index: number,
    entry: RecommendationStatusEntry
): Record<string, unknown> => {
    const base = record(summary) ?? {};
    const stored = record(base.recommendationStatus) ?? {};
    return { ...base, recommendationStatus: { ...stored, [String(index)]: entry } };
};

export type OpenRecommendation = ActionableRecommendation & { cycleId: string; createdAt: string };

/**
 * The recommendations that still need a person or the agent -- everything not
 * marked done or dismissed -- newest cycle first and in report order within
 * one. The caller says how many cycles it read: the list is only as wide as
 * that (docs/ui-contracts/admin-console-ia.md rule 6).
 */
export const openRecommendations = (
    cycles: readonly { id: string; createdAt: string; summary: unknown }[],
    now: number = Date.now()
): OpenRecommendation[] =>
    [...cycles]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .flatMap((cycle) =>
            actionableRecommendations(cycle.summary, now)
                .filter((item) => item.status !== "done" && item.status !== "dismissed")
                .map((item) => ({ ...item, cycleId: cycle.id, createdAt: cycle.createdAt }))
        );

/**
 * The next recommendation the coding agent may take: the oldest open `code`
 * one across the cycles given (oldest cycle first, report order within one).
 * Setting recommendations are not code; they are applied elsewhere or by a
 * person.
 */
export const nextClaimableRecommendation = (
    cycles: readonly { id: string; createdAt: string; summary: unknown }[],
    now: number
): (ActionableRecommendation & { cycleId: string; createdAt: string }) | null => {
    for (const cycle of [...cycles].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
        const item = actionableRecommendations(cycle.summary, now).find(
            (candidate) => candidate.kind === "code" && candidate.status === "open"
        );
        if (item) return { ...item, cycleId: cycle.id, createdAt: cycle.createdAt };
    }
    return null;
};

export type RecommendationResultInput = { claimId: string } & (
    | { outcome: "pr_opened"; prUrl: string }
    | { outcome: "failed"; reason: RecommendationFailureReason }
);

/**
 * Whether the agent's result may be stored over the current entry. Only the
 * claim the result names takes it -- expired or not, since the result is what
 * happened. The same result of the same claim again is a replay; anything else
 * (another claim, the operator reopened or closed it meanwhile, or a different
 * result) is refused and changes nothing.
 */
export const recommendationResultDecision = (
    current: RecommendationStatusEntry | undefined,
    input: RecommendationResultInput
): "apply" | "replay" | "not_claimed" => {
    if (!current?.claimId || current.claimId !== input.claimId) return "not_claimed";
    if (current.status === "claimed") return "apply";
    if (input.outcome === "pr_opened" && current.status === "pr_opened" && current.prUrl === input.prUrl) {
        return "replay";
    }
    if (input.outcome === "failed" && current.status === "failed" && current.reason === input.reason) {
        return "replay";
    }
    return "not_claimed";
};

/**
 * Copies text with the browser clipboard, or says it could not. A missing
 * clipboard (an insecure page) and a refused write both end the same way: the
 * caller shows the text in a box the operator can select.
 */
export const copyToClipboard = async (
    clipboard: { writeText: (text: string) => Promise<void> } | undefined,
    text: string
): Promise<"copied" | "manual"> => {
    try {
        if (!clipboard) return "manual";
        await clipboard.writeText(text);
        return "copied";
    } catch {
        return "manual";
    }
};

/** Where in the repository a recommendation of each kind is usually carried out. */
export const RECOMMENDATION_FILE_HINTS: Record<ActionableRecommendationKind, readonly string[]> = {
    code: [
        "lib/autoLlmRouter*.ts",
        "lib/autoRouterOptimizer*.ts",
        "lib/autoRewriteOptimizer*.ts",
        "app/api/admin/auto-llm-router/**/route.ts",
    ],
    setting: [
        "lib/autoLlmRouterSettings.ts",
        "components/admin/AdminAutoLlmRouterPanel.tsx",
        "components/admin/AdminAutoRouterOptimizerPanel.tsx",
    ],
};

/** The words around the facts in an instruction; the console's language supplies them. */
export type RecommendationInstructionLabels = {
    heading: string;
    kind: string;
    cycle: string;
    target: string;
    targetName: string;
    date: string;
    admin: string;
    findings: string;
    noFindings: string;
    files: string;
    closing: string;
};

/**
 * The instruction an operator pastes into a coding session. Built from the
 * stored report only -- the recommendation, the cycle's findings, where the
 * cycle is and where such work usually lands -- so it carries no user message
 * and needs no model call. The report was admitted without any quote of a
 * conversation (admitOptimizerReport), and nothing else is read.
 */
export const buildRecommendationInstruction = (input: {
    labels: RecommendationInstructionLabels;
    recommendation: { kind: ActionableRecommendationKind; text: string };
    findings: readonly string[];
    cycle: { id: string; createdAt: string };
    /** Where the cycle is shown in Admin. */
    link: string;
}): string => {
    const { labels, recommendation, findings, cycle, link } = input;
    return [
        `# ${labels.heading}`,
        "",
        recommendation.text,
        "",
        `- ${labels.kind}: ${recommendation.kind}`,
        `- ${labels.cycle}: ${cycle.id}`,
        `- ${labels.target}: ${labels.targetName}`,
        `- ${labels.date}: ${cycle.createdAt}`,
        `- ${labels.admin}: ${link}`,
        "",
        `${labels.findings}:`,
        ...(findings.length > 0 ? findings.map((finding) => `- ${finding}`) : [`- ${labels.noFindings}`]),
        "",
        `${labels.files}:`,
        ...RECOMMENDATION_FILE_HINTS[recommendation.kind].map((hint) => `- ${hint}`),
        "",
        labels.closing,
    ].join("\n");
};
