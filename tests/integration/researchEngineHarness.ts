import { createHash, randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { prisma } from "@/lib/prisma";
import { getModel } from "@/lib/models";
import { createFakeResearchClock, createMemoryEvidenceStore, setResearchClock, setResearchEvidenceStore } from "@/lib/researchEngineRuntime";
import { setResearchFundingAdapter, type ResearchFundingAdapter, type ResearchSettlementUsage } from "@/lib/researchEngineFunding";
import { setResearchModelFactory, setResearchModelResolver } from "@/lib/researchEngineModel";
import { setResearchNetworkPorts } from "@/lib/researchEngineFetch";

/**
 * Network-free, provider-free harness for Research engine v2 DB tests. Every
 * external edge is a fake: model (answers by the role's tool name), Chat
 * funding (an in-memory credit ledger with real reserve/settle semantics),
 * search, DNS, HTTP transport, evidence storage and the clock. Nothing here
 * spends money or reaches the internet.
 */

export const MODEL_ID = "gemini-3-1-pro";
export const modelConfig = getModel(MODEL_ID)!;

export function installResearchEnv() {
  process.env.RESEARCH_ENGINE_ENABLED = "true";
  process.env.RESEARCH_ENGINE_MODEL_IDS = MODEL_ID;
  process.env.RESEARCH_ENGINE_PRIVATE_SOURCES_ENABLED = "true";
  process.env.RESEARCH_ENGINE_MAX_APPROVED_CREDITS = "100000";
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "synthetic-model-never-sent";
}

export type FakeLedger = ReturnType<typeof createFakeFunding>;

/** A credit ledger with the semantics the engine relies on: hold before dispatch, settle at most what was held. */
export function createFakeFunding(options: { creditsPerCall?: number; searchSurcharge?: number; balance?: number } = {}) {
  const perCall = options.creditsPerCall ?? 10;
  const surcharge = options.searchSurcharge ?? 2;
  const reservations = new Map<string, { userId: string; credits: number; status: "reserved" | "settled"; settled: number; usage?: ResearchSettlementUsage }>();
  const balances = new Map<string, number>();
  let refuseNext: null | { kind: "budget" | "backpressure"; code: string } = null;
  const adapter: ResearchFundingAdapter = {
    async estimate({ searchEnabled }) {
      return { credits: perCall + (searchEnabled ? surcharge : 0), pricingVersion: "fake-pricing-v1", searchSurchargeCredits: searchEnabled ? surcharge : 0, budget: { fake: true } };
    },
    async reserve({ userId, estimate, segmentId }) {
      if (refuseNext) { const refusal = refuseNext; refuseNext = null; return { ok: false, ...refusal }; }
      const balance = balances.get(userId) ?? options.balance ?? 1_000_000;
      if (balance < estimate.credits) return { ok: false, kind: "budget", code: "CHAT_CREDITS_EXHAUSTED" };
      balances.set(userId, balance - estimate.credits);
      const reservationId = randomUUID();
      // A real row so the segment's foreign key holds; the fake ledger owns the money semantics.
      await prisma.chatCreditReservation.create({ data: { id: reservationId, userId, subjectKey: `user:${userId}`, traceId: segmentId,
        source: "chat", provider: "google", modelId: MODEL_ID, idempotencyKey: reservationId, reservationPayload: {},
        reservedCredits: estimate.credits, reservedCostMicroUsd: BigInt(0), planReservedCredits: estimate.credits, addOnReservedCredits: 0,
        expiresAt: new Date(Date.now() + 3_600_000) } });
      reservations.set(reservationId, { userId, credits: estimate.credits, status: "reserved", settled: 0 });
      return { ok: true, reservationId, reservedCredits: estimate.credits, leaseId: null };
    },
    async releaseLease() {},
    async settle({ reservationId, usage }) {
      const reservation = reservations.get(reservationId);
      if (!reservation || reservation.status !== "reserved") throw Object.assign(new Error("CHAT_RESERVATION_NOT_OPEN"), { code: "CHAT_RESERVATION_NOT_OPEN" });
      const settled = !usage.usageFromProvider ? reservation.credits
        : usage.outcome === "completed" ? Math.min(reservation.credits, perCall + ((usage.searchBackendRequestCount ?? 0) > 0 ? surcharge : 0)) : 0;
      reservation.status = "settled"; reservation.settled = settled; reservation.usage = usage;
      await prisma.chatCreditReservation.update({ where: { id: reservationId }, data: { status: "settled", settledCredits: settled } });
      balances.set(reservation.userId, (balances.get(reservation.userId) ?? options.balance ?? 1_000_000) + reservation.credits - settled);
      return { settledCredits: settled };
    },
  };
  return { adapter, reservations, balances, refuseOnce: (refusal: typeof refuseNext) => { refuseNext = refusal; } };
}

type Prompted = { tool: string; text: string; callIndex: number };
export type FakeBehaviour = {
  /** Return the structured tool input for this call, or `{ usage: "unknown" }` to drop usage. */
  respond?: (call: Prompted) => unknown;
  delayMs?: number;
};

const textOf = (prompt: unknown): string => {
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") { parts.push(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.text === "string") parts.push(record.text);
      if (typeof record.content === "string") parts.push(record.content); else if (record.content) walk(record.content);
    }
  };
  walk(prompt);
  return parts.join("\n");
};

/** Scripted researcher behaviour that exercises the whole pipeline deterministically. */
export function defaultResponse(call: Prompted, options: { subquestions?: number; sections?: number; readsPerTurn?: number } = {}): unknown {
  const subquestions = options.subquestions ?? 3;
  const sections = options.sections ?? 2;
  switch (call.tool) {
    case "submit_research_plan":
      return {
        objective: "Compare the topic across public sources.",
        assumptions: ["Public sources only unless private sources were selected."],
        clarifications: [],
        subquestions: Array.from({ length: subquestions }, (_, index) => ({ key: `q${index + 1}`, question: `Sub-question ${index + 1}?`,
          rationale: "Needed for the comparison.", queries: [`topic aspect ${index + 1}`], searchLanguages: [], sourceStrategy: "Official and primary sources." })),
        completionCriteria: ["Each sub-question has quoted evidence."],
        outline: Array.from({ length: sections }, (_, index) => ({ key: `s${index + 1}`, heading: `Section ${index + 1}`, purpose: "Explain findings.",
          subquestionKeys: Array.from({ length: subquestions }, (_, q) => `q${q + 1}`).filter((_, q) => q % sections === index), table: index === 0 })),
      };
    case "submit_research_turn": {
      const turn = Number(/turn (\d+) of at most/u.exec(call.text)?.[1] ?? 1);
      const question = /Sub-question \(turn \d+ of at most \d+\):\n([^\n]+)/u.exec(call.text)?.[1] ?? "q";
      if (turn === 1) return { searches: Array.from({ length: 5 }, (_, index) => ({ query: `${question} angle ${index + 1}` })), reads: [], findings: [], openQuestions: ["More detail needed"], done: false };
      if (turn === 2) {
        const keys = [...call.text.matchAll(/^(W\d+) \| [^\n]* \| snippet_only/gmu)].map((match) => match[1]!).slice(0, options.readsPerTurn ?? 4);
        const snippetQuote = /^(W\d+) \|[^\n]*\n  snippet: (.{20,60})/mu.exec(call.text);
        return { searches: [], reads: keys.map((sourceKey) => ({ sourceKey, fromChunk: 0 })),
          findings: snippetQuote ? [{ text: `Snippet-level observation from ${snippetQuote[1]}.`, kind: "fact",
            evidence: [{ sourceKey: snippetQuote[1]!, quote: snippetQuote[2]!.trim() }] }] : [],
          openQuestions: [], done: false };
      }
      const blocks = [...call.text.matchAll(/<evidence source="(W\d+)"[^>]*>\n([\s\S]*?)\n<\/evidence>/gu)];
      const findings = blocks.map((block) => {
        const body = block[2]!.replace(/^#+ .*\n/gmu, "");
        const quote = body.slice(40, 140).trim();
        return { text: `Fact reported by ${block[1]}: value ${/(\d+(?:\.\d+)?)%/u.exec(quote)?.[0] ?? "noted"}.`, kind: "fact",
          evidence: [{ sourceKey: block[1]!, quote }] };
      });
      findings.push({ text: "A fabricated claim that no source contains.", kind: "fact",
        evidence: [{ sourceKey: blocks[0]?.[1] ?? "W1", quote: "this sentence does not appear in any evidence that was read" }] });
      return { searches: [], reads: [], findings, openQuestions: [], done: true };
    }
    case "submit_research_private_analysis": {
      const block = /<evidence source="(P\d+)"[^>]*>\n([\s\S]*?)\n<\/evidence>/u.exec(call.text);
      return { findings: block ? [{ text: `Private note from ${block[1]}.`, kind: "fact", evidence: [{ sourceKey: block[1]!, quote: block[2]!.slice(0, 60).trim() }] }] : [], limitations: [] };
    }
    case "submit_research_coverage":
      return { decision: "finish", newSubquestions: [], coverage: [{ criterion: "Each sub-question has quoted evidence.", met: true, note: "ok" }] };
    case "submit_research_verification": {
      const keys = [...call.text.matchAll(/^(C\d+) \(/gmu)].map((match) => match[1]!);
      return { verdicts: keys.map((claimKey) => ({ claimKey, verification: "supported", numericCheck: "consistent" })) };
    }
    case "submit_research_section": {
      const heading = /Section: ([^\n]+)/u.exec(call.text)?.[1] ?? "Section";
      const keys = [...call.text.matchAll(/^(C\d+) \[(supported|partial|conflicting|unverified)/gmu)].map((match) => match[1]!);
      if (!keys.length) return { heading, blocks: [{ type: "paragraph", text: "No verified evidence was found for this section.", claimKeys: [] }] };
      const blocks: unknown[] = [];
      for (let index = 0; index < keys.length; index += 3) {
        blocks.push({ type: "paragraph", text: `This paragraph summarises claims ${keys.slice(index, index + 3).join(", ")} in detail. `.repeat(6).trim(),
          claimKeys: keys.slice(index, index + 3) });
      }
      blocks.push({ type: "table", caption: "Comparison", columns: ["Claim", "Status"], rows: keys.slice(0, 20).map((key) => [key, "verified"]), claimKeys: keys.slice(0, 20) });
      return { heading, blocks };
    }
    case "submit_research_synthesis":
      return { title: "Synthetic research report", summary: "A synthetic summary of verified findings. ".repeat(20).trim(),
        scopeNote: "Synthetic scope.", conflicts: [], limitations: ["Synthetic fixture data."], nextQuestions: ["What changed recently?"],
        criteria: [{ criterion: "Each sub-question has quoted evidence.", met: true }] };
  }
  throw new Error(`No fake response for ${call.tool}`);
}

export function createFakeModel(behaviour: FakeBehaviour = {}) {
  const calls: Prompted[] = [];
  let active = 0;
  let maxActive = 0;
  const model = new MockLanguageModelV4({ provider: "google", modelId: modelConfig.apiModel, doGenerate: async (request) => {
    const tool = (request.tools ?? []).find((entry) => entry.type === "function")?.name ?? "none";
    const call = { tool, text: textOf(request.prompt), callIndex: calls.length };
    calls.push(call);
    active += 1; maxActive = Math.max(maxActive, active);
    try {
      if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      const value = (behaviour.respond ?? defaultResponse)(call);
      const unknown = value && typeof value === "object" && (value as { usage?: unknown }).usage === "unknown";
      if (value instanceof Error) throw value;
      const output = tool === "submit_research_section" ? 1_500 : 400;
      return { content: [{ type: "tool-call", toolCallId: randomUUID(), toolName: tool, input: JSON.stringify(unknown ? {} : value) }],
        usage: unknown ? { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined } }
          : { inputTokens: { total: 2_000, noCache: 2_000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output - 50, reasoning: 50 } },
        warnings: [], finishReason: { unified: "tool-calls", raw: "fixture" } } as never;
    } finally { active -= 1; }
  } });
  return { model, calls, maxActive: () => maxActive };
}

/** Deterministic public web: unique pages, some republished copies, some paywalled. */
export function createFakeWeb(options: { resultsPerQuery?: number; paywallEvery?: number; republishEvery?: number; linksPerPage?: number } = {}) {
  const searches: string[] = [];
  const fetched: string[] = [];
  const pageVersion = new Map<string, number>();
  const sentence = (seed: string, index: number) => `Record ${index} for ${seed} states that the measured value was ${(index * 7) % 97}.${index % 10}% in 2026 according to the publisher.`;
  const body = (url: string) => {
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
    const index = Number.parseInt(hash, 16);
    const seed = options.republishEvery && index % options.republishEvery === 0 ? "wire-story-shared" : url;
    const version = pageVersion.get(url) ?? 1;
    const paragraphs = Array.from({ length: 30 }, (_, line) => `<p>${sentence(seed, line + version - 1)}</p>`).join("");
    const links = Array.from({ length: options.linksPerPage ?? 3 }, (_, link) => `<a href="https://linked${link}.example.com/${hash}/${link}">Related ${link}</a>`).join("");
    return `<html><head><title>Page ${hash}</title><meta property="article:published_time" content="2026-0${(index % 9) + 1}-01T00:00:00Z"></head><body><h1>Report ${hash}</h1>${paragraphs}${links}<script>ignored()</script></body></html>`;
  };
  setResearchNetworkPorts({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    search: async (request) => {
      searches.push(request.query);
      const count = options.resultsPerQuery ?? 5;
      const slug = createHash("sha256").update(request.query).digest("hex").slice(0, 10);
      return { ok: true, truncated: false, results: Array.from({ length: count }, (_, index) => ({
        title: `Result ${index + 1} for ${request.query}`, url: `https://site${index}.example.com/${slug}/${index}`,
        snippet: `Search snippet ${index + 1} about ${request.query} with a short public summary of findings.`,
        publishedAt: "2026-02-01T00:00:00.000Z" })) };
    },
    transport: async ({ url }) => {
      fetched.push(url.href);
      const hash = Number.parseInt(createHash("sha256").update(url.href).digest("hex").slice(0, 8), 16);
      const paywalled = options.paywallEvery && hash % options.paywallEvery === 0;
      const encoder = new TextEncoder();
      const html = encoder.encode(body(url.href));
      return { status: paywalled ? 402 : 200, headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        body: new ReadableStream({ start(controller) { controller.enqueue(html); controller.close(); } }), dispose: () => undefined };
    },
  });
  return { searches, fetched, bump: (url: string) => pageVersion.set(url, (pageVersion.get(url) ?? 1) + 1) };
}

export function installFakes(options: { funding?: FakeLedger; model?: ReturnType<typeof createFakeModel> } = {}) {
  installResearchEnv();
  const clock = createFakeResearchClock(new Date());
  setResearchClock(clock);
  const store = createMemoryEvidenceStore();
  setResearchEvidenceStore(store);
  const funding = options.funding ?? createFakeFunding();
  setResearchFundingAdapter(funding.adapter);
  const model = options.model ?? createFakeModel();
  setResearchModelFactory(() => model.model);
  setResearchModelResolver(async (id) => (id === MODEL_ID ? modelConfig : null));
  return { clock, store, funding, model };
}

export const users: string[] = [];

export async function createUser(label: string) {
  const user = await prisma.user.create({ data: { email: `${label}-${randomUUID()}@example.test`, plan: "Pro" } });
  users.push(user.id);
  return user;
}

export const fakeRequest = (cookie = "") => new Request("http://127.0.0.1/api/chat/research/runs", { headers: { "accept-language": "en", cookie } });
