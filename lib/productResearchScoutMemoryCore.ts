import { createHash } from "node:crypto";
import { selectPassageText } from "./continuationPassages";
import { planContinuationSeed } from "./externalContinuationSeedCore";
import { buildContinuationSeedPrompt } from "./externalContinuationSeedPrompt";
import {
  MEMORY_CASE_COPY,
  MEMORY_PROBE_LOCALES,
  type MemoryProbeLocale,
} from "./productResearchScoutMemoryCases";

export const MEMORY_PROBE_VERSION = "continuation-decisions-v1";
export const MEMORY_MODES = [
  "recent",
  "counterfactual",
  "long-auto",
  "picked",
  "empty",
] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];
const fields = ["A", "B", "C", "D"] as const;
export type Decisions = Record<(typeof fields)[number], string>;
export const memorySubject = (locale: MemoryProbeLocale) =>
  `memory.continuation.${locale}`;
export const memoryLatestKey = (locale: MemoryProbeLocale) =>
  `productResearch.memoryQuality.${locale}`;
export function dailyMemoryMode(
  day: string,
  locale: MemoryProbeLocale,
): MemoryMode {
  const index =
    Math.floor(Date.parse(day + "T00:00:00Z") / 86400000) +
    MEMORY_PROBE_LOCALES.indexOf(locale);
  return MEMORY_MODES[index % MEMORY_MODES.length]!;
}
export function memoryProbeSource(
  day: string,
  locale: MemoryProbeLocale,
  mode: MemoryMode,
  identityLocale: MemoryProbeLocale = locale,
) {
  const digest = createHash("sha256")
    .update([MEMORY_PROBE_VERSION, day, identityLocale.replace("-", "")].join("/"))
    .digest("hex");
  // Codes have the same shape; they cannot identify a decision by their prefix.
  const values = {
    old: "R-" + digest.slice(0, 6),
    main: "R-" + digest.slice(6, 12),
    special: "R-" + digest.slice(12, 18),
    group: "G-" + digest.slice(18, 22),
    other: "G-" + digest.slice(22, 26),
  };
  const render = (s: string, flip = false) =>
    s.replace(
      /\{(old|main|special|group|other)\}/g,
      (_, k: keyof typeof values) =>
        values[flip && k === "group" ? "other" : k],
    );
  const [draft, filler, decision, query] = MEMORY_CASE_COPY[locale];
  const final = render(decision, mode === "counterfactual");
  const long = mode === "long-auto" || mode === "picked";
  const latest =
    (long
      ? (filler + " ").repeat(Math.ceil(4500 / filler.length)) + "\n"
      : "") + final;
  const rows = [
    { role: "user", ordinal: 0, content: render(draft), truncated: false },
    { role: "user", ordinal: 1, content: latest, truncated: false },
  ];
  const selected =
    mode === "empty"
      ? []
      : mode === "picked"
        ? selectPassageText(rows, [
            {
              ordinal: 1,
              start: latest.length - final.length,
              end: latest.length,
            },
          ])
        : rows;
  const gold: Decisions = {
    A: values.main,
    B: mode === "counterfactual" ? values.main : values.special,
    C: values.main,
    D: mode === "counterfactual" ? values.special : values.main,
  };
  return { day, locale, mode, selected, final, question: render(query), gold };
}

export function renderMemoryProbe(
  source: ReturnType<typeof memoryProbeSource>,
  plan: ReturnType<typeof planContinuationSeed>,
) {
  const { day, locale, mode, final, question, gold } = source;
  const seed = buildContinuationSeedPrompt({
    provider: "chatgpt",
    importedAt: day,
    plan,
  });
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (seed.rulesText && seed.transcriptText)
    messages.push(
      { role: "system", content: seed.rulesText },
      { role: "user", content: seed.transcriptText },
    );
  messages.push({ role: "user", content: question });
  const visible = Boolean(final && seed.transcriptText?.includes(final));
  const expected: Decisions = visible
    ? gold
    : { A: "UNKNOWN", B: "UNKNOWN", C: "UNKNOWN", D: "UNKNOWN" };
  return {
    day,
    locale,
    mode,
    visible,
    gold,
    expected,
    messages,
    usedTurns: seed.usedTurnCount,
    promptDigest: createHash("sha256")
      .update(JSON.stringify(messages))
      .digest("hex"),
  };
}
export function memoryProbe(day: string, locale: MemoryProbeLocale, mode: MemoryMode) {
  const source = memoryProbeSource(day, locale, mode);
  return renderMemoryProbe(source, planContinuationSeed({ messages: source.selected }));
}

export type MemoryProbe = ReturnType<typeof memoryProbe>;
export function assessMemory(probe: MemoryProbe, raw: string) {
  // No second model sees an answer key. Score the four actions, not prose fluency.
  let parsed: Record<string, unknown> = {};
  try {
    const obj: unknown = JSON.parse(
      raw.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ""),
    );
    if (obj && typeof obj === "object" && !Array.isArray(obj))
      parsed = obj as Record<string, unknown>;
  } catch {
    /* Invalid model output is evidence, not a transport failure. */
  }
  const wellFormed = fields.every(
    (k) =>
      typeof parsed[k] === "string" &&
      /^(?:UNKNOWN|R-[a-f0-9]{6})$/.test(String(parsed[k])),
  );
  const answers = Object.fromEntries(
    fields.map((k) => [
      k,
      typeof parsed[k] === "string" &&
      /^(?:UNKNOWN|R-[a-f0-9]{6})$/.test(String(parsed[k]))
        ? parsed[k]
        : "INVALID",
    ]),
  ) as Decisions;
  const wrong = fields.filter((k) => answers[k] !== probe.expected[k]);
  return {
    answers,
    wellFormed,
    wrong,
    grounded: wellFormed && !wrong.length,
    originalCorrect:
      wellFormed && fields.every((k) => answers[k] === probe.gold[k]),
    reason:
      typeof parsed.reason === "string" ? parsed.reason.slice(0, 350) : "",
  };
}
export type MemoryAssessment = ReturnType<typeof assessMemory>;
export function memoryOutcome(probe: MemoryProbe, result: MemoryAssessment) {
  if (!result.wellFormed) return "format" as const;
  if (!result.grounded)
    return probe.visible ? ("decision" as const) : ("unsupported" as const);
  if (!probe.visible && probe.mode === "long-auto") return "omission" as const;
  return "pass" as const;
}
export type MemoryReading = {
  version: string;
  day: string;
  locale: MemoryProbeLocale;
  mode: MemoryMode;
  model: string;
  outcome: ReturnType<typeof memoryOutcome>;
  visible: boolean;
  usedTurns: number;
  expected: Decisions;
  answers: Decisions;
  originalCorrect: boolean;
};
export function memoryReading(
  probe: MemoryProbe,
  result: MemoryAssessment,
  model: string,
): MemoryReading {
  return {
    version: MEMORY_PROBE_VERSION,
    day: probe.day,
    locale: probe.locale,
    mode: probe.mode,
    model,
    outcome: memoryOutcome(probe, result),
    visible: probe.visible,
    usedTurns: probe.usedTurns,
    expected: probe.expected,
    answers: result.answers,
    originalCorrect: result.originalCorrect,
  };
}

/** Ignore incomplete or stale-format settings instead of treating them as a measurement. */
export function parseMemoryReading(
  key: string,
  raw: string,
): MemoryReading | null {
  try {
    const v = JSON.parse(raw) as Partial<MemoryReading> | null;
    if (
      !v ||
      !v.locale ||
      !MEMORY_PROBE_LOCALES.includes(v.locale) ||
      key !== memoryLatestKey(v.locale) ||
      v.version !== MEMORY_PROBE_VERSION ||
      typeof v.day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.day) ||
      !v.mode ||
      !MEMORY_MODES.includes(v.mode) ||
      typeof v.model !== "string" ||
      !v.model.trim() ||
      !v.outcome ||
      !["pass", "decision", "unsupported", "omission", "format"].includes(
        v.outcome,
      ) ||
      typeof v.visible !== "boolean" ||
      typeof v.originalCorrect !== "boolean" ||
      !Number.isInteger(v.usedTurns) ||
      v.usedTurns! < 0 ||
      !fields.every(
        (k) =>
          /^(?:UNKNOWN|R-[a-f0-9]{6})$/.test(v.expected?.[k] ?? "") &&
          /^(?:UNKNOWN|INVALID|R-[a-f0-9]{6})$/.test(v.answers?.[k] ?? ""),
      )
    )
      return null;
    return v as MemoryReading;
  } catch {
    return null;
  }
}
