import "server-only";
import { jsonSchema, tool, type ToolSet, type ModelMessage } from "ai";
import { estimatePromptTokens, estimateTokenBreakdown, toReservedInputTokens } from "@/lib/chatTokenEstimate";
import { getArtifactToolSupport } from "@/lib/generatedArtifactToolPolicy";
import { MCP_LIMITS, MCP_UNTRUSTED_NOTICE, McpConnectorError } from "@/lib/mcpConnectorPolicy";
import { invokeMcpTool } from "@/lib/mcpConnectorExecution";
import { mcpToolName, type McpReadSource } from "@/lib/mcpConnectorSchema";
import { ownMcpConnection, parseMcpGrants } from "@/lib/mcpConnectorStore";

export type McpProgress = "searching" | "reading" | "approval_required" | "no_results" | "reauth_required" | "server_error" | "done";
export const MCP_CHAT_MAX_STEPS = 8;
export async function buildMcpChatTools(input: {
  userId: string; connectionId: string; modelId: string; nativeSearch: boolean;
  signal: AbortSignal; onState?: (state: McpProgress) => void;
}) {
  if (getArtifactToolSupport(input.modelId) !== "verified" || input.nativeSearch) throw new McpConnectorError("model_tools_unavailable");
  const connection = await ownMcpConnection(input.userId, input.connectionId);
  const grants = parseMcpGrants(connection.grants);
  if (!grants.length) throw new McpConnectorError("no_tools_selected");
  const controller = new AbortController();
  let startedAt: number | null = null, calls = 0, returnedBytes = 0;
  const sources = new Map<string, McpReadSource>();
  const tools: ToolSet = {};
  for (const grant of grants) {
    tools[mcpToolName(connection.id, grant.name)] = tool({
      description: `User-selected connector tool ${JSON.stringify(grant.name)}. ${grant.mode === "read" ? "Read access." : "Propose an action for exact human approval; this does not execute it."} ${MCP_UNTRUSTED_NOTICE}`,
      inputSchema: jsonSchema<Record<string, unknown>>(grant.inputSchema),
      execute: async args => {
        startedAt ??= Date.now();
        if (++calls > MCP_LIMITS.calls || Date.now() - startedAt > MCP_LIMITS.turnMs || returnedBytes >= MCP_LIMITS.turnCharacters) return { status: "limit_reached", notice: MCP_UNTRUSTED_NOTICE };
        const signal = AbortSignal.any([input.signal, controller.signal, AbortSignal.timeout(Math.max(1, MCP_LIMITS.turnMs - (Date.now() - startedAt)))]);
        input.onState?.(/search|list|find/.test(grant.name) ? "searching" : "reading");
        try {
          const result = await invokeMcpTool({ userId: input.userId, connectionId: connection.id, version: connection.version, name: grant.name, args, signal });
          const bytes = Buffer.byteLength(JSON.stringify(result));
          if (returnedBytes + bytes > MCP_LIMITS.turnCharacters) return { status: "limit_reached", notice: MCP_UNTRUSTED_NOTICE };
          returnedBytes += bytes;
          for (const source of result.sources) sources.set(source.url, source);
          input.onState?.(result.status === "approval_required" ? "approval_required" : result.status === "no_results" ? "no_results" : "done");
          return result;
        } catch (error) {
          const code = error instanceof McpConnectorError ? error.code : "server_error";
          input.onState?.(code === "reauth_required" ? "reauth_required" : "server_error");
          return { status: code, content: "The connector could not complete this call. Do not invent an answer or citation.", notice: MCP_UNTRUSTED_NOTICE };
        }
      },
    });
  }
  const definitionTokens = estimatePromptTokens(JSON.stringify(grants) + MCP_UNTRUSTED_NOTICE);
  let outputCeiling = 0, inputCeiling = 0, cumulativeInput = 0, instructions = "";
  return {
    tools, definitionTokens,
    // A byte bound is also a conservative token bound for returned tool data.
    resultInputAllowance: MCP_LIMITS.turnCharacters,
    sources: () => [...sources.values()],
    cancel: () => controller.abort(),
    setBudget: (input: { inputTokens: number; outputTokens: number; instructions: string }) => {
      inputCeiling = input.inputTokens; outputCeiling = input.outputTokens; instructions = input.instructions;
    },
    prepareStep: ({ messages, steps }: { messages: ModelMessage[]; steps: Array<{ usage: { outputTokens?: number } }> }) => {
      input.signal.throwIfAborted(); controller.signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(messages)) > 256_000) throw new McpConnectorError("model_input_limit");
      cumulativeInput += toReservedInputTokens(estimateTokenBreakdown(JSON.stringify(messages) + instructions)) + definitionTokens;
      if (cumulativeInput > inputCeiling) throw new McpConnectorError("model_input_budget");
      const used = steps.reduce((sum, step) => sum + (step.usage.outputTokens || 0), 0);
      if (used >= outputCeiling) throw new McpConnectorError("model_output_limit");
      return { maxOutputTokens: outputCeiling - used };
    },
  };
}
