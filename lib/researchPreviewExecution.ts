import "server-only";

import { stepCountIs, tool, type StepResult, type ToolSet } from "ai";
import {
  APP_MANAGED_WEB_SEARCH_TOOL_NAME,
  buildAppManagedWebSearchTool,
} from "./appManagedWebSearchTool";
import type { WebSearchBackend } from "./webSearchBackends";
import {
  createResearchEvidenceRegistry,
  researchPreviewReportSchema,
  validateAndRenderResearchReport,
  type RenderedResearchPreviewReport,
} from "./researchPreviewReport";
import {
  RESEARCH_PREVIEW_MAX_SEARCH_ATTEMPTS,
  RESEARCH_PREVIEW_MAX_STEPS,
} from "./researchPreviewAdmission";
export {
  researchPreviewInputEstimate,
  researchPreviewInstructions,
  researchPreviewLocale,
  researchPreviewMessages,
} from "./researchPreviewPrompt";

export const RESEARCH_PREVIEW_REPORT_TOOL_NAME = "submit_research_report";

export class ResearchPreviewUsageUnknownError extends Error {
  readonly code = "RESEARCH_PREVIEW_USAGE_UNKNOWN";
  constructor() {
    super("Research Preview stopped because provider usage was unavailable.");
    this.name = "ResearchPreviewUsageUnknownError";
  }
}

export class ResearchPreviewMissingReportError extends Error {
  readonly code = "RESEARCH_PREVIEW_MISSING_REPORT";
  constructor(
    readonly stopReason:
      | "invalid_report"
      | "unknown_source"
      | "missing_report" = "missing_report"
  ) {
    super("Research Preview ended without an accepted terminal report.");
    this.name = "ResearchPreviewMissingReportError";
  }
}

export class ResearchPreviewBudgetExhaustedError extends Error {
  readonly code = "RESEARCH_PREVIEW_BUDGET_EXHAUSTED";
  constructor() {
    super("Research Preview used its run-wide output budget.");
    this.name = "ResearchPreviewBudgetExhaustedError";
  }
}

export class ResearchPreviewRunStoppedError extends Error {
  readonly code = "RESEARCH_PREVIEW_RUN_STOPPED";
  constructor(readonly stopReason: "timeout" | "aborted") {
    super(`Research Preview ${stopReason}.`);
    this.name = "ResearchPreviewRunStoppedError";
  }
}

type UsageStep = Pick<StepResult<ToolSet>, "usage">;

export function usedResearchOutputTokens(steps: readonly UsageStep[]): number {
  let total = 0;
  for (const step of steps) {
    const inputTokens = step.usage?.inputTokens;
    const outputTokens = step.usage?.outputTokens;
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens! < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens! < 0
    ) throw new ResearchPreviewUsageUnknownError();
    total += outputTokens!;
    if (!Number.isSafeInteger(total)) throw new ResearchPreviewUsageUnknownError();
  }
  return total;
}

export function createResearchPreviewExecution(input: {
  backend: WebSearchBackend;
  totalOutputTokens: number;
  locale: string;
  signal: AbortSignal;
  onSearchOutcome?: (event: {
    status: string;
    reason?: string;
    queryLength: number;
    resultCount: number;
    durationMs: number;
    reused: boolean;
    toolCallIndex: number;
    batchSize: number;
  }) => void;
}) {
  const registry = createResearchEvidenceRegistry();
  const searchAbort = new AbortController();
  const searchSignal = AbortSignal.any([input.signal, searchAbort.signal]);
  let terminal: Extract<RenderedResearchPreviewReport, { ok: true }> | null = null;
  let allowedSourceIds: readonly string[] = [];
  let rejectedReportStopReason:
    | "invalid_report"
    | "unknown_source"
    | null = null;

  const search = buildAppManagedWebSearchTool({
    backend: input.backend,
    maxQueries: RESEARCH_PREVIEW_MAX_SEARCH_ATTEMPTS,
    signal: searchSignal,
    canDispatch: () => terminal === null,
    transformResult: (result) => registry.addToolResult(result),
    onOutcome: input.onSearchOutcome,
  });

  const reportTool = tool({
    description:
      "Submit the final Research Preview report. Text fields must be plain text without URLs or Markdown. Cite only sourceId values available before this model step.",
    inputSchema: researchPreviewReportSchema,
    execute: async (report) => {
      if (terminal) return { status: "rejected" as const, reason: "terminal_already_accepted" };
      const rendered = validateAndRenderResearchReport({
        report,
        registry,
        allowedSourceIds,
        locale: input.locale,
      });
      if (!rendered.ok) {
        rejectedReportStopReason =
          rendered.reason === "unknown_source"
            ? "unknown_source"
            : "invalid_report";
        return { status: "rejected" as const, reason: rendered.reason };
      }
      terminal = rendered;
      searchAbort.abort(new DOMException("terminal report accepted", "AbortError"));
      return { status: "accepted" as const, outcome: rendered.outcome };
    },
  });

  const tools = {
    [APP_MANAGED_WEB_SEARCH_TOOL_NAME]:
      search.tools[APP_MANAGED_WEB_SEARCH_TOOL_NAME]!,
    [RESEARCH_PREVIEW_REPORT_TOOL_NAME]: reportTool,
  };
  const invalidTerminalAttempted = (
    steps: readonly StepResult<typeof tools>[]
  ) => steps.some((step) =>
    step.content.some((part) =>
      part.type === "tool-error" &&
      "toolName" in part &&
      part.toolName === RESEARCH_PREVIEW_REPORT_TOOL_NAME
    )
  );

  return {
    ...search,
    tools,
    registry,
    prepareStep: ({ steps, stepNumber }: {
      steps: Array<StepResult<typeof tools>>;
      stepNumber: number;
    }) => {
      const used = usedResearchOutputTokens(steps);
      const remaining = input.totalOutputTokens - used;
      if (!Number.isSafeInteger(remaining)) throw new ResearchPreviewUsageUnknownError();
      if (remaining <= 0) throw new ResearchPreviewBudgetExhaustedError();
      allowedSourceIds = registry.sourceIds();
      if (stepNumber === 0) {
        return {
          activeTools: [APP_MANAGED_WEB_SEARCH_TOOL_NAME] as const,
          toolChoice: {
            type: "tool" as const,
            toolName: "web_search" as const,
          },
          maxOutputTokens: remaining,
        };
      }
      if (stepNumber === RESEARCH_PREVIEW_MAX_STEPS - 1) {
        return {
          activeTools: [RESEARCH_PREVIEW_REPORT_TOOL_NAME] as const,
          toolChoice: {
            type: "tool" as const,
            toolName: "submit_research_report" as const,
          },
          maxOutputTokens: remaining,
        };
      }
      return {
        activeTools: [
          APP_MANAGED_WEB_SEARCH_TOOL_NAME,
          RESEARCH_PREVIEW_REPORT_TOOL_NAME,
        ] as const,
        toolChoice: "required" as const,
        maxOutputTokens: remaining,
      };
    },
    stopWhen: [
      stepCountIs(RESEARCH_PREVIEW_MAX_STEPS),
      ({ steps }: { steps: Array<StepResult<typeof tools>> }) => {
        if (invalidTerminalAttempted(steps)) {
          rejectedReportStopReason = "invalid_report";
          return true;
        }
        return terminal !== null;
      },
    ],
    finalReport: () => terminal,
    stopReason: () =>
      terminal
        ? ("report_submitted" as const)
        : rejectedReportStopReason ?? ("missing_report" as const),
    finalTextStream: (
      source: ReadableStream<string>,
      completion?: PromiseLike<unknown>,
      completedSteps?: PromiseLike<readonly UsageStep[]>
    ) => {
      const reader = source.getReader();
      let cancelled = false;
      return new ReadableStream<string>({
        start(controller) {
          // Do not return this promise: downstream cancellation must be able
          // to run while the provider/tool loop is still in flight.
          void (async () => {
            try {
              while (!(await reader.read()).done) {
                // Intermediate provider prose and structured-tool JSON are
                // never user-visible. Only the deterministic renderer emits.
              }
              // AI SDK text streams can close normally while their aggregate
              // completion promise rejects from prepareStep. Await it before
              // declaring a missing report so usage_unknown/budget errors keep
              // their financial meaning and are not masked.
              if (completion) await completion;
              if (completedSteps) {
                const used = usedResearchOutputTokens(await completedSteps);
                if (!terminal && used >= input.totalOutputTokens) {
                  throw new ResearchPreviewBudgetExhaustedError();
                }
              }
              if (cancelled) return;
              if (!terminal) {
                throw new ResearchPreviewMissingReportError(
                  rejectedReportStopReason ?? "missing_report"
                );
              }
              controller.enqueue(terminal.content);
              controller.close();
            } catch (error) {
              if (!cancelled) {
                if (input.signal.aborted) {
                  const reason = input.signal.reason;
                  controller.error(
                    new ResearchPreviewRunStoppedError(
                      reason instanceof DOMException &&
                        reason.name === "TimeoutError"
                        ? "timeout"
                        : "aborted"
                    )
                  );
                } else {
                  controller.error(error);
                }
              }
            } finally {
              reader.releaseLock();
            }
          })();
        },
        async cancel(reason) {
          cancelled = true;
          searchAbort.abort(reason);
          await reader.cancel(reason);
        },
      });
    },
    abortSearch: (reason?: unknown) => searchAbort.abort(reason),
  };
}

