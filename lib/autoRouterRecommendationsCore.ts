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

export const RECOMMENDATION_STATUSES = ["open", "done", "dismissed"] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** Guidance recommendations are applied by their own cycle; only these two wait for a person. */
export const ACTIONABLE_RECOMMENDATION_KINDS = ["code", "setting"] as const;
export type ActionableRecommendationKind = (typeof ACTIONABLE_RECOMMENDATION_KINDS)[number];

export const isRecommendationStatus = (value: unknown): value is RecommendationStatus =>
    typeof value === "string" && (RECOMMENDATION_STATUSES as readonly string[]).includes(value);

const isActionableKind = (value: unknown): value is ActionableRecommendationKind =>
    typeof value === "string" && (ACTIONABLE_RECOMMENDATION_KINDS as readonly string[]).includes(value);

export type RecommendationStatusEntry = { status: RecommendationStatus; at: string; by: string };

export type ActionableRecommendation = {
    /** Place in the report's recommendations; the key of its status entry. */
    index: number;
    kind: ActionableRecommendationKind;
    text: string;
    status: RecommendationStatus;
    at: string | null;
    by: string | null;
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
        if (!isRecommendationStatus(value.status)) continue;
        if (typeof value.at !== "string" || typeof value.by !== "string") continue;
        entries.set(index, { status: value.status, at: value.at, by: value.by });
    }
    return entries;
};

/** The report's code and setting recommendations with their status; guidance ones are left out. */
export const actionableRecommendations = (summary: unknown): ActionableRecommendation[] => {
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
                status: entry?.status ?? "open",
                at: entry?.at ?? null,
                by: entry?.by ?? null,
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
 * The open recommendations across cycles, newest cycle first and in report
 * order within one. The caller says how many cycles it read: the list is only
 * as wide as that (docs/ui-contracts/admin-console-ia.md rule 6).
 */
export const openRecommendations = (
    cycles: readonly { id: string; createdAt: string; summary: unknown }[]
): OpenRecommendation[] =>
    [...cycles]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .flatMap((cycle) =>
            actionableRecommendations(cycle.summary)
                .filter((item) => item.status === "open")
                .map((item) => ({ ...item, cycleId: cycle.id, createdAt: cycle.createdAt }))
        );

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
