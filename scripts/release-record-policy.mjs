// Where a release run is recorded, and what makes a record a record.
//
// This is deliberately NOT an entry in `staging-verification-features.mjs`.
// That registry answers "which feature keeps a staging checklist", and both of
// its entries share one record format: YAML front matter, a `frozen` flag and
// a digest. A release run shares the *guarantee* -- the template holds items,
// a run holds results -- and none of the format: its header is a fenced block,
// its identity is a release SHA rather than a staging deploy SHA, and it has a
// waiver section that a feature checklist has no equivalent of. Folding it in
// would give every field in that registry two meanings and every consumer a
// branch on which one it had.
//
// So: same idea, separate registry, separate check.
//
// ## The failure this exists for
//
// `.github/RELEASE_CHECKLIST.md` is a template. It was also, for fifteen
// commits, the only copy -- every box in it unticked, because nobody had ever
// recorded a run anywhere. The first real run (2026-08-15) was written into a
// dated copy by hand, on the advice of whoever was asked at the time. Nothing
// in the repository made that the way it works, so the next run is equally
// likely to be typed into the template itself, where it silently becomes the
// starting state of every release after it.
//
// That is the same mistake the staging split was built for, one directory over.

export const RELEASE_CHECKLIST_TEMPLATE = ".github/RELEASE_CHECKLIST.md";
export const RELEASE_RECORDS_DIR = ".github/audits";

// `release-<date>__<sha>.md`. The SHA is allowed to be short here, unlike a
// staging record's, because it is not the identifier: the record's own
// `Release SHA:` line is, and that one has to be complete. A filename cannot
// be corrected later without splitting the file's history in two, so it is the
// wrong place to put the field that must be right.
export const RELEASE_RECORD_NAME =
    /^release-(\d{4}-\d{2}-\d{2})__([0-9a-f]{7,40})\.md$/;

// `release-deviation-<date>__<sha>.md`. A second kind of document in the same
// directory, and deliberately not validated as a record: a record says a
// checklist was run against a build, a deviation says production is serving a
// build no checklist covers. Requiring ticked boxes of one would be asking it
// to claim the thing it exists to deny.
//
// It is matched rather than ignored. A pattern that skipped everything not
// shaped like a record would also skip a record somebody misnamed, which is
// the rule this file's naming check exists for.
export const RELEASE_DEVIATION_NAME =
    /^release-deviation-(\d{4}-\d{2}-\d{2})__([0-9a-f]{7,40})\.md$/;

// `release-<subject>-handoff-<date>.md`. The third kind, and the reason the
// prefix needs saying out loud: `release-` is a reserved namespace in this
// directory, so a document about release work that is not a run and not a
// deviation was being told to rename itself to something that hid its subject.
//
// A handoff describes where a thread stands -- what was closed, what could not
// be, what the next session should read first. It has no checklist to tick and
// no waiver section, so validating it as a record would demand a claim it does
// not make.
//
// It carries no `__<sha>` slot, which is what keeps it from ever being
// mistaken for a misnamed record: a record's name is date-then-SHA, and this
// one ends at the date. What it must still do is name the build it describes,
// for the same reason a deviation must -- a handoff that never says which
// production build it is about cannot be acted on later.
export const RELEASE_HANDOFF_NAME =
    /^release-[a-z0-9-]+-handoff-(\d{4}-\d{2}-\d{2})\.md$/;

export const normalizeLineEndings = (text) => text.replace(/\r\n?/g, "\n");

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The fenced header block at the top of a checklist, as a map.
 *
 * Reads `Release SHA:`, `Staging deployment:` and `Date / timezone:` wherever
 * they appear, rather than by position, so re-ordering the block does not turn
 * every field into a missing one.
 */
export const headerFields = (text) => {
    const fields = new Map();
    for (const line of normalizeLineEndings(text).split("\n")) {
        const matched = /^([A-Za-z][A-Za-z /]*?):\s{2,}(.*)$/.exec(line);
        if (!matched) continue;
        const value = matched[2].trim();
        if (!fields.has(matched[1])) fields.set(matched[1], value);
    }
    return fields;
};

/** A blank a template leaves for a record to fill: `____________________`. */
export const isBlank = (value) =>
    value === undefined || value === "" || /^_+$/.test(value);

export const tickedBoxes = (text) =>
    normalizeLineEndings(text)
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /^\s*-\s*\[[^ \]]\]/.test(line));

export const untickedBoxes = (text) =>
    normalizeLineEndings(text)
        .split("\n")
        .filter((line) => /^\s*-\s*\[ \]/.test(line));

/**
 * Data rows of the section 8 waiver table.
 *
 * Section 8 is where an unverified item goes with a named owner, and it is the
 * half of the contract that makes an unticked box legible: "N/V is an
 * accepted, tracked risk; a silent tick is neither" is only true while the
 * table is actually filled. Header and separator rows are dropped, and so is
 * everything from the "Carried forward" heading down -- that part is a
 * standing list copied from the template, not this release's decisions.
 */
export const waiverRows = (text) => {
    const body = normalizeLineEndings(text);
    const start = body.indexOf("\n## 8.");
    if (start === -1) return [];
    const carried = body.indexOf("\n### Carried forward", start);
    const end = carried === -1 ? body.indexOf("\n## 9.", start) : carried;
    return body
        .slice(start, end === -1 ? undefined : end)
        .split("\n")
        .filter((line) => line.trimStart().startsWith("|"))
        .filter((line) => !/^\s*\|\s*-{2,}/.test(line))
        .filter((line) => !/^\s*\|\s*Item\s*\|/.test(line))
        .filter((line) => line.replace(/[|\s]/g, "") !== "");
};

/**
 * A value that looks like an owner but names nobody.
 *
 * The one that actually shipped was `(이름)` -- a placeholder from an example,
 * left in place through a commit and a review. It reads as a filled cell, so
 * the row counts towards "section 8 is not empty" while tracking no one.
 */
export const isPlaceholderOwner = (value) => {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "-" || trimmed === "—") return true;
    if (/^_+$/.test(trimmed)) return true;
    return /^[(（<[]?\s*(이름|name|owner|TBD|TODO|담당자)\s*[)）>\]]?$/i.test(trimmed);
};

/**
 * Every problem with one release record, as sentences.
 *
 * Pure: takes the filename and the text, touches no filesystem. The runner
 * reads files and prints; everything decided here is decided from the two
 * arguments, which is what lets the tests state a defect as a string literal
 * rather than a fixture tree.
 */
export const releaseDeviationProblems = (name, text) => {
    const problems = [];
    const path = `${RELEASE_RECORDS_DIR}/${name}`;
    const body = normalizeLineEndings(text);

    // The one thing a deviation must do: name the build production is serving.
    // Without it the document describes a gap without saying where the gap is,
    // and the rollback target is unreadable.
    if (!/\b[0-9a-f]{40}\b/.test(body)) {
        problems.push(
            `${path}  names no full 40-character SHA. A deviation record has to say which build production is actually serving.`
        );
    }
    if (!/[Rr]ollback/.test(body)) {
        problems.push(
            `${path}  names no rollback target. The newest build a checklist covers is the answer, and it has to be written down before it is needed.`
        );
    }
    return problems;
};

/**
 * Every problem with a handoff.
 *
 * One rule only, and it is the same one a deviation carries: name the build.
 * Everything else a handoff contains is prose whose shape cannot be checked
 * without inventing a format nobody agreed to, and a gate that invented one
 * would be answered by satisfying the gate rather than by writing a useful
 * handoff.
 */
export const releaseHandoffProblems = (name, text) => {
    const problems = [];
    const path = `${RELEASE_RECORDS_DIR}/${name}`;
    if (!/\b[0-9a-f]{40}\b/.test(normalizeLineEndings(text))) {
        problems.push(
            `${path}  names no full 40-character SHA. A handoff has to say which build the state it describes was measured against, or the next session cannot tell what has moved since.`
        );
    }
    return problems;
};

export const releaseRecordProblems = (name, text, { templateText } = {}) => {
    const problems = [];
    const path = `${RELEASE_RECORDS_DIR}/${name}`;

    if (!RELEASE_RECORD_NAME.test(name)) {
        problems.push(
            `${path}  is not named release-YYYY-MM-DD__<sha>.md, so it does not sort with the other runs or say which build it covers.`
        );
        return problems;
    }

    const body = normalizeLineEndings(text);
    const fields = headerFields(body);
    const sha = fields.get("Release SHA");

    if (isBlank(sha)) {
        problems.push(
            `${path}  leaves Release SHA blank. Evidence produced against a different build does not carry over, and a record that does not name its build cannot say which one it is.`
        );
    } else if (!FULL_SHA.test(sha)) {
        problems.push(
            `${path}  records Release SHA as "${sha}", which is not a full 40-character SHA. A short SHA sends the reader looking.`
        );
    }

    if (templateText !== undefined) {
        if (normalizeLineEndings(templateText) === body) {
            problems.push(
                `${path}  is byte-identical to the template. A blank copy in the repository looks official and says nothing, which is the state this split exists to prevent.`
            );
            return problems;
        }
    }

    const ticked = tickedBoxes(body).length;
    const unticked = untickedBoxes(body).length;
    const waivers = waiverRows(body);

    if (ticked === 0) {
        problems.push(
            `${path}  has no ticked box at all. A run with nothing ticked is a copy, not a record.`
        );
    }

    if (unticked > 0 && waivers.length === 0) {
        problems.push(
            `${path}  leaves ${unticked} box(es) unticked and section 8 empty. An unticked box is a release blocker unless someone owns it; an empty section 8 makes the two indistinguishable.`
        );
    }

    for (const row of waivers) {
        const cells = row.split("|").slice(1, -1);
        // Item | Why not verified | Owner | Command / evidence needed
        const owner = cells[2];
        if (owner === undefined) {
            problems.push(
                `${path}  has a section 8 row with fewer than four columns: ${row.trim()}`
            );
            continue;
        }
        if (isPlaceholderOwner(owner)) {
            problems.push(
                `${path}  has a section 8 row whose owner is "${owner.trim()}", which names nobody: ${cells[0].trim()}`
            );
        }
    }

    return problems;
};

/** Every problem with the template itself. */
export const releaseTemplateProblems = (text) => {
    const problems = [];
    const body = normalizeLineEndings(text);

    for (const { index } of tickedBoxes(body)) {
        problems.push(
            `${RELEASE_CHECKLIST_TEMPLATE}:${index + 1}  a ticked box in the template. A run's results belong in ${RELEASE_RECORDS_DIR}/release-<date>__<sha>.md.`
        );
    }

    // A 40-character SHA is the shape of an answer, and the template asks the
    // question. One in here means a run was typed into the template -- which
    // is not a mistake anyone notices, because the file still looks exactly
    // like the checklist.
    const shas = [...body.matchAll(/\b[0-9a-f]{40}\b/g)];
    for (const match of shas) {
        problems.push(
            `${RELEASE_CHECKLIST_TEMPLATE}  names the build ${match[0].slice(0, 8)}. The template covers every release and so can name none of them.`
        );
    }

    const fields = headerFields(body);
    for (const field of ["Release SHA", "Staging deployment", "Date / timezone"]) {
        const value = fields.get(field);
        if (value !== undefined && !isBlank(value)) {
            problems.push(
                `${RELEASE_CHECKLIST_TEMPLATE}  has "${field}" filled in as "${value}". The header of the template stays blank; a run fills in its own copy.`
            );
        }
    }

    return problems;
};
