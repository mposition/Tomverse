#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";

import { summarizePromptRefinerReceipts } from "../lib/promptRefinerReceiptCore.ts";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

const parseArguments = (argumentsList) => {
    let inputPath = null;
    let json = false;
    for (const argument of argumentsList) {
        if (argument === "--json") {
            json = true;
            continue;
        }
        if (argument.startsWith("--input=")) {
            if (inputPath !== null) {
                throw new Error("prompt_refiner_report_duplicate_input");
            }
            inputPath = argument.slice("--input=".length);
            continue;
        }
        throw new Error("prompt_refiner_report_unknown_argument");
    }
    if (!inputPath) throw new Error("prompt_refiner_report_input_required");
    return { inputPath, json };
};

const percent = (value) =>
    value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
const latency = (value) => (value === null ? "n/a" : `${value}ms`);

const printHumanReport = (summary) => {
    console.log("Prompt Refiner receipt report");
    console.log(`requests                     ${summary.requests}`);
    console.log(
        `suggested / failed / refused ${summary.outcomes.suggested} / ${summary.outcomes.failed} / ${summary.outcomes.refusedBeforeDispatch}`
    );
    console.log(
        `suggestion yield              ${percent(summary.suggestionYieldRate)} (${summary.outcomes.suggested}/${summary.requests})`
    );
    console.log(
        `dispatched failure            ${percent(summary.dispatchedFailureRate)} (${summary.dispatchedFailures}/${summary.dispatched})`
    );
    console.log(
        `preparation p50 / p95         ${latency(summary.suggestionPreparationLatencyMs.p50)} / ${latency(summary.suggestionPreparationLatencyMs.p95)} (n=${summary.suggestionPreparationLatencyMs.count})`
    );
    console.log(
        `stale per request             ${percent(summary.dispositions.staleRequestRate)} (${summary.dispositions.stale}/${summary.requests})`
    );
    console.log(
        `explicit choice per suggestion ${percent(summary.dispositions.explicitChoiceRatePerSuggestion)} (${summary.dispositions.explicitChoices}/${summary.outcomes.suggested})`
    );
    console.log(
        `accepted per explicit choice  ${percent(summary.dispositions.acceptanceRatePerChoice)} (${summary.dispositions.accepted}/${summary.dispositions.explicitChoices})`
    );
    console.log(
        `cost telemetry                ${summary.telemetry.actualCostMicroUsd.reported}/${summary.telemetry.actualCostMicroUsd.population} dispatched; total ${summary.telemetry.actualCostMicroUsd.total} microUSD`
    );
    console.log(`unattributed requests        ${summary.unattributedRequests}`);
    if (summary.byProviderModel.length > 0) {
        console.log("provider/model breakdown");
        for (const row of summary.byProviderModel) {
            console.log(
                `  ${row.provider}/${row.modelId}: requests=${row.requests}, suggested=${row.suggested}, failed=${row.failed}, refused=${row.refusedBeforeDispatch}`
            );
        }
    }
    console.log(
        "Descriptive telemetry only: this report does not judge quality, release readiness, or rollout approval."
    );
};

try {
    const options = parseArguments(process.argv.slice(2));
    const metadata = await stat(options.inputPath);
    if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) {
        throw new Error("prompt_refiner_report_input_too_large_or_not_a_file");
    }
    const bytes = await readFile(options.inputPath);
    let input;
    try {
        input = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new Error("prompt_refiner_report_invalid_json");
    }
    let summary;
    try {
        summary = summarizePromptRefinerReceipts(input);
    } catch {
        // Schema diagnostics can contain received values. The report must not
        // echo malformed input because a forbidden prompt field is exactly the
        // kind of malformed receipt this boundary is designed to reject.
        throw new Error("prompt_refiner_report_schema_invalid");
    }
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else printHumanReport(summary);
} catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.error(`Prompt Refiner receipt report failed: ${message}`);
    process.exitCode = 1;
}
