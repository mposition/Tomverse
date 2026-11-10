import "server-only";
import type { ModelMessage } from "ai";
import type { AppManagedWebSearchToolConfig } from "./appManagedWebSearchTool";
import { parseRouterSearchQueries } from "./chatRouterSearchPlan";
import { createTokenEstimateAccumulator, toReservedInputTokens, WEB_SEARCH_INPUT_TOKEN_OVERHEAD } from "./chatTokenEstimate";

/** Reuse the attempt's admitted tool, counter, result cache and sources. */
export async function prepareRouterSearch(input: {
  queries: unknown;
  tool: AppManagedWebSearchToolConfig;
  signal: AbortSignal;
  inputHeadroomTokens: number;
  toolCallId: string;
}): Promise<ModelMessage[]> {
  const queries = parseRouterSearchQueries(input.queries);
  if (!queries.length || input.signal.aborted || input.inputHeadroomTokens < WEB_SEARCH_INPUT_TOKEN_OVERHEAD) return [];
  try {
    const result = await input.tool.search({ query: queries });
    if (input.signal.aborted) return [];
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: input.toolCallId,
        toolName: "web_search", input: { query: queries } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: input.toolCallId,
        toolName: "web_search", output: { type: "text", value: JSON.stringify(result) } }] },
    ];
    const estimate = createTokenEstimateAccumulator();
    estimate.addText(JSON.stringify(messages));
    // Never widen the existing input reservation or truncate evidence to make
    // it fit. The ordinary tool remains available and reuses successful reads.
    return toReservedInputTokens(estimate.breakdown()) <= WEB_SEARCH_INPUT_TOKEN_OVERHEAD ? messages : [];
  } catch {
    // The existing tool loop can recover; there is no automatic paid retry.
    return [];
  }
}
