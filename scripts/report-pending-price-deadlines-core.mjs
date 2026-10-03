// Deadline marks for the pending-price register, as a closed set of lines.
//
// docs/policy/billing-finance-ops.md section 2 is the contract this file
// implements: the line schema, the value encoding, the mark widths, the verdict
// and the exit code. Everything here is a pure function of the register, the
// model catalogue and `now`; the CLI next to it only supplies those three and
// prints.
//
// Nothing here decides anything about a price. `findPendingPriceRegisterProblems`
// and `daysUntil` stay the single source of the register's rules -- this file
// re-uses them and only adds the day-count marks, which the existing gate does
// not produce before the deadline.

import {
    daysUntil,
    findPendingPriceRegisterProblems,
} from "../lib/modelPricing.ts";

/** The only prose line the report prints (docs/policy/credit-and-cost-limits.md). */
export const POLICY_QUOTE = "기한만 미루는 것은 승인이 아닙니다";

export const EXIT_CODES = Object.freeze({
    quiet: 0,
    notice: 2,
    register_invalid: 2,
});

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// RFC 3986 unreserved characters; every other byte is percent-encoded.
const UNRESERVED_BYTE = /^[A-Za-z0-9._~-]$/;

/**
 * Mark for a remaining-day count. The widths are two days each and never
 * overlap, so a daily run that skips one day still lands on the mark.
 * `null` (an expiry the calendar cannot read) has no mark.
 */
export const markFor = (remainingDays) => {
    if (remainingDays === null) return "none";
    if (remainingDays <= 0) return "expired";
    if (remainingDays === 30 || remainingDays === 29) return "30";
    if (remainingDays === 14 || remainingDays === 13) return "14";
    if (remainingDays === 7 || remainingDays === 6) return "7";
    if (remainingDays === 2 || remainingDays === 1) return "1";
    return "none";
};

/**
 * `null` -> "NONE"; a string -> "s:" + its UTF-8 bytes with everything outside
 * the unreserved set written as %XX. Returns `undefined` when the value cannot
 * be encoded (not a string, or not well-formed UTF-16), which the caller turns
 * into a rejection rather than a guess.
 */
export const encodeTicket = (value) => {
    if (value === null) return "NONE";
    if (typeof value !== "string" || !value.isWellFormed()) return undefined;
    let encoded = "s:";
    for (const byte of new TextEncoder().encode(value)) {
        const character = String.fromCharCode(byte);
        encoded += UNRESERVED_BYTE.test(character)
            ? character
            : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return encoded;
};

const passes = (pattern, value) =>
    typeof value === "string" && pattern.test(value);

/**
 * One register entry -> either its `register_deadline` line, or the list of
 * fields that could not be printed. A rejected value is never printed in any
 * part, so a field that fails its rule cannot smuggle a token or a line into
 * the output.
 */
const entryLines = (entry, index, now) => {
    const rejected = [];
    if (!passes(MODEL_ID_PATTERN, entry.modelId)) rejected.push("modelId");
    if (!passes(DATE_PATTERN, entry.registeredAt)) rejected.push("registeredAt");
    if (!passes(DATE_PATTERN, entry.expiresAt)) rejected.push("expiresAt");
    const ticket = encodeTicket(entry.verificationTicket);
    if (ticket === undefined) rejected.push("ticket");

    if (rejected.length > 0) {
        return {
            rejected: true,
            mark: "none",
            lines: rejected.map(
                (field) => `register_value_rejected index=${index} field=${field}`
            ),
        };
    }

    const remainingDays = daysUntil(entry.expiresAt, now);
    const mark = markFor(remainingDays);
    return {
        rejected: false,
        mark,
        lines: [
            [
                "register_deadline",
                `modelId=${entry.modelId}`,
                `registeredAt=${entry.registeredAt}`,
                `expiresAt=${entry.expiresAt}`,
                `remainingDays=${remainingDays === null ? "NONE" : remainingDays}`,
                `mark=${mark}`,
                `ticket=${ticket}`,
            ].join(" "),
        ],
    };
};

/**
 * The whole report. `lines` is complete before anything is printed, so a run
 * that throws prints nothing -- and in particular no `verdict=` line, which is
 * how a reader tells a broken script from a quiet register.
 */
export const buildPendingPriceDeadlineReport = ({ register, models, now }) => {
    const lines = [];
    let anyRejected = false;
    let anyMarked = false;

    register.forEach((entry, index) => {
        const result = entryLines(entry, index, now);
        lines.push(...result.lines);
        anyRejected ||= result.rejected;
        anyMarked ||= result.mark !== "none";
    });

    // `expired` is the deadline itself, which the marks already report. The
    // other errors mean the register is malformed, and owner/ticket/approval
    // warnings are printed by check:model-pricing, not here.
    const registerError = findPendingPriceRegisterProblems({
        models,
        now,
        register,
    }).some((problem) => problem.severity === "error" && problem.reason !== "expired");

    const verdict =
        anyRejected || registerError
            ? "register_invalid"
            : anyMarked
              ? "notice"
              : "quiet";

    lines.push(POLICY_QUOTE, `verdict=${verdict}`);
    return { lines, verdict, exitCode: EXIT_CODES[verdict] };
};
