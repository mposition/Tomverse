/**
 * The daily image routing report (image routing improvement agent, stage 1):
 * what Chat's image routing decided and how the images it chose turned out,
 * from content-free rows only -- decisions (ImageRoutingDecision), generations
 * (ImageGeneration: status, failure phase, timing, attempt), their cost
 * (ImageCreditReservation) and what people did with them
 * (ImageGenerationSignal). Pure: lib/imageRoutingReport.ts reads the rows.
 */

export type ImageDecisionRow = {
    source: string;
    outcome: string;
    imageModelId: string | null;
    preset: string | null;
    edit: boolean;
    followUp: boolean;
    modelFallback: boolean;
    linked: boolean;
};

export type ImageGenerationRow = {
    modelId: string;
    preset: string;
    status: string;
    failurePhase: string | null;
    attemptNumber: number;
    startedAt: Date | null;
    completedAt: Date | null;
    /** Settled cost of a succeeded image, µUSD; null when not settled. */
    costMicroUsd: number | null;
    /** Signal kinds people left on this image. */
    signals: readonly string[];
};

export type ImageModelReport = {
    modelId: string;
    generations: number;
    succeeded: number;
    failed: number;
    failureShare: number;
    failurePhases: Record<string, number>;
    retries: number;
    latencySeconds: { p50: number | null; p90: number | null };
    costPerSuccessMicroUsd: number | null;
    signals: Record<string, number>;
    /** helpful / (helpful + not_helpful), null without either. */
    helpfulShare: number | null;
};

export type ImageRoutingReport = {
    window: { since: string; until: string };
    decisions: {
        total: number;
        byOutcome: Record<string, number>;
        bySource: Record<string, number>;
        /** Image decisions per chosen model, with the default's share. */
        byModel: { modelId: string; count: number; share: number }[];
        fallbackShare: number;
        followUpShare: number;
        editShare: number;
        /** Image decisions whose group was linked (the turn was sent). */
        linkedShare: number;
    };
    models: ImageModelReport[];
    /** wanted_text signals: images people said should have been text answers. */
    wantedText: number;
};

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);

const percentile = (sorted: readonly number[], p: number): number | null => {
    if (sorted.length === 0) return null;
    const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return Math.round(sorted[at] * 10) / 10;
};

const count = (map: Record<string, number>, key: string) => {
    map[key] = (map[key] ?? 0) + 1;
};

export const summarizeImageRouting = (
    decisions: readonly ImageDecisionRow[],
    generations: readonly ImageGenerationRow[],
    window: { since: Date; until: Date }
): ImageRoutingReport => {
    const byOutcome: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const chosen: Record<string, number> = {};
    for (const decision of decisions) {
        count(byOutcome, decision.outcome);
        count(bySource, decision.source);
        if (decision.outcome === "image") count(chosen, decision.imageModelId ?? "(default)");
    }
    const images = decisions.filter((decision) => decision.outcome === "image");

    const models = new Map<string, ImageGenerationRow[]>();
    for (const row of generations) models.set(row.modelId, [...(models.get(row.modelId) ?? []), row]);
    let wantedText = 0;
    const reports = [...models.entries()].map(([modelId, rows]): ImageModelReport => {
        const succeeded = rows.filter((row) => row.status === "succeeded");
        const failed = rows.filter((row) => row.status === "failed");
        const failurePhases: Record<string, number> = {};
        for (const row of failed) count(failurePhases, row.failurePhase ?? "unknown");
        const latencies = succeeded
            .flatMap((row) => (row.startedAt && row.completedAt ? [(row.completedAt.getTime() - row.startedAt.getTime()) / 1000] : []))
            .filter((value) => Number.isFinite(value) && value >= 0)
            .sort((a, b) => a - b);
        const costs = succeeded.flatMap((row) => (row.costMicroUsd !== null && row.costMicroUsd >= 0 ? [row.costMicroUsd] : []));
        const signals: Record<string, number> = {};
        for (const row of rows) for (const kind of row.signals) count(signals, kind);
        wantedText += signals.wanted_text ?? 0;
        const rated = (signals.helpful ?? 0) + (signals.not_helpful ?? 0);
        return {
            modelId,
            generations: rows.length,
            succeeded: succeeded.length,
            failed: failed.length,
            failureShare: share(failed.length, succeeded.length + failed.length),
            failurePhases,
            retries: rows.filter((row) => row.attemptNumber > 1).length,
            latencySeconds: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9) },
            costPerSuccessMicroUsd: costs.length ? Math.round(costs.reduce((sum, value) => sum + value, 0) / costs.length) : null,
            signals,
            helpfulShare: rated ? share(signals.helpful ?? 0, rated) : null,
        };
    });
    reports.sort((a, b) => b.generations - a.generations || a.modelId.localeCompare(b.modelId));

    return {
        window: { since: window.since.toISOString(), until: window.until.toISOString() },
        decisions: {
            total: decisions.length,
            byOutcome,
            bySource,
            byModel: Object.entries(chosen)
                .map(([modelId, value]) => ({ modelId, count: value, share: share(value, images.length) }))
                .sort((a, b) => b.count - a.count || a.modelId.localeCompare(b.modelId)),
            fallbackShare: share(images.filter((decision) => decision.modelFallback).length, images.length),
            followUpShare: share(images.filter((decision) => decision.followUp).length, images.length),
            editShare: share(images.filter((decision) => decision.edit).length, images.length),
            linkedShare: share(images.filter((decision) => decision.linked).length, images.length),
        },
        models: reports,
        wantedText,
    };
};
