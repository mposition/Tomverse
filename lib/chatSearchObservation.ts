import type { ModelMessage } from "ai";
import type { AppManagedSearchSnapshot } from "./appManagedWebSearchCore";

type SearchStep = {
  text: string;
  toolCalls: readonly { toolName: string }[];
};

function returnedResults(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ("searches" in value && Array.isArray(value.searches)) return value.searches.some(returnedResults);
  return "status" in value && value.status === "ok" && "results" in value &&
    Array.isArray(value.results) && value.results.length > 0;
}

/** Literal returned URLs mentioned in the answer, independent of the source cards. */
function mentionedSourceUrls(text: string, sources: AppManagedSearchSnapshot["sources"]) {
  const known = sources.map(s => s.url).sort((a, b) => b.length - a.length);
  const mentioned = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    // A source URL may itself end in a parenthesis. Prefer the longest
    // literal match, allowing only Markdown/prose delimiters after it.
    const url = known.find(value => match[0].startsWith(value) &&
      /^[)\]}>.,;:!?*_。！？]*$/u.test(match[0].slice(value.length)));
    if (url) mentioned.add(url);
  }
  return mentioned;
}

/** Measure the primary app-managed search path. Only counts leave this closure. */
export function createChatSearchObservation(input: {
  flagEnabled: boolean;
  planOffered: boolean;
  plannedQueries: number;
  selectionEligible: boolean;
  snapshot: () => AppManagedSearchSnapshot;
}) {
  let modelCalls = 0, modelCallsWithSearchResults = 0, finishedSteps = 0;
  let searchToolCalls = 0, toolOnlySearchSteps = 0;
  let searchStepsAfterResults = 0, priorResults = false;
  let groundedLookupStep = false;
  let presearchEntered = false, evidenceInjected = false, presearchBackendRequests = 0;
  let injectedUrls = new Set<string>();
  let sourceCards: number | null = null;
  return {
    presearch(injected: boolean, directStep = false) {
      groundedLookupStep = directStep;
      presearchEntered = true;
      evidenceInjected = injected;
      const snapshot = input.snapshot();
      presearchBackendRequests = snapshot.backendRequestCount;
      if (injected) injectedUrls = new Set(snapshot.sources.map(s => s.url));
      priorResults = injectedUrls.size > 0;
    },
    sdk: {
      onLanguageModelCallStart({ messages }: { messages: ModelMessage[] }) {
        modelCalls++;
        const latest = messages.at(-1);
        if (latest?.role === "tool" && latest.content.some(part => part.type === "tool-result" &&
          part.toolName === "web_search" && part.output.type === "json" && returnedResults(part.output.value))) {
          modelCallsWithSearchResults++;
          priorResults = true;
        }
      },
      onStepEnd(step: SearchStep) {
        finishedSteps++;
        const searches = step.toolCalls.filter(call => call.toolName === "web_search").length;
        searchToolCalls += searches;
        if (searches > 0 && priorResults) searchStepsAfterResults++;
        if (searches > 0 && searches === step.toolCalls.length && !step.text.trim()) toolOnlySearchSteps++;
      },
    },
    // Set when the search execution normalizer builds the completion metadata.
    sourceCards(count: number) { sourceCards = count; },
    summary(answer: string | null) {
      const final = input.snapshot();
      const mentioned = answer === null ? null : mentionedSourceUrls(answer, final.sources);
      return {
        flagEnabled: input.flagEnabled, planOffered: input.planOffered,
        plannedQueries: input.plannedQueries, selectionEligible: input.selectionEligible,
        presearchEntered, presearchBackendRequests, evidenceInjected,
        ...(groundedLookupStep ? { groundedLookupStep } : {}),
        injectedSources: injectedUrls.size, modelCalls, modelCallsWithSearchResults, finishedSteps, toolOnlySearchSteps,
        searchToolCalls, searchStepsAfterResults,
        answerBackendRequests: final.backendRequestCount - presearchBackendRequests,
        successfulBackendRequests: final.succeededRequestCount, returnedSources: final.sources.length,
        sourceCards, mentionedSources: mentioned?.size ?? null,
        mentionedInjectedSources: mentioned ? [...mentioned].filter(url => injectedUrls.has(url)).length : null,
      };
    },
  };
}

export type ChatSearchObservation = ReturnType<typeof createChatSearchObservation>;
export type ChatSearchSummary = ReturnType<ChatSearchObservation["summary"]>;
