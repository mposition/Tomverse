/**
 * Offline-only reconciliation of a preregistered vNext case ledger. This
 * counts content-free slots; it does not verify a manifest or authorize a run.
 */
// plannedN is self-declared here; bind it to a sealed manifest before any future pass.
// Accept trusted parsed data at the boundary; JS shape checks cannot rule out Proxy traps.

// Proposed slot-universe bound for this offline parser, not an approved quality gate.
export const PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES = 40;
export const PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES =
    2 * PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES;

const CASE_ID_PATTERN = /^prsvnext-(ko|en)-([0-9]{3})$/;

export type PromptRefinerVnextSlotStatus =
    | "suggested"
    | "abstained"
    | "failed"
    | "unknown"
    | "not_dispatched";

export type PromptRefinerVnextAggregate = Readonly<{
    plannedN: number;
    counts: Readonly<Record<PromptRefinerVnextSlotStatus, number>>;
    attemptedCount: number;
    terminalCount: number;
    verdict: "fail" | "insufficient_evidence";
}>;

const SLOT_STATUSES = new Set<PromptRefinerVnextSlotStatus>([
    "suggested",
    "abstained",
    "failed",
    "unknown",
    "not_dispatched",
]);

function fail(code: string): never {
    throw new Error(code);
}

function ownDataObject(
    value: unknown,
    fields: readonly string[],
    code: string
): Record<string, unknown> {
    try {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return fail(code);
        }
        const prototype = Object.getPrototypeOf(value);
        const keys = Reflect.ownKeys(value);
        if (
            (prototype !== Object.prototype && prototype !== null) ||
            keys.length !== fields.length ||
            fields.some((field) => !keys.includes(field))
        ) {
            return fail(code);
        }
        const result: Record<string, unknown> = Object.create(null);
        for (const field of fields) {
            const descriptor = Object.getOwnPropertyDescriptor(value, field);
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                return fail(code);
            }
            result[field] = descriptor.value;
        }
        return result;
    } catch {
        return fail(code);
    }
}

function ownDataArray(value: unknown, expectedLength: number): unknown[] {
    const code = "vnext_aggregate_slots_invalid";
    let length: number;
    try {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
            return fail(code);
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (!lengthDescriptor || !("value" in lengthDescriptor)) {
            return fail(code);
        }
        length = lengthDescriptor.value as number;
    } catch {
        return fail(code);
    }
    if (length !== expectedLength) {
        return fail("vnext_aggregate_slot_count_mismatch");
    }
    try {
        if (Reflect.ownKeys(value).length !== length + 1) {
            return fail(code);
        }
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                return fail(code);
            }
            result.push(descriptor.value);
        }
        return result;
    } catch {
        return fail(code);
    }
}

/**
 * Every planned case has exactly one explicit slot status. Incomplete runs use
 * `not_dispatched`; they cannot shrink the denominator by omitting a slot.
 */
export function reconcilePromptRefinerVnextAggregate(
    value: unknown
): PromptRefinerVnextAggregate {
    const ledger = ownDataObject(
        value,
        ["plannedN", "slots"],
        "vnext_aggregate_ledger_invalid"
    );
    const plannedN = ledger.plannedN;
    if (
        !Number.isSafeInteger(plannedN) ||
        (plannedN as number) < 1 ||
        (plannedN as number) > PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES
    ) {
        return fail("vnext_aggregate_planned_n_invalid");
    }
    const slots = ownDataArray(ledger.slots, plannedN as number);

    const counts: Record<PromptRefinerVnextSlotStatus, number> = {
        suggested: 0,
        abstained: 0,
        failed: 0,
        unknown: 0,
        not_dispatched: 0,
    };
    const caseIds = new Set<string>();
    const languageCounts = { ko: 0, en: 0 };
    for (const slotValue of slots) {
        const slot = ownDataObject(
            slotValue,
            ["caseId", "status"],
            "vnext_aggregate_slot_invalid"
        );
        if (typeof slot.caseId !== "string") {
            return fail("vnext_aggregate_case_id_invalid");
        }
        const caseIdMatch = CASE_ID_PATTERN.exec(slot.caseId);
        const caseNumber = caseIdMatch ? Number(caseIdMatch[2]) : NaN;
        if (
            !caseIdMatch ||
            caseIdMatch[0] !== slot.caseId ||
            caseNumber < 1 ||
            caseNumber > PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES
        ) {
            return fail("vnext_aggregate_case_id_invalid");
        }
        if (caseIds.has(slot.caseId)) {
            return fail("vnext_aggregate_duplicate_case_id");
        }
        caseIds.add(slot.caseId);
        languageCounts[caseIdMatch[1] === "ko" ? "ko" : "en"]++;
        if (!SLOT_STATUSES.has(slot.status as PromptRefinerVnextSlotStatus)) {
            return fail("vnext_aggregate_status_invalid");
        }
        counts[slot.status as PromptRefinerVnextSlotStatus]++;
    }
    // Smaller N values are partial diagnostics. For full N, exact ID range and
    // uniqueness already imply 40/40; keep this as defence against future drift.
    if (
        plannedN === PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES &&
        (languageCounts.ko !== PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES ||
            languageCounts.en !== PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES)
    ) {
        return fail("vnext_aggregate_full_language_count_mismatch");
    }
    const terminalCount = counts.suggested + counts.abstained + counts.failed;
    const attemptedCount = terminalCount + counts.unknown;
    return Object.freeze({
        plannedN: plannedN as number,
        counts: Object.freeze({ ...counts }),
        attemptedCount,
        terminalCount,
        verdict: counts.failed > 0 ? "fail" : "insufficient_evidence",
    });
}
