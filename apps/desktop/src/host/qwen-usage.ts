import { z } from "zod";
import { MAX_QWEN_USAGE_REQUESTS, qwenRequestUsage, type CodeNativeUsage } from "../contract";

const metadata = z.object({ executionLifecycle: z.unknown().optional(), usage: z.unknown().optional(),
  parentToolCallId: z.unknown().optional(), subagentType: z.unknown().optional() });
const lifecycle = z.object({ v: z.literal(1), kind: z.literal("request"), phase: z.enum(["started", "ended"]),
  executionId: z.uuid(), sessionId: z.uuid(), promptId: z.string().max(128), model: z.string().max(200),
  outcome: z.string().optional(), subagentId: z.unknown().optional(),
});
const usageChunk = z.object({ type: z.literal("text"), text: z.literal("") });
const qwenTokens = qwenRequestUsage.omit({ executionId: true });
type RequestUsage = z.infer<typeof qwenRequestUsage>;

export class QwenUsage {
  private promptNumber = 0;
  private bound = false;
  private invalid = false;
  private active: string | undefined;
  private awaitingUsage: string | undefined;
  private readonly requests = new Map<string, RequestUsage | undefined>();

  startPrompt() {
    this.bound = false;
    this.invalid = false;
    this.active = undefined;
    this.awaitingUsage = undefined;
    this.requests.clear();
  }

  observe(update: Record<string, unknown>, sessionId: string, model: string, selectedModel?: string) {
    // Qwen 0.28.4 sends its usage chunk immediately after the matching request end, without an ID of its own.
    const awaitingUsage = this.awaitingUsage;
    this.awaitingUsage = undefined;
    if (this.invalid || update.sessionUpdate !== "agent_message_chunk" || update._meta === undefined ||
        !usageChunk.safeParse(update.content).success) return;
    const meta = metadata.safeParse(update._meta).data;
    if (!meta || meta.parentToolCallId !== undefined || meta.subagentType !== undefined) return;
    if (meta.executionLifecycle === undefined) {
      if (!awaitingUsage) return;
      const usage = qwenTokens.safeParse(meta.usage).data;
      if (usage && (usage.inputTokens || usage.outputTokens)) this.requests.set(awaitingUsage, { executionId: awaitingUsage, ...usage });
      return;
    }
    const event = lifecycle.safeParse(meta.executionLifecycle).data;
    if (event?.subagentId !== undefined) return;
    const prefix = `${sessionId}########`;
    const ordinal = event?.promptId.startsWith(prefix) && event.promptId.slice(prefix.length);
    if (!event || event.sessionId !== sessionId || !ordinal || !/^[1-9]\d{0,14}$/.test(ordinal) ||
        (event.model !== model && event.model !== selectedModel)) {
      this.invalid = true;
      return;
    }
    const number = Number(ordinal);
    if (!this.bound && event.phase === "started" && number > this.promptNumber) {
      this.bound = true;
      this.promptNumber = number;
    }
    if (!this.bound || number < this.promptNumber) return;
    if (number > this.promptNumber) {
      this.invalid = true;
      return;
    }
    const { executionId } = event;
    if (event.phase === "started") {
      if (this.requests.has(executionId)) return;
      if (this.active || this.requests.size >= MAX_QWEN_USAGE_REQUESTS) {
        this.invalid = true;
        return;
      }
      this.active = executionId;
      this.requests.set(executionId, undefined);
    } else if (this.active === executionId) {
      this.active = undefined;
      if (event.outcome === "success") this.awaitingUsage = executionId;
    } else if (!this.requests.has(executionId)) {
      this.invalid = true;
    }
  }

  result(): Extract<CodeNativeUsage, { source: "qwen_requests" }> | undefined {
    if (this.invalid) return undefined;
    const requests = [...this.requests.values()].filter((usage) => usage !== undefined);
    if (requests.length) return { source: "qwen_requests", requestCount: this.requests.size, requests };
  }
}
