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
 * One register entry -> either the values its `register_deadline` line prints,
 * or the list of fields that could not be printed. A rejected value is never
 * kept in any part, so a field that fails its rule cannot smuggle a token or a
 * line into the output -- or into the stage W digest, which is built from
 * these same entries (docs/policy/billing-finance-ops.md §1.1).
 */
const judgeEntry = (entry, index, now) => {
    const rejected = [];
    if (!passes(MODEL_ID_PATTERN, entry.modelId)) rejected.push("modelId");
    if (!passes(DATE_PATTERN, entry.registeredAt)) rejected.push("registeredAt");
    if (!passes(DATE_PATTERN, entry.expiresAt)) rejected.push("expiresAt");
    const ticket = encodeTicket(entry.verificationTicket);
    if (ticket === undefined) rejected.push("ticket");

    if (rejected.length > 0) return { kind: "rejected", index, fields: rejected };

    const remainingDays = daysUntil(entry.expiresAt, now);
    return {
        kind: "deadline",
        index,
        modelId: entry.modelId,
        registeredAt: entry.registeredAt,
        expiresAt: entry.expiresAt,
        remainingDays,
        mark: markFor(remainingDays),
        ticket,
    };
};

/**
 * The structured judgement the report and the stage W digest share: one entry
 * per register item in register order, and the verdict.
 */
export const judgePendingPriceDeadlines = ({ register, models, now }) => {
    const entries = register.map((entry, index) => judgeEntry(entry, index, now));
    const anyRejected = entries.some((entry) => entry.kind === "rejected");
    const anyMarked = entries.some((entry) => entry.kind === "deadline" && entry.mark !== "none");

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
    return { entries, verdict };
};

const entryLines = (entry) =>
    entry.kind === "rejected"
        ? entry.fields.map((field) => `register_value_rejected index=${entry.index} field=${field}`)
        : [
              [
                  "register_deadline",
                  `modelId=${entry.modelId}`,
                  `registeredAt=${entry.registeredAt}`,
                  `expiresAt=${entry.expiresAt}`,
                  `remainingDays=${entry.remainingDays === null ? "NONE" : entry.remainingDays}`,
                  `mark=${entry.mark}`,
                  `ticket=${entry.ticket}`,
              ].join(" "),
          ];

/**
 * The whole report. `lines` is complete before anything is printed, so a run
 * that throws prints nothing -- and in particular no `verdict=` line, which is
 * how a reader tells a broken script from a quiet register.
 */
export const buildPendingPriceDeadlineReport = ({ register, models, now }) => {
    const { entries, verdict } = judgePendingPriceDeadlines({ register, models, now });
    const lines = entries.flatMap(entryLines);
    lines.push(POLICY_QUOTE, `verdict=${verdict}`);
    return { lines, verdict, exitCode: EXIT_CODES[verdict] };
};
