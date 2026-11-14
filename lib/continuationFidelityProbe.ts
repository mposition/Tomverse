import { createHash } from "node:crypto";
import { selectPassageText } from "./continuationPassages";
import { planContinuationSeed, planSelectedContinuationSeed } from "./externalContinuationSeedCore";
import { buildContinuationSeedPrompt } from "./externalContinuationSeedPrompt";
import { CONTINUATION_FIDELITY_CASES, type FidelityArm, type FidelityCoverage } from "./continuationFidelityCases";

export const CONTINUATION_FIDELITY_VERSION = "continuation-fidelity-24-v1";
/** Evaluation-only. No paired real-model evidence yet; never imported by the product prompt. */
export const FIDELITY_PROMPT_CANDIDATE = "Resolve facts in this order: the current request, later native user corrections, then confirmed imported user decisions. An assistant proposal is not confirmation. Selection signals relevance, not recency or authority; import time is not statement time. Preserve negations, exact targets and every condition. Ask for clarification when the visible evidence leaves the reference unresolved.";
const keys = ["A", "B"] as const;

export function continuationFidelityProbe(fixture: typeof CONTINUATION_FIDELITY_CASES[number], arm: FidelityArm,
    promptVariant: "baseline" | "source-order-v1" = "baseline") {
    const row = (ordinal: number, content: string, role = "user") => ({ ordinal, content, role, truncated: false });
    const content = fixture.middle ? fixture.old + "\n" + "padding ".repeat(1200) + fixture.middle + "\n" +
        "padding ".repeat(1200) + "\n" + fixture.recent : fixture.old;
    const historical = row(0, content, fixture.oldRole ?? "user");
    const rows = fixture.middle ? [historical] : [historical, row(500, fixture.recent)];
    const recent = fixture.outside ? rows.slice(1) : rows;
    const start = fixture.middle ? content.indexOf(fixture.middle) : 0;
    const passages = [{ ordinal: 0, start, end: start + (fixture.middle?.length ?? fixture.old.length) }];
    const plan = arm === "selected_recent"
        ? planSelectedContinuationSeed({ messages: recent, selectedMessages: [historical], passages, sourceMessageCount: 501 })
        : planContinuationSeed({ messages: arm === "selected" ? selectPassageText([historical], passages) : recent, sourceMessageCount: 501 });
    const seed = buildContinuationSeedPrompt({ provider: "chatgpt", importedAt: "2026-11-14", plan });
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
    if (seed.rulesText && seed.transcriptText) messages.push({ role: "system", content: seed.rulesText +
        (promptVariant === "source-order-v1" ? "\n" + FIDELITY_PROMPT_CANDIDATE : "") }, { role: "user", content: seed.transcriptText });
    if (fixture.native) messages.push({ role: "user", content: fixture.native }, { role: "assistant", content: "Understood." });
    messages.push({ role: "user", content: fixture.question + "\nReturn only JSON with string fields A and B. Use UNKNOWN when the evidence is absent, CLARIFY when a reference is ambiguous. Do not guess." });
    const rendered = messages.map(message => message.content).join("\n");
    const coverage = Object.fromEntries(keys.map(key => {
        const spans = fixture.evidence[key];
        const count = spans.filter(span => rendered.includes(span)).length;
        return [key, count === spans.length ? "present" : count === 0 ? "absent" : "partial"];
    })) as Record<"A" | "B", FidelityCoverage>;
    const expectedCoverage = { A: fixture.coverage[arm][0], B: fixture.coverage[arm][1] };
    const expectedVisible = Object.fromEntries(keys.map(key => [key,
        expectedCoverage[key] === "present" ? fixture.gold[key] : "UNKNOWN"]));
    return { id: fixture.id, locale: fixture.locale, domain: fixture.domain, dimension: fixture.dimension, arm, promptVariant,
        messages, plan, coverage, expectedCoverage, expectedVisible, gold: fixture.gold,
        promptDigest: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
        inputMatchesDeclaration: keys.every(key => coverage[key] === expectedCoverage[key]) };
}

/** Separate evidence preservation, visible-evidence fidelity and full-source task success. */
export function assessContinuationFidelity(probe: ReturnType<typeof continuationFidelityProbe>, raw: string) {
    let answer: Record<string, unknown> = {};
    try { answer = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* Invalid output is a measured failure. */ }
    return { fields: keys.map((key, index) => ({ key, dimension: probe.dimension[index], coverage: probe.coverage[key],
        answer: answer?.[key] ?? "INVALID", visibleCorrect: answer?.[key] === probe.expectedVisible[key],
        originalCorrect: answer?.[key] === probe.gold[key],
        necessaryAbstention: probe.expectedVisible[key] === "UNKNOWN" || probe.expectedVisible[key] === "CLARIFY",
        unsupportedAssertion: probe.expectedVisible[key] === "UNKNOWN" && typeof answer?.[key] === "string" && answer[key] !== "UNKNOWN" })) };
}
