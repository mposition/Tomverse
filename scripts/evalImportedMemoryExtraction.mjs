// §12.2 eval harness for imported-conversation memory extraction.
//
// docs/policy/external-conversation-import-and-memory.md §12.
//
// What this script is FOR: producing the numbers §12.3 is judged on, from
// synthetic fixtures, through the same pipeline the product runs. What it is
// NOT for: deciding anything. §12.4 puts approval on a person, and this script
// is deliberately built so its own output cannot be mistaken for one — a run
// that did not meet the sample contract says so on every summary line, and the
// exit code never means "approved".
//
// Two modes:
//
//   --smoke (default when no API key is configured)
//       No provider is contacted. Each fixture's hand-written `stub` answer is
//       fed through the real parser, validator and scorer. This proves the
//       harness works; it measures nothing about a model, and every line of
//       the report says so.
//
//   --live
//       Calls the extraction model through lib/memoryExtractionProvider.ts —
//       the same adapter production uses, with the same maxRetries: 0. Costs
//       real money. §12.5 requires a human-approved eval budget first.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/evalImportedMemoryExtraction.mjs
//   node --conditions=react-server --import tsx scripts/evalImportedMemoryExtraction.mjs \
//       --live --model=gpt-5-6-luna --repeats=200 --json=artifacts/eval.json

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
    CATEGORIES,
    DATASET_VERSION,
    FIXTURES,
    LANGUAGES,
    MIN_SAMPLES_PER_CATEGORY_ARM,
    fixtureConversation,
} from "../tests/fixtures/memoryExtractionEval.mjs";
import {
    emptyEvalStats,
    evaluateThresholds,
    scoreEvalProviderError,
    scoreEvalSample,
    summarizeEvalStats,
} from "../lib/memoryExtractionEvalScoring.ts";
import { analyzeExtractionChunk } from "../lib/memoryExtractionPipeline.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
    const found = args.find((arg) => arg.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
};

const MODEL_ID = option("model", "gpt-5-6-luna");
const REPEATS = Math.max(1, Number(option("repeats", "1")) || 1);
const JSON_PATH = option("json", "");
const LIVE = flag("live");

const gitOutput = (gitArgs) => {
    try {
        return execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
    } catch {
        return "";
    }
};

/** A dirty tree means the recorded commit does not describe what ran. */
const workingTreeDirty = () => gitOutput(["status", "--porcelain"]).length > 0;

/** Smoke adapter: returns the fixture's own hand-written answer. */
const stubAdapter = (fixture) => async () => ({ output: fixture.stub });

const liveAdapter = async (fixture) => {
    const { createExtractionProviderAdapter } = await import(
        "../lib/memoryExtractionProvider.ts"
    );
    const { AVAILABLE_MODELS } = await import("../lib/models.ts");
    const model = AVAILABLE_MODELS.find((entry) => entry.id === MODEL_ID);
    if (!model) throw new Error(`Unknown model id: ${MODEL_ID}`);
    void fixture;
    return createExtractionProviderAdapter({
        model,
        maxOutputTokens: 2_000,
        onResult: () => {},
    });
};

const main = async () => {
    const startedAt = new Date();
    const perArm = new Map();
    const aggregate = emptyEvalStats();
    const byLanguage = new Map(
        LANGUAGES.map((language) => [language, emptyEvalStats()])
    );
    const records = [];

    for (const category of CATEGORIES) {
        for (const language of LANGUAGES) {
            perArm.set(`${category}:${language}`, emptyEvalStats());
        }
    }

    console.log(
        `${LIVE ? "LIVE" : "SMOKE"} run — dataset ${DATASET_VERSION}, prompt ${MEMORY_EXTRACTION_PROMPT_VERSION}` +
            `${LIVE ? `, model ${MODEL_ID}` : ""}, ${REPEATS} repeat(s) over ${FIXTURES.length} fixtures\n`
    );

    for (const fixture of FIXTURES) {
        const arm = perArm.get(`${fixture.category}:${fixture.language}`);
        for (let repeat = 0; repeat < REPEATS; repeat += 1) {
            let analysis;
            try {
                analysis = await analyzeExtractionChunk({
                    conversations: [fixtureConversation(fixture)],
                    adapter: LIVE
                        ? await liveAdapter(fixture)
                        : stubAdapter(fixture),
                });
            } catch (error) {
                // Never silently dropped from the denominator (§12.2): a
                // provider error is a sample that produced no memory, which is
                // exactly a recall failure.
                const message =
                    error instanceof Error ? error.message : String(error);
                for (const stats of [
                    arm,
                    aggregate,
                    byLanguage.get(fixture.language),
                ]) {
                    scoreEvalProviderError(fixture, stats);
                }
                records.push({
                    fixtureId: fixture.id,
                    repeat,
                    error: message.slice(0, 400),
                });
                continue;
            }

            for (const stats of [
                arm,
                aggregate,
                byLanguage.get(fixture.language),
            ]) {
                scoreEvalSample(fixture, analysis, stats);
            }
            records.push({
                fixtureId: fixture.id,
                repeat,
                category: fixture.category,
                language: fixture.language,
                // Content-free: counts and dispositions, never a statement.
                counts: analysis.counts,
                bulkSafe: analysis.decisions.filter((d) => d.validation.bulkSafe)
                    .length,
                problems: analysis.problems,
            });
        }
    }

    const armReports = [...perArm.entries()].map(([key, stats]) =>
        summarizeEvalStats(
            `category ${key.split(":")[0]} / ${key.split(":")[1]}`,
            stats
        )
    );
    const languageReports = [...byLanguage.entries()].map(([language, stats]) =>
        summarizeEvalStats(`arm ${language}`, stats)
    );
    const aggregateReport = summarizeEvalStats("aggregate", aggregate);

    const fmt = (value) => (value === null ? "n/a" : value.toFixed(4));
    for (const entry of [...armReports, ...languageReports, aggregateReport]) {
        console.log(
            `${entry.label.padEnd(24)} n=${String(entry.samples).padStart(5)}  ` +
                `precision≥${fmt(entry.precisionLower95)}  recall≥${fmt(entry.recallLower95)}  ` +
                `criticalBulkSafe=${entry.criticalBulkSafe}  criticalStored=${entry.criticalStored}  ` +
                `providerErrors=${entry.providerErrors}`
        );
    }

    // §12.3, applied to aggregate AND to every language arm, with no averaging.
    const thresholdChecks = [aggregateReport, ...languageReports].map(
        evaluateThresholds
    );
    const thresholdsMet = thresholdChecks.every((check) => check.passed);

    const underpowered = armReports.filter(
        (entry) => entry.samples < MIN_SAMPLES_PER_CATEGORY_ARM
    );
    const dirty = workingTreeDirty();

    const manifest = {
        datasetVersion: DATASET_VERSION,
        promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
        mode: LIVE ? "live" : "smoke",
        extractionModelId: LIVE ? MODEL_ID : null,
        repeats: REPEATS,
        fixtureCount: FIXTURES.length,
        commitSha: gitOutput(["rev-parse", "HEAD"]) || "unknown",
        gitDirty: dirty,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        minSamplesPerCategoryArm: MIN_SAMPLES_PER_CATEGORY_ARM,
        underpoweredArms: underpowered.map((entry) => entry.label),
        thresholdsMet,
        // The only field that answers "may this be cited in an approval?"
        decisionGrade: LIVE && underpowered.length === 0 && !dirty,
    };

    if (JSON_PATH) {
        const target = resolve(process.cwd(), JSON_PATH);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
            target,
            JSON.stringify(
                {
                    manifest,
                    aggregate: aggregateReport,
                    languages: languageReports,
                    arms: armReports,
                    records,
                },
                null,
                2
            )
        );
        console.log(`\nManifest and per-sample records written to ${target}`);
    }

    console.log("");
    if (!LIVE) {
        console.log(
            "SMOKE RUN — NOT an eval of any model. Every answer came from the fixture's own\n" +
                "stub, so these numbers measure the harness, not an extraction model. Re-run with\n" +
                "--live, a human-approved eval budget (§12.5) and the §12.2 sample counts before\n" +
                "citing anything."
        );
    }
    if (underpowered.length > 0) {
        console.log(
            `\nUNDERPOWERED — ${underpowered.length} of ${armReports.length} category/language arms\n` +
                `ran fewer than ${MIN_SAMPLES_PER_CATEGORY_ARM} samples. §12.2 fixes that floor per arm; below it a\n` +
                "precision or recall bound cannot resolve the threshold it is compared against.\n" +
                "This run is not decision-grade whatever the numbers say."
        );
    }
    if (dirty) {
        console.log(
            "\nWorking tree is dirty, so commitSha does not describe what actually ran.\n" +
                "§12.4 requires a fixed commit; commit or stash before a decision-grade run."
        );
    }
    if (!manifest.decisionGrade) {
        console.log(
            "\nNOT DECISION-GRADE. Approval is a human decision under §12.4 — this script\n" +
                "produces evidence for it and never substitutes for it."
        );
    }

    // The exit code reports whether the RUN was clean, never whether a pair is
    // approved: a green exit here must not read as an approval anywhere.
    const failures = [...armReports, aggregateReport].filter(
        (entry) => entry.criticalBulkSafe > 0 || entry.criticalStored > 0
    );
    if (failures.length > 0) {
        console.log(
            `\nCRITICAL: ${failures.length} arm(s) accepted a candidate that must never be accepted.`
        );
        process.exitCode = 1;
        return;
    }
    process.exitCode = 0;
};

await main();
