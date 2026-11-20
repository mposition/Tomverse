import { createHash } from "node:crypto";
import {
  planContinuationSeed,
  type ContinuationSourceMessage,
} from "./externalContinuationSeedCore";
import {
  CONTINUATION_SEED_RULES,
  CONTINUATION_SEED_MARKERS,
} from "./externalContinuationSeedPrompt";
import {
  assessMemory,
  memoryProbeSource,
  renderMemoryProbe,
} from "./productResearchScoutMemoryCore";
import {
  MEMORY_CASE_COPY,
  MEMORY_PROBE_LOCALES,
  type MemoryProbeLocale,
} from "./productResearchScoutMemoryCases";

export const ARM_NAMES = ["current", "cohere", "oracle"] as const;
export type Arm = (typeof ARM_NAMES)[number];
export const SCENARIOS = [
  "buried",
  "superseded",
  "cross-language",
  "absent",
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const EXPERIMENT_VERSION = "memory-retrieval-1";
export const RERANK_MODEL = "rerank-v5.0-fast";

export function dailyScenario(
  day: string,
  locale: MemoryProbeLocale,
): Scenario {
  return SCENARIOS[
    (Math.floor(Date.parse(day + "T00:00:00Z") / 86400000) +
      MEMORY_PROBE_LOCALES.indexOf(locale)) %
      SCENARIOS.length
  ]!;
}

export function experimentCase(
  day: string,
  locale: MemoryProbeLocale,
  scenario: Scenario,
) {
  const sourceLanguage =
    scenario === "cross-language" ? (locale === "en" ? "ko" : "en") : locale;
  const mode = scenario === "superseded" ? "counterfactual" : "recent";
  const question = memoryProbeSource(day, locale, mode);
  const evidence = memoryProbeSource(day, sourceLanguage, mode, locale);
  const filler = MEMORY_CASE_COPY[sourceLanguage][1];
  // Notes fill the newest-turn budget. The relevant booking decision occurs in
  // the middle and never contains a label or an index supplied by the grader.
  const notes = Array.from({ length: 13 }, (_, i) =>
    Array.from(
      { length: Math.ceil(950 / filler.length) },
      (_, j) => `(${i + 1}.${j + 1}) ${filler}`,
    ).join(" "),
  );
  const middle = scenario === "superseded" ? 6 : 4;
  notes[1] = evidence.selected[0]!.content;
  if (scenario === "superseded")
    notes[3] = memoryProbeSource(day, sourceLanguage, "recent", locale).final;
  const original =
    scenario === "absent"
      ? { A: "UNKNOWN", B: "UNKNOWN", C: "UNKNOWN", D: "UNKNOWN" }
      : question.gold;
  if (scenario !== "absent") notes[middle] = evidence.final;
  const rows: ContinuationSourceMessage[] = notes.map((content, ordinal) => ({
    role: ordinal % 2 ? "user" : "assistant",
    ordinal,
    content,
    truncated: false,
  }));
  // Chronology is a legitimate retrieval feature, including for a superseded decision.
  const documents = rows.map((row) => `[${row.ordinal}] ${row.content}`);
  const source = {
    ...question,
    final: scenario === "absent" ? "" : evidence.final,
    gold: original,
  };
  const digest = createHash("sha256")
    .update(
      JSON.stringify([EXPERIMENT_VERSION, scenario, rows, question.question]),
    )
    .digest("hex");
  return {
    source,
    rows,
    documents,
    scenario,
    sourceLanguage,
    digest,
    goldOrdinals: scenario === "absent" ? [] : [middle],
  };
}
export type ExperimentCase = ReturnType<typeof experimentCase>;

export function armProbe(
  c: ExperimentCase,
  arm: Arm,
  ranked?: readonly number[],
) {
  const indices = arm === "oracle" ? c.goldOrdinals : ranked;
  if (arm === "cohere" && !indices) throw Error("Cohere indices are required");
  const rows =
    arm === "current"
      ? c.rows
      : c.rows.filter((row) => indices!.includes(row.ordinal));
  const result = renderMemoryProbe(
    c.source,
    planContinuationSeed({ messages: rows, sourceMessageCount: c.rows.length }),
  );
  if (!result.usedTurns) {
    // Keep the answering instructions fixed even when the oracle has no evidence.
    result.messages.unshift(
      { role: "system", content: CONTINUATION_SEED_RULES },
      {
        role: "user",
        content: [
          CONTINUATION_SEED_MARKERS.open,
          "Excerpt: 0 stored messages selected.",
          CONTINUATION_SEED_MARKERS.close,
        ].join("\n"),
      },
    );
    result.promptDigest = createHash("sha256")
      .update(JSON.stringify(result.messages))
      .digest("hex");
  }
  return result;
}
export function scoreArm(
  c: ExperimentCase,
  probe: ReturnType<typeof armProbe>,
  raw: string,
) {
  const score = assessMemory(probe, raw);
  const gold = c.source.gold;
  const { A, B, C, D } = score.answers;
  return {
    retrieved: c.scenario === "absent" ? null : probe.visible,
    exact: score.originalCorrect,
    decision: A === gold.A,
    exceptions: B === gold.B && C === gold.C && D === gold.D,
    correctFields: [
      A === gold.A,
      B === gold.B,
      C === gold.C,
      D === gold.D,
    ].filter(Boolean).length,
    abstained: [A, B, C, D].every((x) => x === "UNKNOWN"),
  };
}

export type Trial = ReturnType<typeof scoreArm> & {
  version: typeof EXPERIMENT_VERSION;
  day: string;
  locale: MemoryProbeLocale;
  scenario: Scenario;
  arm: Arm;
  model: string;
  sourceDigest: string;
  elapsedMs: number;
  retrievalMs: number;
  answerMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  rerankTokens: number | null;
  answerMicroUsd: number | null;
  retrievalMicroUsd: number | null;
  measuredAt: string;
};
export function trialStats(rows: readonly Trial[]) {
  const supported = rows.filter((r) => r.retrieved !== null);
  const controls = rows.filter((r) => r.retrieved === null);
  const known = rows.filter(
    (r) => r.answerMicroUsd !== null && r.retrievalMicroUsd !== null,
  );
  return {
    n: rows.length,
    retrieved: supported.filter((r) => r.retrieved).length,
    sources: supported.length,
    exact: supported.filter((r) => r.exact).length,
    decision: supported.filter((r) => r.decision).length,
    exceptions: supported.filter((r) => r.exceptions).length,
    controls: controls.length,
    abstained: controls.filter((r) => r.abstained).length,
    elapsedMs: rows.length
      ? rows.reduce((s, r) => s + r.elapsedMs, 0) / rows.length
      : null,
    priced: known.length,
    meanMicroUsd:
      rows.length && known.length === rows.length
        ? known.reduce(
            (s, r) => s + r.answerMicroUsd! + r.retrievalMicroUsd!,
            0,
          ) / known.length
        : null,
  };
}

export function summarizeTrials(rows: readonly Trial[], model: string | null) {
  const matching = rows.filter((r) => r.model === model);
  const groups = new Map<string, Set<Arm>>();
  const id = (r: Trial) =>
    [r.day, r.locale, r.scenario, r.sourceDigest].join("/");
  for (const r of matching) {
    const key = id(r);
    const g = groups.get(key) ?? new Set<Arm>();
    g.add(r.arm);
    groups.set(key, g);
  }
  return MEMORY_PROBE_LOCALES.map((locale) => {
    const observed = matching.filter((r) => r.locale === locale);
    const paired = observed.filter(
      (r) => groups.get(id(r))?.size === ARM_NAMES.length,
    );
    return {
      locale,
      observed: observed.length,
      pairs: paired.length / ARM_NAMES.length,
      arms: ARM_NAMES.map((arm) => ({
        arm,
        ...trialStats(paired.filter((r) => r.arm === arm)),
      })),
    };
  });
}
