import type { ContinuationSeedPlan } from "./externalContinuationSeedCore";

export const CONTINUATION_RECEIPT_HEADER = "X-Chat-Continuation-Receipt";
export type ContinuationReceipt = {
    traceId: string;
    assistantMessageId: string;
    attempt: number;
    mode: "automatic" | "selected_recent";
    status: "not_sent" | "dispatched" | "unknown";
    outcome: string;
    plannerVersion: string;
    selectedCount: number;
    recentCount: number;
    uniqueMessageCount: number;
    partial: boolean;
    omitted: boolean;
};

/** Counts come from the exact final plan, never a bridge's creation snapshot. */
export function continuationReceipt(input: {
    traceId: string; assistantMessageId: string; attempt?: number;
    selected: boolean; outcome: string; plan?: ContinuationSeedPlan | null;
    status?: ContinuationReceipt["status"];
}): ContinuationReceipt {
    const plan = input.plan;
    return {
        traceId: input.traceId, assistantMessageId: input.assistantMessageId, attempt: input.attempt ?? 0,
        mode: input.selected ? "selected_recent" : "automatic", status: input.status ?? "not_sent",
        outcome: input.outcome, plannerVersion: plan?.seedVersion ?? "none",
        selectedCount: plan?.turns.filter(turn => turn.selectedRanges?.length).length ?? 0,
        recentCount: plan?.turns.filter(turn => turn.recentRanges?.length || !input.selected).length ?? 0,
        uniqueMessageCount: plan?.turns.length ?? 0,
        partial: (plan?.truncatedCount ?? 0) > 0,
        omitted: (plan?.omittedByBudgetCount ?? 0) > 0 || (plan?.sourceMessageCount ?? 0) > (plan?.turns.length ?? 0),
    };
}

export function parseContinuationReceipt(value: unknown): ContinuationReceipt | undefined {
    try {
        const r = typeof value === "string" ? JSON.parse(value) : value;
        if (!r || typeof r !== "object" ||
            !["automatic", "selected_recent"].includes(r.mode) ||
            !["not_sent", "dispatched", "unknown"].includes(r.status) ||
            ![r.traceId, r.assistantMessageId, r.outcome, r.plannerVersion].every(v => typeof v === "string" && v.length <= 100) ||
            ![r.attempt, r.selectedCount, r.recentCount, r.uniqueMessageCount].every(v => Number.isSafeInteger(v) && v >= 0) ||
            typeof r.partial !== "boolean" || typeof r.omitted !== "boolean") return undefined;
        return { traceId: r.traceId, assistantMessageId: r.assistantMessageId, attempt: r.attempt,
            mode: r.mode, status: r.status, outcome: r.outcome, plannerVersion: r.plannerVersion,
            selectedCount: r.selectedCount, recentCount: r.recentCount, uniqueMessageCount: r.uniqueMessageCount,
            partial: r.partial, omitted: r.omitted };
    } catch { return undefined; }
}

export function receiptForAttempt(value: unknown, traceId: string | null, assistantMessageId: string,
    previous?: ContinuationReceipt): ContinuationReceipt | undefined {
    const receipt = parseContinuationReceipt(value);
    if (!receipt || receipt.traceId !== traceId || receipt.assistantMessageId !== assistantMessageId ||
        (previous && previous.traceId === receipt.traceId && receipt.attempt < previous.attempt)) return undefined;
    return receipt;
}

/** A prepared plan is not actual coverage when dispatch never happened. */
export function deliveryReceipt(receipt: ContinuationReceipt): ContinuationReceipt {
    return receipt.status === "not_sent" ? { ...receipt, selectedCount: 0, recentCount: 0,
        uniqueMessageCount: 0, partial: false, omitted: false } : { ...receipt };
}
