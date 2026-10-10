// The instant a read-only invariant report was taken, for the release record.
//
// Why this exists: on 2026-10-09 the constraint-investigation rows (7.7 and
// 7.7a) of `.github/audits/release-2026-10-09__570f9e1b.md` were closed with
// one piece of evidence missing -- *when* the reading happened. The output
// carried no timestamp, so the record could name only the date, and the only
// other instant on the page was the deployment's. Borrowing that one would
// have stated a time nobody observed, so the row says the run time was not
// captured. This module is what makes the next reading carry its own.
//
// The section symbol is left off those two row numbers deliberately:
// check:policy-section-references resolves a cited section against
// docs/policy/*.md, and a citation pointing outside that set needs an entry in
// its NON_POLICY_REFERENCES list. The row lives in a release record, its path
// is written right beside the numbers, and an exception whose only reason was
// the symbol would not be a reason.
//
// Two decisions are deliberate.
//
// **The clock is the database's, not the workstation's.** The reading is about
// rows whose own timestamps are on that clock, and the operator's PC clock is
// not evidence of anything -- it is unverified, and a release record that
// quoted it would be quoting the wrong machine. Asking the database also
// proves it answered at that instant.
//
// **An unavailable instant is stated, never substituted.** If the extra SELECT
// fails, these helpers say the instant was not captured. Falling back to
// `new Date()` would put a plausible time on the page with nothing behind it,
// which is the same substitution the 2026-10-09 record refused.
//
// `now()` is transaction start time, which for the single-statement
// transaction these reports issue is the statement's own instant. The reports
// never claimed their several SELECTs were one snapshot, and this does not
// either.

// The statement each report issues is `SELECT now() AS at`, written as a
// tagged template at the call site rather than as a string here. A string
// would have to be run through the raw helper whose name says unsafe, and
// `npm run check:protected-table-writers` refuses a new use of that helper
// without a reviewed exception -- correctly, since the exception would be
// carried for a convenience. The literal therefore appears once per report,
// and `tests/reportRunInstant.test.mjs` pins both copies to the same text so
// the two cannot drift apart.
//
// `now()` returns `timestamptz`, which the client turns into a `Date`, so the
// zone is settled by the column type rather than by a format string.

/** What a report prints when the instant could not be read. */
export const RUN_INSTANT_UNAVAILABLE = "not captured";

/**
 * The ISO 8601 instant for the JSON report, or null.
 *
 * Null rather than a string, so a consumer cannot mistake the absence for a
 * value: `null` has no plausible reading, and `""` or `"unknown"` both sort
 * and compare as if they were times.
 */
export const runInstantIso = (at) =>
    at instanceof Date && Number.isFinite(at.getTime()) ? at.toISOString() : null;

/**
 * The line a report prints above its findings.
 *
 * It names the clock, because "run at" alone would leave the next reader to
 * guess whose -- and that guess is what put this module here.
 */
export const runInstantLine = (at) => {
    const iso = runInstantIso(at);
    return iso === null
        ? `Read at: ${RUN_INSTANT_UNAVAILABLE} -- the database's clock could not be read, so this reading carries no instant. Record the date only.`
        : `Read at: ${iso} (the database's clock, not this machine's)`;
};

/**
 * Reads the instant through a caller-supplied query, returning null rather
 * than throwing.
 *
 * A report that could survey the rows must still print the survey when the
 * clock read fails; losing the findings over a missing timestamp would be a
 * worse trade than losing the timestamp. The caller passes a thunk so the SQL
 * stays a tagged template in the report -- see the note above.
 */
export const readRunInstant = async (read) => {
    try {
        const rows = await read();
        const at = Array.isArray(rows) ? rows[0]?.at : undefined;
        return runInstantIso(at) === null ? null : at;
    } catch {
        return null;
    }
};
