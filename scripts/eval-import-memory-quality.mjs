// A reproducible, synthetic, no-credentials evaluation against a loopback inference server.
import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { MEMORY_PROBE_LOCALES } from "../lib/productResearchScoutMemoryCases.ts";
import {
  MEMORY_MODES,
  MEMORY_PROBE_VERSION,
  memoryProbe,
  assessMemory,
} from "../lib/productResearchScoutMemoryCore.ts";
const [
  endpoint,
  model,
  output,
  day = new Date().toISOString().slice(0, 10),
  variant = "baseline",
  oldPlannerPath,
] = process.argv.slice(2);
if (!endpoint || !model || !output || !/^\d{4}-\d{2}-\d{2}$/.test(day))
  throw Error(
    "Usage: node --import tsx scripts/eval-import-memory-quality.mjs http://127.0.0.1:PORT MODEL OUTPUT [UTC-DAY] [baseline|candidate|compare-excerpts OLD-PLANNER.ts]",
  );
const url = new URL(endpoint);
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.username ||
  url.password
)
  throw Error("Use a loopback inference endpoint");
if (!["baseline", "candidate", "compare-excerpts", "fidelity-baseline", "fidelity-source-order-v1"].includes(variant))
  throw Error("Unknown prompt variant");
const fidelity = variant.startsWith("fidelity-");
const { CONTINUATION_FIDELITY_VERSION, FIDELITY_PROMPT_CANDIDATE } = await import("../lib/continuationFidelityProbe.ts");
const candidate =
  "Distinguish a proposal from the latest confirmed decision. For each case independently, apply the confirmed default unless every stated exception condition is met. If the final decision is absent, do not fill it in.";
const report = {
  variant,
  candidate: fidelity ? (variant === "fidelity-source-order-v1" ? FIDELITY_PROMPT_CANDIDATE : null) : variant === "candidate" ? candidate : null,
  version: fidelity ? CONTINUATION_FIDELITY_VERSION : MEMORY_PROBE_VERSION,
  day,
  requestedModel: model,
  startedAt: new Date().toISOString(),
  sampling: { temperature: 0, max_tokens: 256 },
  results: [],
};
async function* trials() {
  if (variant.startsWith("fidelity-")) {
    const { CONTINUATION_FIDELITY_CASES, FIDELITY_ARMS } = await import("../lib/continuationFidelityCases.ts");
    const { continuationFidelityProbe } = await import("../lib/continuationFidelityProbe.ts");
    for (const fixture of CONTINUATION_FIDELITY_CASES) for (const arm of FIDELITY_ARMS) {
      const probe = continuationFidelityProbe(fixture, arm, variant === "fidelity-baseline" ? "baseline" : "source-order-v1");
      if (!probe.inputMatchesDeclaration) throw Error("Coverage declaration mismatch: " + fixture.id + "/" + arm);
      yield { probe, details: { id: fixture.id, arm, coverage: probe.coverage, expectedCoverage: probe.expectedCoverage,
        expectedVisible: probe.expectedVisible, dimension: fixture.dimension, bodyTokens: probe.plan.estimatedTokens } };
    }
    return;
  }
  if (variant === "compare-excerpts") {
    if (!oldPlannerPath) throw Error("Provide the baseline seed planner module");
    const { compareExcerptCases } = await import("./import-memory-excerpt-comparison.mjs");
    yield* compareExcerptCases(day, oldPlannerPath);
    return;
  }
  for (const locale of MEMORY_PROBE_LOCALES) {
    for (const mode of MEMORY_MODES) yield { probe: memoryProbe(day, locale, mode), details: {} };
  }
}
await mkdir(dirname(output), { recursive: true });
for await (const { probe, details } of trials()) {
    const { locale, mode } = probe;
    const messages = probe.messages.map((m) =>
      m.role === "system" && variant === "candidate"
        ? { ...m, content: m.content + "\n" + candidate }
        : m,
    );
    const start = Date.now();
    const reply = await fetch(new URL("/v1/chat/completions", url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(150000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, ...report.sampling }),
    });
    if (!reply.ok)
      throw Error("Inference HTTP " + reply.status + "; no automatic retry.");
    const body = await reply.json(),
      raw = body.choices?.[0]?.message?.content;
    if (typeof raw !== "string") throw Error("Missing model answer");
    report.results.push({
      locale,
      mode,
      ...details,
      visible: probe.visible,
      usedTurns: probe.usedTurns,
      promptDigest: createHash("sha256")
        .update(JSON.stringify(messages))
        .digest("hex"),
      model: body.model,
      finish: body.choices[0].finish_reason,
      usage: body.usage,
      latencyMs: Date.now() - start,
      expected: probe.expected,
      original: probe.gold,
      raw,
      ...(variant.startsWith("fidelity-")
        ? (await import("../lib/continuationFidelityProbe.ts")).assessContinuationFidelity(probe, raw)
        : assessMemory(probe, raw)),
    });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(
      locale,
      mode,
      report.results.at(-1).grounded ? "grounded" : "miss",
    );
  }
