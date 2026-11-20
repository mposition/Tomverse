import type {
  ScoutSubmission,
  ScoutSuggestion,
} from "./productResearchScoutCore";
import {
  memorySubject,
  type MemoryReading,
} from "./productResearchScoutMemoryCore";

const evidence = (r: MemoryReading) =>
  `${r.day} · ${r.locale}/${r.mode} · ${r.model} · ${r.outcome} · source visible=${r.visible} · expected A/B/C/D=${Object.values(r.expected).join("/")} · observed=${Object.values(r.answers).join("/")}`;
export function memoryIdeaInput(readings: MemoryReading[]): ScoutSubmission {
  return {
    kind: "catalogue",
    subject: "memory.continuation.ideas",
    language: null,
    images: [],
    signals: [
      "Synthetic imported-chat continuation evaluation, NOT live users. A=ordinary, B=group member before noon, C=same group exactly at noon, D=other group before noon. Counterfactual swaps the qualifying group. UNKNOWN is correct if the final rule is not visible.",
      "Diagnose observed failures only. Omission = automatic source selection removed the final decision, not a hallucination. Format = the output could not be scored reliably. For each actionable improvement give a concrete change and verification example. Prefix each Korean title with the exact [locale] of one affected row, e.g. [zh-Hant]. Do not propose changes for an untested language or claim population accuracy.",
      ...readings.map(evidence),
    ]
      .join("\n")
      .slice(0, 4000),
  };
}
export function verifiedMemoryIdeas(
  readings: MemoryReading[],
  suggestions: ScoutSuggestion[],
  existing: readonly string[],
) {
  const seen = new Set(existing.map((t) => t.trim().toLowerCase()));
  return suggestions.flatMap((s) => {
    const tag = /^\[([a-zA-Z-]+)\]\s+\S/.exec(s.title)?.[1];
    const r = readings.find((x) => x.locale === tag && x.outcome !== "pass");
    const title = s.title.trim().toLowerCase();
    if (!r || seen.has(title)) return [];
    seen.add(title);
    return [
      {
        subject: memorySubject(r.locale),
        suggestion: {
          ...s,
          evidence: [evidence(r), s.evidence].join("\n").slice(0, 1000),
        },
      },
    ];
  });
}
