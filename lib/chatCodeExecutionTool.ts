import "server-only";

import type { ToolSet } from "ai";
import { google } from "@ai-sdk/google";

import {
    CODE_EXECUTION_TOOL_NAME,
    type CodeExecutionDecision,
} from "@/lib/chatCodeExecutionCore";

/**
 * The provider tool for a turn the gate admitted, merged into whatever tool
 * configuration the turn already has.
 *
 * The package-level `google` is a descriptor builder with no key of its own,
 * the same reason `lib/webSearchToolConfig.ts` can use the package singletons:
 * the request still goes out through the turn's configured model.
 *
 * A turn the gate refused gets back exactly the configuration it passed in --
 * the same object, so a switched-off deployment sends the request it always did.
 */
export const withCodeExecutionTool = <T extends { tools: ToolSet } | null | undefined>(
    config: T,
    decision: CodeExecutionDecision
): T | { tools: ToolSet } => {
    if (!decision.enabled) return config;
    const tools: ToolSet = {
        [CODE_EXECUTION_TOOL_NAME]: google.tools.codeExecution({}),
    };
    return config
        ? { ...config, tools: { ...config.tools, ...tools } }
        : { tools };
};
