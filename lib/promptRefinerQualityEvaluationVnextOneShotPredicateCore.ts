/**
 * Pure, development-only predicate atoms for synthetic witness fixtures.
 * No regex, script, arbitrary path, model or provider execution is allowed.
 * Passing atoms cannot establish semantic truth, seal a manifest or admit a run.
 */
import { parseBenchmarkJson, strictBenchmarkObject } from "./routerDevelopmentBenchmark";

const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_LITERAL_BYTES = 512;
const MAX_KEYS = 16;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const fail = (code: string): never => { throw new Error(code); };

export type PromptRefinerVnextOneShotPredicate =
    | Readonly<{ kind: "literal_present" | "literal_absent"; literal: string }>
    | Readonly<{ kind: "single_line" }>
    | Readonly<{ kind: "json_object_keys"; keys: readonly string[] }>;

/** Validate a closed data-only atom before using it with fixture text. */
export function validatePromptRefinerVnextOneShotPredicate(
    candidate: unknown
): PromptRefinerVnextOneShotPredicate {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return fail("vnext_one_shot_predicate_shape_invalid");
    }
    const kind = (candidate as Record<string, unknown>).kind;
    if (kind === "literal_present" || kind === "literal_absent") {
        let item: Record<string, unknown>;
        try {
            item = strictBenchmarkObject(candidate, ["kind", "literal"], "vnext_one_shot_predicate");
        } catch {
            return fail("vnext_one_shot_predicate_shape_invalid");
        }
        if (typeof item.literal !== "string" || !item.literal.trim() ||
            Buffer.byteLength(item.literal, "utf8") > MAX_LITERAL_BYTES) {
            return fail("vnext_one_shot_predicate_literal_invalid");
        }
        return Object.freeze({ kind, literal: item.literal });
    }
    if (kind === "single_line") {
        try {
            strictBenchmarkObject(candidate, ["kind"], "vnext_one_shot_predicate");
        } catch {
            return fail("vnext_one_shot_predicate_shape_invalid");
        }
        return Object.freeze({ kind });
    }
    if (kind === "json_object_keys") {
        let item: Record<string, unknown>;
        try {
            item = strictBenchmarkObject(candidate, ["kind", "keys"], "vnext_one_shot_predicate");
        } catch {
            return fail("vnext_one_shot_predicate_shape_invalid");
        }
        if (!Array.isArray(item.keys) || item.keys.length < 1 || item.keys.length > MAX_KEYS ||
            item.keys.some((key) => typeof key !== "string" || !KEY.test(key)) ||
            new Set(item.keys).size !== item.keys.length) {
            return fail("vnext_one_shot_predicate_keys_invalid");
        }
        return Object.freeze({ kind, keys: Object.freeze([...item.keys] as string[]) });
    }
    return fail("vnext_one_shot_predicate_kind_invalid");
}

/** A boolean fixture check only; it makes no assertion about holdout quality. */
export function evaluatePromptRefinerVnextOneShotPredicate(
    candidate: unknown,
    output: string
): boolean {
    const predicate = validatePromptRefinerVnextOneShotPredicate(candidate);
    if (typeof output !== "string" || !output.trim() ||
        Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
        return fail("vnext_one_shot_predicate_output_invalid");
    }
    switch (predicate.kind) {
        case "literal_present": return output.includes(predicate.literal);
        case "literal_absent": return !output.includes(predicate.literal);
        case "single_line": return !/[\r\n\u2028\u2029]/u.test(output);
        case "json_object_keys": {
            let parsed: unknown;
            try {
                parsed = parseBenchmarkJson(output, MAX_OUTPUT_BYTES);
            } catch {
                return false;
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                return false;
            }
            const actual = Object.keys(parsed).sort();
            const expected = [...predicate.keys].sort();
            return actual.length === expected.length &&
                actual.every((key, index) => key === expected[index]);
        }
    }
}
