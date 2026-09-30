/** Privacy-minimal diagnostics for artifact calls rejected before rendering. */
import { artifactFormat } from "@/lib/generatedArtifactFormats";

export type ArtifactToolRejectionCode =
  | "input_schema_rejected"
  | "spec_rejected"
  | "limit_exceeded";

/** Per-turn diagnostic bound, independent of artifact count and step scheduling. */
export const MAX_ARTIFACT_REJECTION_LOGS_PER_TURN = 16;

const requestedFormat = (input: unknown): string | null => {
  if (!input || typeof input !== "object") return null;
  try {
    // Do not invoke a getter on an untrusted value or inspect any other field.
    const value = Object.getOwnPropertyDescriptor(input, "format")?.value;
    return typeof value === "string" && artifactFormat(value) ? value : null;
  } catch {
    // Diagnostics must never disrupt the turn, including for proxy input.
    return null;
  }
};

export class ArtifactToolRejectionLog {
  private readonly registeredNames: ReadonlySet<string>;
  private readonly recordedCallIds = new Set<string>();
  private recordedCount = 0;

  constructor(
    registeredNames: Iterable<string>,
    private readonly emit: (line: string) => void = (line) => console.warn(line)
  ) {
    this.registeredNames = new Set(registeredNames);
  }

  /** SDK 7 emits an invalid tool-call before its tool-error; execute does not run. */
  noteChunk(chunk: unknown): void {
    if (this.recordedCount >= MAX_ARTIFACT_REJECTION_LOGS_PER_TURN) return;
    try {
      if (!chunk || typeof chunk !== "object") return;
      const part = chunk as Record<string, unknown>;
      if (
        part.type !== "tool-call" ||
        part.invalid !== true ||
        part.providerExecuted === true ||
        typeof part.toolCallId !== "string" ||
        !part.toolCallId ||
        typeof part.toolName !== "string"
      ) return;
      this.record(part.toolCallId, part.toolName, part.input, "input_schema_rejected");
    } catch {
      // Even a hostile event object's property access cannot fail the chat.
    }
  }

  /** Collector admission reached execute, so it is not the SDK-invalid path. */
  record(
    toolCallId: string | undefined,
    toolName: string,
    input: unknown,
    rejectionCode: ArtifactToolRejectionCode
  ): void {
    if (!this.registeredNames.has(toolName)) return;
    if (this.recordedCount >= MAX_ARTIFACT_REJECTION_LOGS_PER_TURN) return;
    if (toolCallId && this.recordedCallIds.has(toolCallId)) return;
    if (toolCallId) this.recordedCallIds.add(toolCallId);
    this.recordedCount += 1;
    try {
      this.emit(JSON.stringify({
        event: "generated_artifact_tool_rejected",
        toolName,
        requestedFormat: requestedFormat(input),
        rejectionCode,
      }));
    } catch {
      // Logging is best-effort; never turn a file rejection into a chat error.
    }
  }
}
