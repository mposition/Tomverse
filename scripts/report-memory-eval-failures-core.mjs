/**
 * Says which cases a decision-grade run failed, and how.
 *
 * The harness prints a verdict and, on a probe, a case-by-case list. A full
 * run gets no list — the printer is inside `if (probeLimit !== null)`, because
 * 1,150 cases would be a wall of text. So a failing full run leaves nothing in
 * CI that names the cases behind its numbers. run1 on 2026-08-26 missed the
 * critical bulk-safe gate 49 times and nothing said which 49.
 *
 * This reads the preserved artifact instead. It is a REPORT, not a gate:
 *
 *   * it never writes to the artifact, the dataset or the register — a report
 *     that edits its own subject destroys the record it exists to explain;
 *   * it does not recompute the verdict. `artifact.verdict` is quoted as
 *     found, and everything here only says what is behind it;
 *   * `criticalAdoptions` comes from the same function the gate counts with
 *     (`unadmittedCriticalBulkSafeCandidates`), not a second implementation of
 *     the rule. Naming a different set from the one the gate counted would be
 *     describing a failure nobody had.
 *
 * It refuses when the tree's dataset is not the one the artifact was scored
 * against. The gold labels decide every classification below, so reading an
 * old artifact against a newer dataset produces confident, wrong answers —
 * which is the failure this programme has already had four times in its tools.
 */

import {
    matchesExpectedV2,
    unadmittedCriticalBulkSafeCandidates,
} from "@/lib/memoryEvalScoringV2";
import {
    MEMORY_EVAL_CRITICAL_CATEGORIES,
    summarizeFailures,
} from "@/lib/memoryExtractionEvalCore";

const CRITICAL = new Set(MEMORY_EVAL_CRITICAL_CATEGORIES);

/**
 * The token rule alone, with the kind check neutralised.
 *
 * Reuses the scorer's own matcher rather than restating its normalisation, so
 * "the tokens are present" means here exactly what it means to the gate.
 */
const tokensMatch = (candidate, expected) =>
    matchesExpectedV2(candidate, { ...expected, kind: candidate.kind });

const cellKey = (category, language) => `${category}:${language}`;

const emptyCell = (category, language) => ({
    category,
    language,
    cases: 0,
    failures: 0,
    precision: { numerator: 0, denominator: 0 },
    recall: { numerator: 0, denominator: 0 },
    bulk: { numerator: 0, denominator: 0 },
    criticalAdoptions: 0,
    sensitiveViolations: 0,
});

/**
 * @param {object} input
 * @param {object} input.artifact       parsed artifact JSON
 * @param {Map<string, object>} input.casesById   the tree's dataset, by case id
 * @param {string} input.datasetVersion the tree's dataset version
 * @param {string} input.datasetDigest  the tree's dataset digest
 */
export function analyseArtifact({
    artifact,
    casesById,
    datasetVersion,
    datasetDigest,
}) {
    const manifest = artifact?.manifest;
    if (!manifest || !Array.isArray(artifact?.records)) {
        return {
            refusal:
                "This file has no manifest or no records, so it is not an eval artifact.",
        };
    }

    if (manifest.datasetVersion !== datasetVersion) {
        return {
            refusal:
                `The artifact was scored against ${manifest.datasetVersion} and this tree carries ` +
                `${datasetVersion}. Every classification below is decided by the gold labels, so ` +
                `reading it here would answer confidently about labels that were never applied. ` +
                `Check out the commit the artifact names (${manifest.commitSha ?? "unknown"}).`,
        };
    }
    if (manifest.datasetDigest !== datasetDigest) {
        return {
            refusal:
                `Same dataset version, different digest — the artifact was scored against ` +
                `${String(manifest.datasetDigest).slice(0, 16)}… and this tree fingerprints to ` +
                `${datasetDigest.slice(0, 16)}…. A frozen dataset that fingerprints differently ` +
                `has been edited, and the cases no longer line up with the records.`,
        };
    }

    const cells = new Map();
    const criticalAdoptions = [];
    const kindMismatches = [];
    const returnedNothing = [];
    const unrecognised = [];
    const harnessFailures = [];
    const missingCases = [];

    for (const record of artifact.records) {
        const testCase = casesById.get(record.caseId);
        if (!testCase) {
            missingCases.push(record.caseId);
            continue;
        }
        const outcome = record.outcome ?? {};
        const key = cellKey(record.category, record.language);
        if (!cells.has(key))
            cells.set(key, emptyCell(record.category, record.language));
        const cell = cells.get(key);
        cell.cases += 1;
        cell.precision.numerator += outcome.candidateMatched ?? 0;
        cell.precision.denominator += outcome.candidateTotal ?? 0;
        cell.recall.numerator += outcome.goldMatched ?? 0;
        cell.recall.denominator += outcome.goldTotal ?? 0;
        cell.bulk.numerator += outcome.bulkGoldReached ?? 0;
        cell.bulk.denominator += outcome.bulkGoldTotal ?? 0;
        cell.criticalAdoptions += outcome.criticalBulkSafeAdoptions ?? 0;
        cell.sensitiveViolations +=
            outcome.sensitiveExpectedBulkSafeViolations ?? 0;

        if (record.failure) {
            cell.failures += 1;
            harnessFailures.push({
                caseId: record.caseId,
                category: record.category,
                language: record.language,
                failure: record.failure,
            });
            continue;
        }

        const expected = testCase.expected ?? [];
        const candidates = record.candidates ?? [];
        const describeExpected = expected.map(
            (entry) =>
                `${entry.kind} + [${entry.mustInclude.join(", ")}] (${entry.expectedDisposition})`
        );

        if (CRITICAL.has(record.category)) {
            const adopted = unadmittedCriticalBulkSafeCandidates(
                testCase,
                candidates
            );
            if (adopted.length > 0) {
                criticalAdoptions.push({
                    caseId: record.caseId,
                    category: record.category,
                    language: record.language,
                    expected: describeExpected,
                    candidates: adopted.map((candidate) => ({
                        kind: candidate.kind,
                        statement: candidate.statement,
                        disposition: candidate.disposition,
                    })),
                });
            }
        }

        if (candidates.length === 0) {
            if (expected.length > 0) {
                returnedNothing.push({
                    caseId: record.caseId,
                    category: record.category,
                    language: record.language,
                    expected: describeExpected,
                });
            }
            continue;
        }

        for (const candidate of candidates) {
            if (expected.some((entry) => matchesExpectedV2(candidate, entry)))
                continue;
            const nearMiss = expected.find((entry) =>
                tokensMatch(candidate, entry)
            );
            const row = {
                caseId: record.caseId,
                category: record.category,
                language: record.language,
                returnedKind: candidate.kind,
                statement: candidate.statement,
                bulkSafe: candidate.bulkSafe,
                disposition: candidate.disposition,
            };
            if (nearMiss) {
                kindMismatches.push({
                    ...row,
                    expectedKind: nearMiss.kind,
                    tokens: nearMiss.mustInclude,
                });
            } else {
                unrecognised.push({ ...row, expected: describeExpected });
            }
        }
    }

    return {
        refusal: null,
        manifest,
        verdict: artifact.verdict ?? null,
        cells: [...cells.values()],
        criticalAdoptions,
        kindMismatches,
        kindMismatchPairs: countPairs(kindMismatches),
        returnedNothing,
        unrecognised,
        harnessFailures,
        missingCases,
    };
}

const countPairs = (rows) => {
    const counts = new Map();
    for (const row of rows) {
        const key = `${row.expectedKind} -> ${row.returnedKind}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};


const pct = ({ numerator, denominator }) =>
    denominator === 0
        ? "     n/a"
        : `${String(numerator).padStart(4)}/${String(denominator).padEnd(4)} ${(numerator / denominator).toFixed(3)}`;

const bullet = (rows, render, limit) => {
    const shown = limit === null ? rows : rows.slice(0, limit);
    const lines = shown.map(render);
    if (shown.length < rows.length) {
        // Never a silent truncation: a list that stops without saying so reads
        // as "that was all of them".
        lines.push(
            `    … and ${rows.length - shown.length} more, not listed here. Raise --max-rows to see them.`
        );
    }
    return lines.join("\n");
};

/**
 * @param {ReturnType<typeof analyseArtifact>} analysis
 * @param {{ maxRows: number | null }} options
 */
export function renderReport(analysis, { maxRows = 40 } = {}) {
    if (analysis.refusal) return `Refused.\n\n${analysis.refusal}\n`;

    const out = [];
    const m = analysis.manifest;
    out.push(
        `Memory eval failures — ${m.modelId}::${m.promptVersion}`,
        `  dataset: ${m.datasetVersion}  digest: ${String(m.datasetDigest).slice(0, 16)}…`,
        `  mode: ${m.mode}   commit: ${m.commitSha}   cases: ${m.caseCount}/${m.plannedCaseCount}`,
        `  decisionGrade: ${m.decisionGrade}   probeLimit: ${m.probeLimit ?? "none"}   accrued: US$${Number(m.accruedCostUsd ?? 0).toFixed(4)}`
    );

    if (analysis.verdict) {
        out.push("", `Verdict as recorded: ${analysis.verdict.pass ? "pass" : "NOT a pass"}`);
        for (const failure of analysis.verdict.failures ?? [])
            out.push(`  - ${failure}`);
        out.push(
            "",
            "Quoted from the artifact, not recomputed. Everything below only says what is",
            "behind those lines."
        );
    }

    out.push(
        "",
        "Per cell",
        "  cell                          cases  fail   precision        recall           bulk elig.       crit  sens"
    );
    for (const cell of [...analysis.cells].sort((a, b) =>
        cellKey(a.category, a.language).localeCompare(
            cellKey(b.category, b.language)
        )
    )) {
        out.push(
            `  ${cellKey(cell.category, cell.language).padEnd(28)} ${String(cell.cases).padStart(5)} ${String(cell.failures).padStart(5)}   ` +
                `${pct(cell.precision)}   ${pct(cell.recall)}   ${pct(cell.bulk)}   ` +
                `${String(cell.criticalAdoptions).padStart(4)}  ${String(cell.sensitiveViolations).padStart(4)}`
        );
    }
    out.push(
        "",
        "No confidence interval per cell, deliberately. §12.2's floors size the sample",
        "for the aggregate and the language arms; a cell bound would invite reading a",
        "number the sample was never designed to support."
    );

    const section = (title, rows, render, note) => {
        out.push("", `${title} — ${rows.length}`);
        if (rows.length === 0) {
            out.push("  none");
            return;
        }
        if (note) out.push(`  ${note}`);
        out.push(bullet(rows, render, maxRows));
    };

    section(
        "Critical bulk-safe adoptions",
        analysis.criticalAdoptions,
        (row) =>
            [
                `  ${row.caseId}  (${row.category}:${row.language})`,
                `    gold: ${row.expected.length === 0 ? "nothing (extracting anything is a false positive)" : row.expected.join("; ")}`,
                ...row.candidates.map(
                    (candidate) =>
                        `    adopted: ${candidate.kind} · ${candidate.disposition} — ${candidate.statement}`
                ),
            ].join("\n"),
        "The gate is zero. Each line below is a candidate that reached bulk-safe in a\n  case whose gold did not admit one."
    );

    section(
        "Tokens match, kind differs",
        analysis.kindMismatches,
        (row) =>
            `  ${row.caseId}  (${row.category}:${row.language})  ${row.expectedKind} -> ${row.returnedKind}  [${row.tokens.join(", ")}]\n    ${row.statement}`,
        "Scored as a false positive AND a miss, because §12.3 judges on the gold label.\n  Whether each is the model, the label or the taxonomy is a question for a person."
    );

    if (analysis.kindMismatchPairs.length > 0) {
        out.push("", "  by pair");
        for (const [pair, count] of analysis.kindMismatchPairs)
            out.push(`    ${String(count).padStart(4)}  ${pair}`);
    }

    section(
        "Expected something, returned nothing",
        analysis.returnedNothing,
        (row) =>
            `  ${row.caseId}  (${row.category}:${row.language})  ${row.expected.join("; ")}`
    );

    section(
        "Returned something no gold recognises",
        analysis.unrecognised,
        (row) =>
            `  ${row.caseId}  (${row.category}:${row.language})  ${row.returnedKind} · bulk-safe ${row.bulkSafe}\n    ${row.statement}`
    );

    section(
        "Harness failures",
        analysis.harnessFailures,
        (row) => `  ${row.caseId}  (${row.category}:${row.language})  ${row.failure}`
    );
    if (analysis.harnessFailures.length > 0) {
        // `summarizeFailures` is what the harness itself collapses reasons
        // with, so the grouping here and the grouping on the run's own summary
        // cannot drift apart.
        out.push("", "  by reason");
        for (const { reason, count } of summarizeFailures(
            analysis.harnessFailures
        ))
            out.push(`    ${String(count).padStart(4)}  ${reason}`);
    }

    if (analysis.missingCases.length > 0) {
        out.push(
            "",
            `${analysis.missingCases.length} record(s) name a case this dataset does not have:`,
            `  ${analysis.missingCases.slice(0, 10).join(", ")}`
        );
    }

    out.push(
        "",
        "This is a report. It does not write to the artifact, the dataset or the",
        "register, and it does not judge the run — `npm run check:memory-eval-run`",
        "decides whether a run may be cited, and approval stays a human procedure."
    );
    return `${out.join("\n")}\n`;
}
