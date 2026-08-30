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
    candidateEvidenceBound,
    unadmittedCriticalBulkSafeCandidatesV3,
} from "@/lib/memoryEvalScoringV3";
import { candidateMatchesGoldV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import {
    MEMORY_EVAL_CRITICAL_CATEGORIES,
    summarizeFailures,
} from "@/lib/memoryExtractionEvalCore";

const CRITICAL = new Set(MEMORY_EVAL_CRITICAL_CATEGORIES);

/**
 * The schema's own matchers, so this report classifies by exactly what the
 * gate counted.
 *
 * A report that restated a rule would drift from it, and the drift is silent:
 * the totals come from the artifact's outcomes and the lines below come from
 * here, so a mismatch shows up as a report whose list disagrees with its own
 * headline. That has happened four times in this programme's tools, which is
 * why every rule below is the scorer's own function rather than a copy.
 *
 * `tokensMatch` neutralises the kind check to find a near miss — a candidate
 * that says the right thing under the wrong label. Under schema 3 it
 * neutralises polarity too, and the caller reports which one differed.
 */
const schemaTools = (schemaVersion) => {
    if (schemaVersion === 3) {
        return {
            schemaVersion: 3,
            tokens: (gold) => gold.factValueAll ?? [],
            matches: (candidate, gold, testCase) =>
                candidateMatchesGoldV3(gold, candidate, testCase.language) &&
                candidateEvidenceBound(
                    candidate,
                    testCase.conversations.flatMap(
                        (conversation) => conversation.messages
                    )
                ),
            tokensMatch: (candidate, gold, testCase) =>
                candidateMatchesGoldV3(
                    gold,
                    { ...candidate, kind: gold.kind, polarity: gold.polarity },
                    testCase.language
                ),
            unadmittedCritical: (testCase, candidates) =>
                unadmittedCriticalBulkSafeCandidatesV3(
                    testCase,
                    candidates,
                    candidates.map((candidate) =>
                        candidateEvidenceBound(
                            candidate,
                            testCase.conversations.flatMap(
                                (conversation) => conversation.messages
                            )
                        )
                    )
                ),
        };
    }
    return {
        schemaVersion,
        tokens: (gold) => gold.mustInclude ?? [],
        matches: (candidate, gold) => matchesExpectedV2(candidate, gold),
        tokensMatch: (candidate, gold) =>
            matchesExpectedV2(candidate, { ...gold, kind: candidate.kind }),
        unadmittedCritical: (testCase, candidates) =>
            unadmittedCriticalBulkSafeCandidates(testCase, candidates),
    };
};

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
 * @param {number} input.datasetSchemaVersion which scorer's rules to classify by
 */
export function analyseArtifact({
    artifact,
    casesById,
    datasetVersion,
    datasetDigest,
    datasetSchemaVersion = 2,
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

    const tools = schemaTools(datasetSchemaVersion);

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
                `${entry.kind}${entry.polarity ? `/${entry.polarity}` : ""} + ` +
                `[${tools.tokens(entry).join(", ")}] (${entry.expectedDisposition})`
        );

        if (CRITICAL.has(record.category)) {
            const adopted = tools.unadmittedCritical(testCase, candidates);
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
            if (
                expected.some((entry) => tools.matches(candidate, entry, testCase))
            ) {
                continue;
            }
            const nearMiss = expected.find((entry) =>
                tools.tokensMatch(candidate, entry, testCase)
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
                // Which field differed, named rather than left to the reader.
                // Under schema 3 "the tokens are right and this did not match"
                // has three answers -- the kind, the polarity, or a citation
                // that does not resolve -- and they need different responses:
                // a taxonomy question, a reading question, and a defect.
                kindMismatches.push({
                    ...row,
                    expectedKind: nearMiss.kind,
                    tokens: tools.tokens(nearMiss),
                    ...(tools.schemaVersion === 3
                        ? {
                              expectedPolarity: nearMiss.polarity,
                              returnedPolarity: candidate.polarity,
                              evidenceBound: candidateEvidenceBound(
                                  candidate,
                                  testCase.conversations.flatMap(
                                      (conversation) => conversation.messages
                                  )
                              ),
                          }
                        : {}),
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
        // The gate counts candidates and this list groups them by case, so the
        // two units differ and the headline has to name the one the verdict
        // uses. Reporting 46 beside a verdict that says 49 reads as a third
        // number nobody computed.
        criticalAdoptionCount: criticalAdoptions.reduce(
            (total, row) => total + row.candidates.length,
            0
        ),
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
        // Grouped by what actually differed, so a run whose misses are all
        // polarity does not read as a kind problem. A row where the kind is
        // right and the polarity is wrong used to key on `x -> x`.
        const key =
            row.expectedKind === row.returnedKind &&
            row.expectedPolarity !== undefined &&
            row.expectedPolarity !== row.returnedPolarity
                ? `polarity ${row.expectedPolarity} -> ${String(row.returnedPolarity)}`
                : row.expectedKind === row.returnedKind &&
                    row.evidenceBound === false
                  ? "evidence did not resolve"
                  : `${row.expectedKind} -> ${row.returnedKind}`;
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

    // `count` is for the one section whose rows are not the thing it counts:
    // critical adoptions are candidates, grouped here one row per case.
    const section = (title, rows, render, note, count = null) => {
        out.push("", `${title} — ${count ?? rows.length}`);
        if (rows.length === 0) {
            out.push("  none");
            return;
        }
        if (count !== null && count !== rows.length) {
            out.push(`  across ${rows.length} case(s)`);
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
        "The gate is zero. Each line below is a candidate that reached bulk-safe in a\n  case whose gold did not admit one.",
        analysis.criticalAdoptionCount
    );

    section(
        "Tokens match, something else differs",
        analysis.kindMismatches,
        (row) => {
            // Under schema 3 three different things put a candidate in this
            // list, and they are not the same finding: a kind is a taxonomy
            // question, a polarity is a reading of what the user said, and an
            // unresolved citation is a defect. Naming which one differed is
            // the difference between a report and a pile.
            const differs = [
                row.expectedKind !== row.returnedKind
                    ? `kind ${row.expectedKind} -> ${row.returnedKind}`
                    : null,
                row.expectedPolarity !== undefined &&
                row.expectedPolarity !== row.returnedPolarity
                    ? `polarity ${row.expectedPolarity} -> ${String(row.returnedPolarity)}`
                    : null,
                row.evidenceBound === false ? "evidence did not resolve" : null,
            ].filter(Boolean);
            return (
                `  ${row.caseId}  (${row.category}:${row.language})  ` +
                `${differs.join("; ") || "matched on every field"}  [${row.tokens.join(", ")}]\n    ${row.statement}`
            );
        },
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
