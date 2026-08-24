/**
 * Which of this turn's artifact tool calls the model *began* and never ran.
 *
 * Policy: docs/policy/generated-artifacts.md sections 1 and 9.
 *
 * A provider that hits its output ceiling while it is still writing a tool
 * call returns HTTP 200, a `length` finish reason, and nothing else. The tool
 * never executes, so the collector records nothing, so the answer ends with
 * "이제 웹페이지를 만들겠습니다:" and no file and no card -- which is the one
 * failure this domain must not have: the app said it was about to make a file
 * and then said nothing at all.
 *
 * The two facts needed to see that are on different signals, so they are
 * gathered here rather than inside the route's stream loop:
 *
 *   * `tool-input-start` says a call was begun, by `toolCallId` and
 *     `toolName`. It is the earliest point the provider names a tool.
 *   * a tool execution start says that same call reached `execute`, which is
 *     where the collector takes over and records its own outcome -- success,
 *     failure or a sign-in refusal.
 *
 * A call in the first set and not the second is a file the model promised and
 * the turn never got to. That is the whole of what this tracks.
 *
 * Deliberately *not* tracked: `tool-input-delta`. The partial JSON a truncated
 * call carries is the model's half-written specification, and it is neither
 * logged nor stored nor read -- a rejected artifact is labelled from its tool
 * kind's fallback descriptor instead (docs/policy/generated-artifacts.md
 * section 5).
 *
 * Pure: no `ai`, no Prisma, no `server-only`. The stream shapes it reads are
 * duck-typed from untrusted-looking input for the same reason the transport
 * parser is -- a provider chunk is data, and a tracker that threw would take
 * the answer with it.
 */

/** One tool call the model began writing, as the provider named it. */
export type StartedArtifactToolCall = {
  toolCallId: string;
  toolName: string;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export class ArtifactToolCallTracker {
  /**
   * The application tools this turn actually registered.
   *
   * The allowlist is the whole defence against counting a provider-executed
   * tool as a missing file: `web_search` and `google_search` emit
   * `tool-input-start` exactly like an application tool does, they are never
   * in this set, and a native search that was cut off is not a file the user
   * was promised. `providerExecuted` is checked as well, because a provider
   * that ever ships a hosted tool under a name this app also uses would
   * otherwise be believed.
   */
  private readonly registeredToolNames: ReadonlySet<string>;
  private readonly started = new Map<string, StartedArtifactToolCall>();
  private readonly executed = new Set<string>();

  constructor(registeredToolNames: Iterable<string>) {
    this.registeredToolNames = new Set(registeredToolNames);
  }

  /**
   * Reads one stream chunk, and ignores all but `tool-input-start`.
   *
   * Takes `unknown` because it is wired straight to the SDK's `onChunk`, and
   * the union of chunk shapes there is both large and provider-dependent.
   * Everything this needs is three fields, all of them checked.
   */
  noteChunk(chunk: unknown): void {
    if (!chunk || typeof chunk !== "object") return;
    const record = chunk as Record<string, unknown>;
    if (record.type !== "tool-input-start") return;
    // A hosted tool the provider runs itself. Never a generated file.
    if (record.providerExecuted === true) return;
    const { toolCallId, toolName } = record;
    if (!isNonEmptyString(toolCallId) || !isNonEmptyString(toolName)) return;
    if (!this.registeredToolNames.has(toolName)) return;
    // Keyed by call id, so a provider that repeats the frame for one call
    // still describes one call.
    this.started.set(toolCallId, { toolCallId, toolName });
  }

  /**
   * Marks a call as having reached the tool.
   *
   * Called from the SDK's `onToolExecutionStart` and, independently, from the
   * tool's own `execute`. Two sources for one fact on purpose: the second is
   * this application's own code and cannot be missed, and the first covers a
   * call the SDK declines to execute after starting it. Either is enough, and
   * both together mean an executed call can never be reported as abandoned --
   * which is what keeps a duplicate card off an answer whose file already
   * failed for a reason of its own.
   */
  noteExecutionStarted(toolCallId: unknown): void {
    if (!isNonEmptyString(toolCallId)) return;
    this.executed.add(toolCallId);
  }

  /** Whether the model began any artifact tool call at all this turn. */
  get startedAnyCall(): boolean {
    return this.started.size > 0;
  }

  /**
   * The calls that were begun and never ran, in the order they were begun.
   *
   * Ordered so the cards a truncated turn draws sit in the order the model
   * asked for them, which is the order the collector's ordinals will follow.
   */
  abandonedCalls(): StartedArtifactToolCall[] {
    return Array.from(this.started.values()).filter(
      (call) => !this.executed.has(call.toolCallId)
    );
  }

  /**
   * Forgets everything, for a turn whose model was swapped mid-stream.
   *
   * The primary attempt's collector is discarded at that point for the reason
   * given there -- its files belong to an answer that will not be written --
   * and a tool call begun by the displaced model is the same thing one step
   * earlier. Unreachable today (a turn that offered tools is out of the
   * fallback scope) and kept beside the `discard()` it mirrors.
   */
  reset(): void {
    this.started.clear();
    this.executed.clear();
  }
}
