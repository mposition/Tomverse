import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { planContinuationSeed } from "../lib/externalContinuationSeedCore.ts";
import { MEMORY_CASE_COPY, MEMORY_PROBE_LOCALES } from "../lib/productResearchScoutMemoryCases.ts";
import { memoryProbeSource, renderMemoryProbe } from "../lib/productResearchScoutMemoryCore.ts";
import { inertSeedTurn } from "../lib/externalContinuationSeedPrompt.ts";

// Load the unmodified planner exported from the comparison commit. Never ship
// the retired selection algorithm in the application or reproduce it by hand.
export async function* compareExcerptCases(day, oldPlannerPath) {
  const { planContinuationSeed: before } = await import(pathToFileURL(resolve(oldPlannerPath)).href);
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for (const [index, locale] of MEMORY_PROBE_LOCALES.entries()) {
    const long = memoryProbeSource(day, locale, "long-auto");
    const swapped = memoryProbeSource(day, locale, "counterfactual");
    const filler = MEMORY_CASE_COPY[locale][1];
    const notes = long.selected[1].content.slice(0, -long.final.length);
    const splitDecision = swapped.final.replace(/([.。])\s*/u, "$1\n\n");
    const unknown = { A: "UNKNOWN", B: "UNKNOWN", C: "UNKNOWN", D: "UNKNOWN" };
    const layouts = [
      ["closing", long, notes + long.final],
      ["swapped-before-footer", { ...swapped, final: inertSeedTurn(splitDecision) }, notes + splitDecision + "\n\n" + filler],
      ["before-later-turn", long, notes + long.final],
      ["opening", long, long.final + "\n\n" + notes],
      ["no-decision", { ...long, final: "", gold: unknown }, notes + long.selected[0].content],
    ];
    for (const [scenario, source, content] of layouts) {
      const selected = [source.selected[0], { ...source.selected[1], content }];
      if (scenario === "before-later-turn") {
        selected.unshift(...Array.from({ length: 20 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user", ordinal: index - 20, content: filler, truncated: false,
        })));
        // Use the same non-negative ordinals as stored imported turns.
        selected.forEach((row, index) => { selected[index] = { ...row, ordinal: index }; });
        selected.push({ role: "assistant", ordinal: selected.length, content: filler, truncated: false });
      }
      const sourceDigest = hash({ selected, question: source.question });
      const arms = [["before", before], ["after", planContinuationSeed]];
      if (index % 2) arms.reverse();
      for (const [arm, planner] of arms) {
        const plan = planner({ messages: selected });
        yield {
          probe: renderMemoryProbe(source, plan),
          details: {
            arm, scenario, sourceDigest, seedVersion: plan.seedVersion, estimatedTokens: plan.estimatedTokens,
            turnCodePoints: plan.turns.map((turn) => Array.from(turn.text).length),
          },
        };
      }
    }
  }
}
