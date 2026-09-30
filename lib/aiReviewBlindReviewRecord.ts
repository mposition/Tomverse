/**
 * Reads the blind review a person filled in, and refuses one that cannot
 * carry a verdict.
 *
 * docs/policy/ai-review-m5-quality-contract.md §5.
 *
 * ## The gap this closes
 *
 * `scoreCase()` has always taken a third argument -- the zero-tolerance rules
 * a person judged -- and the evaluation runner has always passed `[]`. The
 * blind sheet was generated, a person filled it in, and nothing read it back.
 * So a reviewer that fabricated a safety claim, which is one of the two rules
 * no term list can screen, was found by a person, written on the form, and
 * recorded in the artifact and the register as **zero violations**.
 *
 * The register even asked for a `blindReviewRef`, and a reference to a file
 * that does not exist satisfied it: the admissibility check is pure and never
 * opened anything.
 *
 * So this module does three things, and all three are necessary:
 *
 *   1. **parses** the record a person filled in;
 *   2. **refuses** one that is incomplete, unsigned, or about a different run
 *      -- a half-filled form is not a verdict, and a form from another run is
 *      somebody else's verdict;
 *   3. hands the verdicts back per case, so the real scorer can be re-run with
 *      them rather than a second arithmetic being invented here.
 *
 * ## Why every cell must be answered
 *
 * A blank cell is ambiguous between "I looked and found nothing" and "I did
 * not look". Treating blank as clean is how five rules become three: the
 * screened three come back populated from the harness and the two human-only
 * ones stay empty, which reads exactly like a clean run. So `yes`/`no` is
 * required in every cell of every row, and a blank is a refusal.
 */

import {
    AI_REVIEW_EVAL_BLIND_SHEET_RULES,
    type AiReviewEvalZeroToleranceRule,
} from "@/lib/aiReviewEvalCore";

/** The identity a record must state, so a verdict cannot travel between runs. */
export type AiReviewBlindReviewIdentity = {
    runOrdinal: number;
    reviewerModelId: string;
    promptVersion: string;
    datasetDigest: string;
    commitSha: string;
    sheetSeed: number;
    /**
     * The threshold version the sheet was sized for.
     *
     * Carried so the coverage bar an approval is judged against can be found
     * before the run reaches a register: without it, a pre-registration check
     * has no version to look up and cannot say whether the review covered
     * enough.
     */
    thresholdVersion: string;
    /**
     * The sheet the person read, by digest.
     *
     * The one artefact a human actually looked at, and for a while the only
     * one nothing opened. Without it, a correct sheet, a deleted sheet, a
     * sheet of different questions and a sheet edited after the verdicts were
     * written are the same evidence.
     */
    blindSheetDigest: string;
};

export type AiReviewBlindReviewRow = {
    label: string;
    /** Rule name -> the person's verdict. Every rule is present. */
    verdicts: Readonly<Record<string, boolean>>;
    note: string;
};

export type AiReviewBlindReviewRecord = {
    identity: Partial<AiReviewBlindReviewIdentity>;
    signedBy: string | null;
    signedAt: string | null;
    rows: readonly AiReviewBlindReviewRow[];
};

const HEADER_KEYS = [
    "run-ordinal",
    "reviewer-model-id",
    "prompt-version",
    "dataset-digest",
    "commit-sha",
    "sheet-seed",
    "threshold-version",
    "blind-sheet-digest",
    "signed-by",
    "signed-at",
] as const;

/**
 * The header a record carries, as comment lines above the table.
 *
 * Written by the sheet generator with everything except the two signature
 * lines, which a person fills in. Comment lines rather than extra columns so
 * the table stays one row per case and a spreadsheet can open it.
 */
export const renderBlindReviewRecordHeader = (
    identity: AiReviewBlindReviewIdentity
): string =>
    [
        `# run-ordinal: ${identity.runOrdinal}`,
        `# reviewer-model-id: ${identity.reviewerModelId}`,
        `# prompt-version: ${identity.promptVersion}`,
        `# dataset-digest: ${identity.datasetDigest}`,
        `# commit-sha: ${identity.commitSha}`,
        `# sheet-seed: ${identity.sheetSeed}`,
        `# threshold-version: ${identity.thresholdVersion}`,
        `# blind-sheet-digest: ${identity.blindSheetDigest}`,
        "# signed-by: ",
        "# signed-at: ",
        "#",
        "# Every cell must say yes or no. A blank is refused, because a blank",
        "# cannot be told apart from a rule nobody looked at -- and the two",
        "# rules only you can judge are exactly the ones that would stay blank.",
    ].join("\n");

const splitCsvLine = (line: string): readonly string[] => {
    const cells: string[] = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quoted) {
            if (character === '"' && line[index + 1] === '"') {
                current += '"';
                index += 1;
            } else if (character === '"') {
                quoted = false;
            } else {
                current += character;
            }
            continue;
        }
        if (character === '"') quoted = true;
        else if (character === ",") {
            cells.push(current);
            current = "";
        } else current += character;
    }
    cells.push(current);
    return cells.map((cell) => cell.trim());
};

const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0"]);

export const parseBlindReviewRecord = (
    csv: string
): { record: AiReviewBlindReviewRecord; problems: readonly string[] } => {
    const problems: string[] = [];
    const identity: Record<string, string> = {};
    const lines = csv.split(/\r?\n/);
    const tableLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        if (trimmed.startsWith("#")) {
            const body = trimmed.slice(1).trim();
            const separator = body.indexOf(":");
            if (separator < 0) continue;
            const key = body.slice(0, separator).trim().toLowerCase();
            if ((HEADER_KEYS as readonly string[]).includes(key)) {
                identity[key] = body.slice(separator + 1).trim();
            }
            continue;
        }
        tableLines.push(trimmed);
    }

    if (tableLines.length === 0) {
        return {
            record: { identity: {}, signedBy: null, signedAt: null, rows: [] },
            problems: ["the record has no table"],
        };
    }

    const header = splitCsvLine(tableLines[0]).map((cell) => cell.toLowerCase());
    const expected = ["label", ...AI_REVIEW_EVAL_BLIND_SHEET_RULES, "note"];
    if (header.join(",") !== expected.join(",")) {
        problems.push(
            `the columns are "${header.join(", ")}"; expected "${expected.join(", ")}"`
        );
    }

    const rows: AiReviewBlindReviewRow[] = [];
    const seen = new Set<string>();
    for (const line of tableLines.slice(1)) {
        const cells = splitCsvLine(line);
        const label = cells[0] ?? "";
        if (!label) {
            problems.push("a row has no label");
            continue;
        }
        if (seen.has(label)) problems.push(`${label}: appears more than once`);
        seen.add(label);

        const verdicts: Record<string, boolean> = {};
        for (const [index, rule] of AI_REVIEW_EVAL_BLIND_SHEET_RULES.entries()) {
            const raw = (cells[index + 1] ?? "").toLowerCase();
            if (YES.has(raw)) verdicts[rule] = true;
            else if (NO.has(raw)) verdicts[rule] = false;
            else {
                problems.push(
                    raw === ""
                        ? `${label}: ${rule} is blank; a blank is not a verdict`
                        : `${label}: ${rule} says "${raw}", which is not yes or no`
                );
            }
        }
        rows.push({
            label,
            verdicts,
            note: cells[AI_REVIEW_EVAL_BLIND_SHEET_RULES.length + 1] ?? "",
        });
    }

    const numeric = (value: string | undefined) =>
        value !== undefined && value !== "" && Number.isFinite(Number(value))
            ? Number(value)
            : undefined;

    return {
        record: {
            identity: {
                runOrdinal: numeric(identity["run-ordinal"]),
                reviewerModelId: identity["reviewer-model-id"] || undefined,
                promptVersion: identity["prompt-version"] || undefined,
                datasetDigest: identity["dataset-digest"] || undefined,
                commitSha: identity["commit-sha"] || undefined,
                sheetSeed: numeric(identity["sheet-seed"]),
                thresholdVersion: identity["threshold-version"] || undefined,
                blindSheetDigest: identity["blind-sheet-digest"] || undefined,
            },
            signedBy: identity["signed-by"] || null,
            signedAt: identity["signed-at"] || null,
            rows,
        },
        problems,
    };
};

/**
 * Everything wrong with a record, given the sheet it answers and the run it
 * claims to be about.
 *
 * Identity is checked field by field for the same reason the artifact
 * comparison checks five fields rather than the dataset digest: a record from
 * another run is another person's verdict about another reviewer, and a
 * verdict that can travel is not evidence about anything.
 */
export const blindReviewRecordProblems = (input: {
    record: AiReviewBlindReviewRecord;
    /** Every label the sheet put in front of the person. */
    sheetLabels: readonly string[];
    identity: AiReviewBlindReviewIdentity;
}): readonly string[] => {
    const problems: string[] = [];
    const { record, identity } = input;

    if (!record.signedBy) problems.push("nobody signed the record");
    // The same rule the threshold sets get. A date that cannot be turned into
    // a day is the same as no day, and `signed-at: someday` passed both
    // adjudication and the approval check while it was only tested for
    // emptiness.
    if (!record.signedAt) {
        problems.push("the record is not dated");
    } else if (Number.isNaN(Date.parse(record.signedAt))) {
        problems.push(
            `the record's signature date "${record.signedAt}" is not a date`
        );
    }

    const compare = <K extends keyof AiReviewBlindReviewIdentity>(key: K) => {
        const stated = record.identity[key];
        if (stated === undefined || stated === "") {
            problems.push(`the record does not state ${String(key)}`);
        } else if (stated !== identity[key]) {
            problems.push(
                `the record is about ${String(key)} ${String(stated)}, not ${String(identity[key])}`
            );
        }
    };
    compare("runOrdinal");
    compare("reviewerModelId");
    compare("promptVersion");
    compare("datasetDigest");
    compare("commitSha");
    compare("sheetSeed");
    compare("thresholdVersion");
    compare("blindSheetDigest");

    const answered = new Set(record.rows.map((row) => row.label));
    for (const label of input.sheetLabels) {
        if (!answered.has(label)) problems.push(`${label}: not answered`);
    }
    for (const row of record.rows) {
        if (!input.sheetLabels.includes(row.label)) {
            problems.push(`${row.label}: is not on this sheet`);
        }
        for (const rule of AI_REVIEW_EVAL_BLIND_SHEET_RULES) {
            if (typeof row.verdicts[rule] !== "boolean") {
                problems.push(`${row.label}: ${rule} has no verdict`);
            }
        }
    }
    return problems;
};

/**
 * The rules a person marked, per case id.
 *
 * Handed back for `scoreCase()` to consume, so the final numbers come out of
 * the same scorer that produced the first ones. Recomputing violations here
 * would be a second arithmetic, and two arithmetics disagree.
 */
export const humanVerdictsByCase = (
    record: AiReviewBlindReviewRecord,
    answerKey: Readonly<Record<string, { caseId: string }>>
): ReadonlyMap<string, readonly AiReviewEvalZeroToleranceRule[]> => {
    const byCase = new Map<string, AiReviewEvalZeroToleranceRule[]>();
    for (const row of record.rows) {
        const caseId = answerKey[row.label]?.caseId;
        if (!caseId) continue;
        const found = AI_REVIEW_EVAL_BLIND_SHEET_RULES.filter(
            (rule) => row.verdicts[rule] === true
        );
        byCase.set(caseId, found as AiReviewEvalZeroToleranceRule[]);
    }
    return byCase;
};
