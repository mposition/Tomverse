/**
 * Reads a reviewer's verdicts back out of a batch record file
 * (docs/ops/memory-extraction-eval-dataset.md §6.3, §6.4, §8).
 *
 * The record is the only place a review exists. `docs/ops/memory-extraction-eval-dataset.md` §6.3 says twenty
 * percent seen and nothing written is not adoption, and §7.1 makes the
 * explicit adoption line a freeze condition -- so "was this batch adopted"
 * has to be a question code can answer, not a thing someone remembers.
 *
 * Every unknown answer is a NO. A cell left blank, a word outside the verdict
 * list, a table that moved -- all of them mean "not adopted", because the
 * failure this guards against is a batch flowing into the dataset that nobody
 * judged. A parser that guesses at intent would reintroduce exactly that.
 */

/**
 * One batch of eval cases and the record its reviewer writes into.
 *
 * The same shape on both sides of adoption. A batch does not change what it
 * is when it moves out of `lib/memoryExtractionEvalCandidates/` into
 * `lib/memoryExtractionEvalAdopted/` -- what changes is whether the fixtures
 * file is allowed to import it, and the record is what says so.
 */
export type EvalBatch = {
    /** Batch number, matching its record in docs/ops/memory-extraction-eval-batches/. */
    id: string;
    cell: string;
    /** The record file a reviewer writes their verdicts into. */
    record: string;
    cases: readonly unknown[];
};

/** The three verdicts docs/ops/memory-extraction-eval-dataset.md §8 allows. `수정 후 채택` is absent on purpose. */
export const CASE_VERDICTS = ["채택", "반려(재작성)", "반려(폐기)"] as const;
export type CaseVerdict = (typeof CASE_VERDICTS)[number];

/** The batch-level decision of docs/ops/memory-extraction-eval-dataset.md §6.3. `보류` is a reviewer who looked and declined to decide. */
export const BATCH_DECISIONS = ["채택", "반려", "보류"] as const;
export type BatchDecision = (typeof BATCH_DECISIONS)[number];

export type CaseReview = {
    caseId: string;
    verdict: CaseVerdict | null;
    /** Free text. docs/ops/memory-extraction-eval-dataset.md §6.4 wants a reason on a rejection so the redraft has something to answer. */
    reason: string;
};

export type BatchRecord = {
    cases: readonly CaseReview[];
    decision: BatchDecision | null;
    diversity: string;
    reviewedOn: string;
    /**
     * docs/ops/memory-extraction-eval-dataset.md §6.3's safeguard, verbatim
     * from the record: `같음`, `다름`, `""` when the row is there and
     * unanswered, and `null` when the record has no such row at all.
     *
     * The last case is not the same as an unanswered one. Records written
     * before the docs/ops/memory-extraction-eval-dataset.md §6.3 amendment of 2026-08-23 have no row, and their review
     * was completed under the rule that stood then; treating their silence as
     * a refusal would retroactively un-license a review a person finished.
     * `tests/memoryEvalBatchRecord.test.mjs` keeps the row present on every
     * record the current generator writes, so `null` cannot be reached by
     * deleting it from a new one.
     */
    draftSetupSameAsPrevious: string | null;
};

/**
 * Strips what a transcription leaves behind.
 *
 * `docs/ops/memory-extraction-eval-dataset.md`'s approval tables mark an agent-transcribed value
 * `*(전사 — 확인 필요)*`, and the same convention is used in the batch
 * records. The marker qualifies the value; it is not part of it.
 */
const cellValue = (raw: string) =>
    raw
        .replace(/\*\([^)]*\)\*/g, "")
        .replace(/[`*]/g, "")
        .trim();

const tableRowsAfter = (lines: readonly string[], start: number) => {
    const rows: string[][] = [];
    // Body rows only. The header row (`| 판정 | 사유 |`) is a table row by
    // shape, and reading it as a verdict is how a blank sheet reports itself
    // as reviewed.
    let pastHeader = false;
    for (let index = start; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line.startsWith("#")) break;
        if (!line.startsWith("|")) continue;
        // A separator needs an actual dash. `|  |  |` -- an unfilled verdict
        // row -- is otherwise indistinguishable from one, and skipping it
        // makes a whole unreviewed sheet parse as having no cases at all.
        if (line.includes("-") && /^\|[\s|:-]+\|$/.test(line)) {
            pastHeader = true;
            continue;
        }
        if (!pastHeader) continue;
        rows.push(
            line
                .slice(1, line.endsWith("|") ? -1 : undefined)
                .split("|")
                .map((cell) => cell.trim())
        );
    }
    return rows;
};

const asCaseVerdict = (value: string): CaseVerdict | null =>
    (CASE_VERDICTS as readonly string[]).includes(value)
        ? (value as CaseVerdict)
        : null;

const asBatchDecision = (value: string): BatchDecision | null =>
    (BATCH_DECISIONS as readonly string[]).includes(value)
        ? (value as BatchDecision)
        : null;

export const parseBatchRecord = (markdown: string): BatchRecord => {
    const lines = markdown.split("\n");
    const cases: CaseReview[] = [];
    let decision: BatchDecision | null = null;
    let diversity = "";
    let reviewedOn = "";
    let draftSetupSameAsPrevious: string | null = null;

    for (const [index, line] of lines.entries()) {
        const heading = /^###\s+(\S+)\s*$/.exec(line.trim());
        if (heading) {
            // The first table under a case heading is its verdict table. A
            // heading with no table is an unjudged case, not a missing one.
            const [row] = tableRowsAfter(lines, index + 1);
            if (row) {
                cases.push({
                    caseId: heading[1],
                    verdict: asCaseVerdict(cellValue(row[0] ?? "")),
                    reason: cellValue(row[1] ?? ""),
                });
            }
            continue;
        }
        if (!line.trim().startsWith("|")) continue;
        const cells = line
            .trim()
            .slice(1)
            .split("|")
            .map((cell) => cell.trim());
        const key = cellValue(cells[0] ?? "");
        const value = cellValue(cells[1] ?? "");
        if (key === "batch 채택 여부") decision = asBatchDecision(value);
        else if (key.startsWith("다양성 판정")) diversity = value;
        else if (key === "검수 완료일") reviewedOn = value;
        else if (key.startsWith("초안 구성이 직전 batch와 같은가"))
            draftSetupSameAsPrevious = value;
    }

    return {
        cases,
        decision,
        diversity,
        reviewedOn,
        draftSetupSameAsPrevious,
    };
};

/**
 * docs/ops/memory-extraction-eval-dataset.md §6.4: the share of sampled cases whose adopted judgement differs
 * from what the draft proposed. A rejection is a disagreement; an adoption is
 * not. §7.1 requires this number to exist before the dataset can be frozen.
 */
export const draftDisagreementRate = (record: BatchRecord) => {
    const judged = record.cases.filter((entry) => entry.verdict !== null);
    if (judged.length === 0) return null;
    const disagreed = judged.filter((entry) => entry.verdict !== "채택");
    return disagreed.length / judged.length;
};

/**
 * Why this batch may not be promoted yet, as sentences. Empty means it may.
 *
 * Promotion moves cases nobody sampled into the dataset on the strength of
 * the adoption line, so every reason here is a reason that line is not yet
 * standing on anything.
 */
export const promotionBlockers = (
    record: BatchRecord,
    /**
     * How many cases the batch holds. Without it the docs/ops/memory-extraction-eval-dataset.md §6.3 safeguard below can
     * see that the setup changed but not that the record covers every case,
     * so it reports the weaker of the two facts rather than guessing.
     */
    totalCases?: number
): string[] => {
    const blockers: string[] = [];
    const unjudged = record.cases.filter((entry) => entry.verdict === null);
    if (record.cases.length === 0)
        blockers.push("the record has no case verdict tables to read");
    if (unjudged.length > 0)
        blockers.push(
            `${unjudged.length} sampled case(s) carry no verdict: ${unjudged
                .map((entry) => entry.caseId)
                .join(", ")}`
        );
    const rejected = record.cases.filter(
        (entry) => entry.verdict !== null && entry.verdict !== "채택"
    );
    if (rejected.length > 0)
        blockers.push(
            `${rejected.length} sampled case(s) were rejected, so docs/ops/memory-extraction-eval-dataset.md §6.3 wants the whole ` +
                `batch re-reviewed before any of it moves: ${rejected
                    .map((entry) => entry.caseId)
                    .join(", ")}`
        );
    if (record.decision === null)
        blockers.push(
            "the batch adoption line is blank or unrecognised; docs/ops/memory-extraction-eval-dataset.md §6.3 says seeing the " +
                "sample and saying nothing is not adoption"
        );
    else if (record.decision !== "채택")
        blockers.push(`the reviewer recorded 「${record.decision}」, not 채택`);
    if (record.diversity === "")
        blockers.push(
            "the diversity judgement is blank; docs/ops/memory-extraction-eval-dataset.md §6.5 leaves that call to a person and " +
                "§7.1 requires it on the record"
        );
    if (record.reviewedOn === "") blockers.push("the review date is blank");
    // docs/ops/memory-extraction-eval-dataset.md §6.3 lets a batch be judged on a sample only while the drafting setup is
    // the one the sampling evidence was gathered on. A batch reviewed in full
    // needs no such promise, so the row is asked for only when a sample is
    // what is standing in for the rest -- and an unknown batch size counts as
    // sampled, because the alternative is exempting the case we cannot see.
    const sampled = totalCases === undefined || record.cases.length < totalCases;
    if (sampled && record.draftSetupSameAsPrevious !== null) {
        // An unanswered row is not a yes: the point of the safeguard is that
        // nobody but the reviewer knows whether tool, model or version moved.
        if (record.draftSetupSameAsPrevious === "")
            blockers.push(
                "the docs/ops/memory-extraction-eval-dataset.md §6.3 drafting-setup row is blank; a sample " +
                    "stands for the rest of the batch only when the reviewer states the " +
                    "setup is unchanged"
            );
        else if (record.draftSetupSameAsPrevious !== "같음") {
            if (record.draftSetupSameAsPrevious !== "다름")
                blockers.push(
                    `the docs/ops/memory-extraction-eval-dataset.md §6.3 drafting-setup row reads ` +
                        `「${record.draftSetupSameAsPrevious}」, which is neither 같음 nor 다름`
                );
            blockers.push(
                "the drafting setup changed, so docs/ops/memory-extraction-eval-dataset.md §6.3 wants this batch " +
                    `reviewed in full: ${record.cases.length}${
                        totalCases === undefined ? "" : ` of ${totalCases}`
                    } case(s) carry a verdict (regenerate the sheet with --full)`
            );
        }
    }
    return blockers;
};
