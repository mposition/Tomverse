/**
 * Structural validation only. A parsed profile is an untrusted model signal,
 * not proof of semantic preservation, routing quality or dispatch authority.
 */
import { parseBenchmarkJson } from "./routerDevelopmentBenchmark";
import {
  PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES,
  validatePromptRefinerVnextSourceText,
} from "./promptRefinerQualityEvaluationVnextCore";
import {
  TASK_KINDS,
  type ExpectedOutputLength,
  type TaskKind,
} from "./taskProfileCore";

export const CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION = "unified-router-refiner-v1" as const;
export const CHAT_UNIFIED_TASK_DIFFICULTIES = Object.freeze([
  "simple", "standard", "complex", "unknown",
] as const);
export type ChatUnifiedTaskDifficulty = (typeof CHAT_UNIFIED_TASK_DIFFICULTIES)[number];

export type ChatUnifiedRouterAnalysis = Readonly<{
  kind: TaskKind;
  difficulty: ChatUnifiedTaskDifficulty;
  expectedOutputLength: ExpectedOutputLength;
  needsCurrentInformation: boolean;
}>;
export type ChatUnifiedRouterRefinerOutput = Readonly<{
  schemaVersion: typeof CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION;
  analysis: ChatUnifiedRouterAnalysis;
  rewrite: Readonly<
    | { decision: "keep_original"; text: null }
    | { decision: "rewrite"; text: string }
  >;
}>;

const OUTPUT_LENGTHS = ["short", "medium", "long"] as const satisfies readonly ExpectedOutputLength[];
const fail = (code: string): never => { throw new Error(code); };

/** Copy descriptors, never invoking a value accessor on an object caller. */
function dataObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" ||
        Object.getPrototypeOf(value) !== Object.prototype) return fail("unified_invalid_object");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) =>
      typeof key !== "string" || !fields.includes(key))) return fail("unified_invalid_fields");
    const result: Record<string, unknown> = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return fail("unified_invalid_descriptor");
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    return fail("unified_invalid_structure");
  }
}

export function validateChatUnifiedRouterRefinerOutput(
  value: unknown,
  sourceText: string,
): ChatUnifiedRouterRefinerOutput {
  const source = validatePromptRefinerVnextSourceText(sourceText);
  const output = dataObject(value, ["schemaVersion", "analysis", "rewrite"]);
  if (output.schemaVersion !== CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION) {
    return fail("unified_schema_version");
  }
  const analysis = dataObject(output.analysis, [
    "kind", "difficulty", "expectedOutputLength", "needsCurrentInformation",
  ]);
  if (!(TASK_KINDS as readonly unknown[]).includes(analysis.kind) ||
      !(CHAT_UNIFIED_TASK_DIFFICULTIES as readonly unknown[]).includes(analysis.difficulty) ||
      !(OUTPUT_LENGTHS as readonly unknown[]).includes(analysis.expectedOutputLength) ||
      typeof analysis.needsCurrentInformation !== "boolean") {
    return fail("unified_invalid_analysis");
  }
  const proposedRewrite = dataObject(output.rewrite, ["decision", "text"]);
  let rewrite: ChatUnifiedRouterRefinerOutput["rewrite"];
  if (proposedRewrite.decision === "keep_original" && proposedRewrite.text === null) {
    rewrite = Object.freeze({ decision: "keep_original", text: null });
  } else if (proposedRewrite.decision === "rewrite") {
    const text = validatePromptRefinerVnextSourceText(proposedRewrite.text);
    // A whitespace-only change is not an accepted rewrite. Do not trim source.
    rewrite = text.trim() === source.trim()
      ? Object.freeze({ decision: "keep_original", text: null })
      : Object.freeze({ decision: "rewrite", text });
  } else {
    return fail("unified_invalid_rewrite");
  }
  return Object.freeze({
    schemaVersion: CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION,
    analysis: Object.freeze({
      kind: analysis.kind as TaskKind,
      difficulty: analysis.difficulty as ChatUnifiedTaskDifficulty,
      expectedOutputLength: analysis.expectedOutputLength as ExpectedOutputLength,
      needsCurrentInformation: analysis.needsCurrentInformation,
    }),
    rewrite,
  });
}

/** Bounded exact JSON; duplicate keys and repair/partial salvage are rejected. */
export function parseChatUnifiedRouterRefinerOutput(
  text: string,
  sourceText: string,
): ChatUnifiedRouterRefinerOutput {
  if (typeof text !== "string" || !text.trim() || text.charCodeAt(0) === 0xfeff) {
    return fail("unified_invalid_response");
  }
  if (Buffer.byteLength(text, "utf8") > PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES) {
    return fail("unified_output_byte_limit");
  }
  let value: unknown;
  try {
    value = parseBenchmarkJson(text, PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES);
  } catch {
    return fail("unified_strict_parse_failure");
  }
  return validateChatUnifiedRouterRefinerOutput(value, sourceText);
}
