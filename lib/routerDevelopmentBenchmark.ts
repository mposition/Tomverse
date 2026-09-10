/** Development fixtures only. No provider dispatch, executable checker, or release verdict. */
import { createHash } from "node:crypto";
import type { DevelopmentPlan } from "./routerDevelopmentBenchmarkPlan";

export const DEVELOPMENT_CORPUS_VERSION = "router-development-corpus-v1";
export const DEVELOPMENT_GRADER_VERSION = "router-development-exact-json-v1";
export const DEVELOPMENT_RESULTS_VERSION = "router-development-results-v1";
export const DEVELOPMENT_SCORE_VERSION = "router-development-score-v1";
export const DEVELOPMENT_LIMITS = {
    corpusBytes: 1_048_576,
    documentBytes: 16_777_216,
    answerBytes: 65_536,
    promptBytes: 16_384,
    depth: 32,
    nodes: 200_000,
    models: 256,
} as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
export type DevelopmentCase = {
    id: string;
    language: "ko" | "en";
    task: "structured-extraction" | "grounded-calculation";
    prompt: string;
    expected: JsonObject;
    grading: { kind: "exact-json"; arrayOrder: "ordered"; stringNormalization: "none" };
    requirements: { needsSearch: false; attachments: []; tools: [] };
};
export type DevelopmentCorpus = {
    schemaVersion: typeof DEVELOPMENT_CORPUS_VERSION;
    corpusId: "tomverse-router-development-v1";
    purpose: "development-only";
    cases: DevelopmentCase[];
};

function fail(code: string): never { throw new Error(code); }
export const benchmarkDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// Compare decimal value before and after JS Number conversion, without expanding
// an exponent into a large string. 14.0 and 1.4e1 agree; 14.0000000000000001 does not.
function normalizedDecimal(token: string): string {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
    const fraction = match[3] ?? "";
    const coefficient = `${match[2]}${fraction}`.replace(/^0+/, "");
    if (!coefficient) return "0";
    const exponentText = (match[4] ?? "0").replace(/^[+-]?0+/, "");
    if (exponentText.replace(/^[+-]/, "").length > 6) fail("json_number_precision_loss");
    const exponent = Number(match[4] ?? 0);
    const digits = coefficient.replace(/0+$/, "");
    return `${match[1]}${digits}e${exponent - fraction.length + coefficient.length - digits.length}`;
}

/** Canonical semantic JSON: exact strings/values, sorted object keys, ordered arrays. */
export function canonicalBenchmarkJson(value: unknown): string {
    let nodes = 0;
    const visit = (item: unknown, depth: number): string => {
        if (++nodes > DEVELOPMENT_LIMITS.nodes || depth > DEVELOPMENT_LIMITS.depth) fail("json_complexity_limit");
        if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
        if (typeof item === "number") {
            if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) fail("json_number_out_of_range");
            return JSON.stringify(item);
        }
        if (Array.isArray(item)) {
            if (Object.keys(item).length !== item.length) fail("json_invalid_array");
            return `[${item.map((child) => visit(child, depth + 1)).join(",")}]`;
        }
        if (!item || typeof item !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail("json_invalid_value");
        return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    };
    const text = visit(value, 0);
    if (Buffer.byteLength(text, "utf8") > DEVELOPMENT_LIMITS.documentBytes) fail("json_byte_limit");
    return text;
}

/** JSON.parse alone accepts duplicate keys; this bounded grammar rejects them before grading. */
export function parseBenchmarkJson(text: string, maxBytes: number = DEVELOPMENT_LIMITS.documentBytes): JsonValue {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) fail("json_byte_limit");
    let position = 0;
    let nodes = 0;
    const whitespace = () => { while (position < text.length && /[\t\n\r ]/.test(text[position])) position++; };
    const string = (): string => {
        const start = position++;
        while (position < text.length) {
            const character = text[position++];
            if (character === "\\") { position++; continue; }
            if (character === '"') {
                try { return JSON.parse(text.slice(start, position)) as string; } catch { fail("json_syntax"); }
            }
        }
        return fail("json_syntax");
    };
    const value = (depth: number): JsonValue => {
        if (++nodes > DEVELOPMENT_LIMITS.nodes || depth > DEVELOPMENT_LIMITS.depth) fail("json_complexity_limit");
        whitespace();
        const character = text[position];
        if (character === '"') return string();
        if (character === "{" || character === "[") {
            position++;
            const object: JsonObject = {};
            const array: JsonValue[] = [];
            const keys = new Set<string>();
            const close = character === "{" ? "}" : "]";
            whitespace();
            if (text[position] === close) { position++; return character === "{" ? object : array; }
            while (position < text.length) {
                whitespace();
                if (character === "{") {
                    if (text[position] !== '"') fail("json_syntax");
                    const key = string();
                    if (keys.has(key)) fail("json_duplicate_key");
                    keys.add(key);
                    whitespace();
                    if (text[position++] !== ":") fail("json_syntax");
                    // defineProperty treats __proto__ as data, never a prototype setter.
                    Object.defineProperty(object, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
                } else array.push(value(depth + 1));
                whitespace();
                const separator = text[position++];
                if (separator === close) return character === "{" ? object : array;
                if (separator !== ",") fail("json_syntax");
            }
            return fail("json_syntax");
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(position))?.[0];
        if (!token) return fail("json_syntax");
        position += token.length;
        const parsed = JSON.parse(token) as JsonValue;
        if (typeof parsed === "number" && (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)))) fail("json_number_out_of_range");
        if (typeof parsed === "number" && normalizedDecimal(token) !== normalizedDecimal(JSON.stringify(parsed))) fail("json_number_precision_loss");
        return parsed;
    };
    const parsed = value(0);
    whitespace();
    if (position !== text.length) fail("json_syntax");
    return parsed;
}

export function strictBenchmarkObject(value: unknown, fields: readonly string[], where: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${where}:object_required`);
    const keys = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail(`${where}:unexpected_or_missing_fields`);
    return value as Record<string, unknown>;
}
export function benchmarkString(value: unknown, where: string, maxBytes = 512): string {
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) return fail(`${where}:invalid_string`);
    return value;
}
export const isBenchmarkDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isBenchmarkInstant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function validateDevelopmentCorpus(value: unknown): DevelopmentCorpus {
    const serialized = canonicalBenchmarkJson(value);
    if (Buffer.byteLength(serialized, "utf8") > DEVELOPMENT_LIMITS.corpusBytes) fail("corpus_byte_limit");
    const corpus = strictBenchmarkObject(value, ["schemaVersion", "corpusId", "purpose", "cases"], "corpus");
    if (corpus.schemaVersion !== DEVELOPMENT_CORPUS_VERSION || corpus.corpusId !== "tomverse-router-development-v1" || corpus.purpose !== "development-only") fail("corpus_version_or_purpose");
    if (!Array.isArray(corpus.cases) || corpus.cases.length !== 24) fail("corpus_requires_24_cases");
    const ids = new Set<string>();
    const prompts = new Set<string>();
    const cells = new Map<string, number>();
    for (const candidate of corpus.cases) {
        const item = strictBenchmarkObject(candidate, ["id", "language", "task", "prompt", "expected", "grading", "requirements"], "case");
        const id = benchmarkString(item.id, "case.id", 100);
        if (!/^dev-(en|ko)-(extract|calc)-\d{2}$/.test(id)) fail("case_id_format");
        if (ids.has(id)) fail("duplicate_case_id");
        ids.add(id);
        if (!["ko", "en"].includes(item.language as string) || !["structured-extraction", "grounded-calculation"].includes(item.task as string)) fail("case_cell");
        const prefix = `dev-${item.language}-${item.task === "structured-extraction" ? "extract" : "calc"}-`;
        if (!id.startsWith(prefix)) fail("case_id_cell_mismatch");
        const prompt = benchmarkString(item.prompt, "case.prompt", DEVELOPMENT_LIMITS.promptBytes);
        if (prompts.has(prompt)) fail("duplicate_case_prompt");
        prompts.add(prompt);
        if (!item.expected || typeof item.expected !== "object" || Array.isArray(item.expected) || Object.keys(item.expected).length === 0) fail("expected_nonempty_object_required");
        const grading = strictBenchmarkObject(item.grading, ["kind", "arrayOrder", "stringNormalization"], "grading");
        if (grading.kind !== "exact-json" || grading.arrayOrder !== "ordered" || grading.stringNormalization !== "none") fail("unsupported_grading_rule");
        const requirements = strictBenchmarkObject(item.requirements, ["needsSearch", "attachments", "tools"], "requirements");
        if (requirements.needsSearch !== false || !Array.isArray(requirements.attachments) || requirements.attachments.length !== 0 || !Array.isArray(requirements.tools) || requirements.tools.length !== 0) fail("unsupported_case_requirements_v1");
        const cell = `${item.language}:${item.task}`;
        cells.set(cell, (cells.get(cell) ?? 0) + 1);
    }
    if (cells.size !== 4 || [...cells.values()].some((count) => count !== 6)) fail("corpus_requires_six_per_cell");
    return value as DevelopmentCorpus;
}

export const parseDevelopmentCorpus = (text: string): DevelopmentCorpus => validateDevelopmentCorpus(parseBenchmarkJson(text, DEVELOPMENT_LIMITS.corpusBytes));
export const modelInputForCase = (item: DevelopmentCase): { prompt: string } => ({ prompt: item.prompt });
export function gradeDevelopmentAnswer(item: DevelopmentCase, answerText: string) {
    if (typeof answerText !== "string" || !answerText.trim()) return { pass: false, reason: "blank_answer" as const };
    let actual: JsonValue;
    try { actual = parseBenchmarkJson(answerText, DEVELOPMENT_LIMITS.answerBytes); }
    catch { return { pass: false, reason: "invalid_json" as const }; }
    const pass = canonicalBenchmarkJson(actual) === canonicalBenchmarkJson(item.expected);
    return { pass, reason: pass ? "exact_match" as const : "value_mismatch" as const };
}

export type DevelopmentResultRow = {
    rowId: string; caseId: string; modelId: string; provider: string; apiModel: string;
    promptDigest: string; callConfigDigest: string;
    status: "succeeded" | "failed" | "timeout";
    answerText: string | null; answerDigest: string | null; failureCode: string | null;
    recordedAt: string | null; providerResponseId: string | null; modelVersion: string | null;
    metrics: { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; providerCostUsd: number | null };
};
export type DevelopmentResults = {
    schemaVersion: typeof DEVELOPMENT_RESULTS_VERSION;
    purpose: "development-only"; corpusDigest: string; planDigest: string;
    origin: { kind: "synthetic-fixture" | "externally-saved"; description: string };
    rows: DevelopmentResultRow[];
};

/** Identities and digests bind saved text to a plan. They are not proof of a provider call. */
export function validateDevelopmentResults(value: unknown, plan: DevelopmentPlan): DevelopmentResults {
    canonicalBenchmarkJson(value);
    const results = strictBenchmarkObject(value, ["schemaVersion", "purpose", "corpusDigest", "planDigest", "origin", "rows"], "results");
    if (results.schemaVersion !== DEVELOPMENT_RESULTS_VERSION || results.purpose !== "development-only") fail("results_version_or_purpose");
    if (results.corpusDigest !== plan.corpusDigest || results.planDigest !== plan.planDigest) fail("results_digest_mismatch");
    const origin = strictBenchmarkObject(results.origin, ["kind", "description"], "origin");
    if (origin.kind !== "synthetic-fixture" && origin.kind !== "externally-saved") fail("results_origin");
    benchmarkString(origin.description, "origin.description");
    if (!Array.isArray(results.rows) || results.rows.length > plan.rows.length) fail("results_row_count");
    const planned = new Map(plan.rows.map((row) => [row.rowId, row]));
    const seen = new Set<string>();
    for (const candidate of results.rows) {
        const row = strictBenchmarkObject(candidate, ["rowId", "caseId", "modelId", "provider", "apiModel", "promptDigest", "callConfigDigest", "status", "answerText", "answerDigest", "failureCode", "recordedAt", "providerResponseId", "modelVersion", "metrics"], "result_row");
        if (typeof row.rowId !== "string" || seen.has(row.rowId)) fail("duplicate_or_invalid_result_row");
        seen.add(row.rowId);
        const source = planned.get(row.rowId);
        if (!source) fail("unknown_result_row");
        if (!source!.benchmarkEligibility.eligible) fail("result_for_refused_row");
        for (const key of ["caseId", "modelId", "provider", "apiModel", "promptDigest", "callConfigDigest"] as const) {
            if (row[key] !== source![key]) fail(`result_${key}_mismatch`);
        }
        if (row.status === "succeeded") {
            if (typeof row.answerText !== "string" || Buffer.byteLength(row.answerText, "utf8") > DEVELOPMENT_LIMITS.answerBytes) fail("answer_text_byte_limit_or_type");
            if (!isBenchmarkDigest(row.answerDigest) || row.answerDigest !== benchmarkDigest(row.answerText as string)) fail("answer_digest_mismatch");
            if (row.failureCode !== null) fail("success_with_failure_code");
        } else if (row.status === "failed" || row.status === "timeout") {
            if (row.answerText !== null || row.answerDigest !== null) fail("failed_row_has_answer");
            if (typeof row.failureCode !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(row.failureCode)) fail("failure_code_required");
        } else fail("invalid_result_status");
        if (row.recordedAt !== null && !isBenchmarkInstant(row.recordedAt)) fail("recorded_at_invalid");
        for (const key of ["providerResponseId", "modelVersion"] as const) if (row[key] !== null) benchmarkString(row[key], key);
        const metrics = strictBenchmarkObject(row.metrics, ["inputTokens", "outputTokens", "latencyMs", "providerCostUsd"], "metrics");
        for (const [key, metric] of Object.entries(metrics)) {
            if (metric !== null && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0 || ((key === "inputTokens" || key === "outputTokens") && !Number.isSafeInteger(metric)))) fail("invalid_metric");
        }
        if (origin.kind === "synthetic-fixture" && (Object.values(metrics).some((metric) => metric !== null) || row.recordedAt !== null || row.providerResponseId !== null || row.modelVersion !== null)) fail("synthetic_fixture_claims_provider_observation");
        if (origin.kind === "externally-saved" && row.recordedAt === null) fail("external_recorded_at_required");
    }
    return value as DevelopmentResults;
}

export function scoreDevelopmentResults(corpus: DevelopmentCorpus, plan: DevelopmentPlan, value: unknown) {
    validateDevelopmentCorpus(corpus);
    if (benchmarkDigest(canonicalBenchmarkJson(corpus)) !== plan.corpusDigest) fail("score_corpus_digest_mismatch");
    const results = validateDevelopmentResults(value, plan);
    const resultById = new Map(results.rows.map((row) => [row.rowId, row]));
    const cases = new Map(corpus.cases.map((item) => [item.id, item]));
    const rows = plan.rows.map((planned) => {
        const saved = resultById.get(planned.rowId);
        const verdict = saved?.status === "succeeded" ? gradeDevelopmentAnswer(cases.get(planned.caseId)!, saved.answerText!) : null;
        const outcome = !planned.benchmarkEligibility.eligible ? "refused" : !saved ? "not_run" : saved.status !== "succeeded" ? saved.status : verdict!.reason;
        return { rowId: planned.rowId, caseId: planned.caseId, modelId: planned.modelId, language: planned.language, task: planned.task, outcome, pass: verdict?.pass ?? false };
    });
    const summarize = (group: typeof rows) => {
        const plannedRows = group.filter((row) => row.outcome !== "refused");
        const submitted = plannedRows.filter((row) => row.outcome !== "not_run");
        const passed = submitted.filter((row) => row.pass).length;
        const returnedAnswerRecords = submitted.filter((row) => !["failed", "timeout"].includes(row.outcome)).length;
        return {
            catalogueRows: group.length, planned: plannedRows.length, refused: group.length - plannedRows.length,
            submitted: submitted.length, returnedAnswerRecords, notRun: plannedRows.length - submitted.length, passed,
            incorrect: submitted.filter((row) => row.outcome === "value_mismatch").length,
            blank: submitted.filter((row) => row.outcome === "blank_answer").length,
            invalidJson: submitted.filter((row) => row.outcome === "invalid_json").length,
            failed: submitted.filter((row) => row.outcome === "failed").length,
            timeout: submitted.filter((row) => row.outcome === "timeout").length,
            coverage: plannedRows.length ? submitted.length / plannedRows.length : null,
            // Partial runs have no headline correctness rate. Pending work is not a model failure.
            correctnessRate: plannedRows.length > 0 && submitted.length === plannedRows.length ? passed / plannedRows.length : null,
            correctShareOfPlanned: submitted.length > 0 && plannedRows.length > 0 ? passed / plannedRows.length : null,
        };
    };
    const metricSummary = (field: keyof DevelopmentResultRow["metrics"]) => {
        const observed = results.rows.flatMap((row) => row.metrics[field] === null ? [] : [row.metrics[field]!]);
        return { observedRows: observed.length, submittedRows: results.rows.length, total: observed.length > 0 && observed.length === results.rows.length ? observed.reduce((sum, number) => sum + number, 0) : null };
    };
    return {
        schemaVersion: DEVELOPMENT_SCORE_VERSION, purpose: "development-only", graderVersion: DEVELOPMENT_GRADER_VERSION,
        corpusDigest: plan.corpusDigest, planDigest: plan.planDigest,
        resultsDigest: benchmarkDigest(canonicalBenchmarkJson(results)), origin: results.origin,
        evidenceStatus: results.origin.kind === "synthetic-fixture" ? "fixture_validation_only" : "self_reported_saved_answers_unverified",
        providerCallsByThisTool: 0, incurredProviderSpendUsdByThisTool: 0, verifiedActualGenerations: 0,
        summary: summarize(rows),
        byModel: plan.models.map((model) => ({ modelId: model.modelId, ...summarize(rows.filter((row) => row.modelId === model.modelId)) })),
        byModelTaskLanguage: plan.models.flatMap((model) => ["ko", "en"].flatMap((language) => ["structured-extraction", "grounded-calculation"].map((task) => ({ modelId: model.modelId, language, task, ...summarize(rows.filter((row) => row.modelId === model.modelId && row.language === language && row.task === task)) })))),
        reportedMetrics: { inputTokens: metricSummary("inputTokens"), outputTokens: metricSummary("outputTokens"), latencyMs: metricSummary("latencyMs"), providerCostUsd: metricSummary("providerCostUsd") },
        rows,
        limitations: ["Synthetic candidates, not human-adopted evaluation items or release evidence.", "No confidence intervals, quality-band changes, or production-readiness verdict.", "Hashes bind records; externally saved origin and provider metrics remain self-reported.", "A missing row is not_run, not a model failure; headline correctness requires complete planned coverage."],
    };
}
