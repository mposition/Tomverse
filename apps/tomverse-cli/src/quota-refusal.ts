import type { GenerationRecord } from "./session.js";

export type ApiQuotaReason = "key_credit_cap_reached" | "PLAN_DAILY_CREDIT_LIMIT_REACHED" |
    "PLAN_ENTITLEMENT_EXHAUSTED" | "CREDIT_BALANCE_INSUFFICIENT";

function quotaReason(status: number | undefined, code: string | undefined): ApiQuotaReason | undefined {
    if (status === 429 && (code === "key_credit_cap_reached" || code === "PLAN_DAILY_CREDIT_LIMIT_REACHED")) return code;
    if (status === 402 && (code === "PLAN_ENTITLEMENT_EXHAUSTED" || code === "CREDIT_BALANCE_INSUFFICIENT")) return code;
}

export function quotaResetAt(value: unknown): string | undefined {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value ? value : undefined;
}

export function confirmedApiQuota(record: GenerationRecord | undefined) {
    const requestId = record?.requestId;
    if (!record || record.closed !== true || record.error?.kind !== "http" || typeof requestId !== "string" ||
        !/^req_[0-9a-f]{32}$/.test(requestId)) return undefined;
    const reason = quotaReason(record.httpStatus, record.error.code);
    if (!reason) return undefined;
    const { lookup, receipt } = record;
    const noCharge = lookup === "not_found" && !receipt ||
        lookup === "found" && receipt?.requestId === requestId && receipt.status === "released" &&
        receipt.chargedCredits === 0;
    if (!noCharge) return undefined;
    return { reason, requestId, ...(reason === "key_credit_cap_reached" ? {} : { resetAt: quotaResetAt(record.error.resetAt) }) };
}
