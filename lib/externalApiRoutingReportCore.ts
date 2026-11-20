/**
 * The daily coding routing report: what Smart Adaptive did on the external API
 * (docs/policy/external-api.md, section 5.1), from the request receipts only.
 * Counts, shares and model ids; no request text exists to read. Pure: the
 * caller reads the rows (lib/externalApiRoutingReport.ts).
 *
 * It answers the questions the router change was made for: does Smart
 * Adaptive still send everything to one model (topModelShare), how often a
 * cheaper pick is held, how often a conversation changes model, and whether
 * the routed requests fail more than the rest.
 */

export type RoutingReportRow = {
    createdAt: Date;
    modelId: string;
    protocol: string;
    /** router | continued | default; null for a model named directly. */
    routedBy: string | null;
    routedHeld: boolean | null;
    routeConversation: string | null;
    errorCode: string | null;
    finishReason: string | null;
    /** Settled credits when known, otherwise the reservation's. */
    credits: number | null;
};

export type CodingRoutingReport = {
    window: { since: string; until: string };
    /** Smart Adaptive requests. */
    requests: number;
    /** Requests that named a model directly, for scale. */
    namedRequests: number;
    byRoutedBy: { router: number; continued: number; default: number };
    /** Share of Smart Adaptive requests whose cheaper pick the conversation held. */
    heldShare: number;
    byProtocol: Record<string, number>;
    byModel: { modelId: string; count: number; share: number; credits: number }[];
    /** The largest model's share of Smart Adaptive requests: 1 means one model took all. */
    topModelShare: number;
    conversations: { count: number; meanRequests: number; withModelChange: number };
    errorShare: number;
    errors: { code: string; count: number }[];
    credits: number;
    /** The window held more Smart Adaptive requests than were read. */
    truncated?: boolean;
};

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);

export const CODING_ROUTING_REPORT_TOP_ERRORS = 5;

export const summarizeCodingRouting = (
    rows: readonly RoutingReportRow[],
    window: { since: Date; until: Date }
): CodingRoutingReport => {
    const routed = rows.filter((row) => row.routedBy !== null);
    const byRoutedBy = { router: 0, continued: 0, default: 0 };
    const byProtocol: Record<string, number> = {};
    const models = new Map<string, { count: number; credits: number }>();
    const conversations = new Map<string, { at: number; modelId: string }[]>();
    const errors = new Map<string, number>();
    let held = 0;
    let failed = 0;
    let credits = 0;
    for (const row of routed) {
        if (row.routedBy === "router" || row.routedBy === "continued" || row.routedBy === "default") {
            byRoutedBy[row.routedBy] += 1;
        }
        if (row.routedHeld) held += 1;
        byProtocol[row.protocol] = (byProtocol[row.protocol] ?? 0) + 1;
        const model = models.get(row.modelId) ?? { count: 0, credits: 0 };
        model.count += 1;
        model.credits += row.credits ?? 0;
        models.set(row.modelId, model);
        credits += row.credits ?? 0;
        if (row.routeConversation) {
            const list = conversations.get(row.routeConversation) ?? [];
            list.push({ at: row.createdAt.getTime(), modelId: row.modelId });
            conversations.set(row.routeConversation, list);
        }
        if (row.errorCode) {
            failed += 1;
            errors.set(row.errorCode, (errors.get(row.errorCode) ?? 0) + 1);
        }
    }
    const byModel = [...models.entries()]
        .map(([modelId, value]) => ({ modelId, count: value.count, share: share(value.count, routed.length), credits: value.credits }))
        .sort((a, b) => b.count - a.count || a.modelId.localeCompare(b.modelId));
    const withModelChange = [...conversations.values()].filter((list) => new Set(list.map((item) => item.modelId)).size > 1).length;
    const inConversations = [...conversations.values()].reduce((sum, list) => sum + list.length, 0);
    return {
        window: { since: window.since.toISOString(), until: window.until.toISOString() },
        requests: routed.length,
        namedRequests: rows.length - routed.length,
        byRoutedBy,
        heldShare: share(held, routed.length),
        byProtocol,
        byModel,
        topModelShare: byModel.length ? byModel[0].share : 0,
        conversations: {
            count: conversations.size,
            meanRequests: conversations.size ? Math.round((inConversations / conversations.size) * 10) / 10 : 0,
            withModelChange,
        },
        errorShare: share(failed, routed.length),
        errors: [...errors.entries()]
            .map(([code, count]) => ({ code, count }))
            .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
            .slice(0, CODING_ROUTING_REPORT_TOP_ERRORS),
        credits,
    };
};
