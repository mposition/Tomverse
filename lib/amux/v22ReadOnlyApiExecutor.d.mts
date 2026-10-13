import type {
  AmuxV22ReadOnlyApiExecutionFrame,
  AmuxV22ReadOnlyApiExecutionReceipt,
} from "./v22ReadOnlyApiProtocol.mjs";

export type AmuxV22ReadOnlyApiExecutionResult = Readonly<{
  kind: "succeeded" | "failed" | "blocked" | "outcome_unknown";
  error: string | null;
  apiExecutionReceipt: AmuxV22ReadOnlyApiExecutionReceipt | null;
  resultText: string | null;
}>;

export declare function amuxV22ReadOnlyApiExecutorCapabilities(
  runtime: Record<string, unknown>,
  frame?: AmuxV22ReadOnlyApiExecutionFrame,
  options?: { now?: Date | string | number },
): string[];

export declare function createAmuxV22ReadOnlyApiExecutor(runtime: Record<string, unknown>):
Readonly<{
  capabilities(frame?: AmuxV22ReadOnlyApiExecutionFrame,
    options?: { now?: Date | string | number }): string[];
  execute(raw: {
    version: 1;
    capability: "read_only_api_retry_v1";
    attemptId: string;
    invocationId: string;
    prompt: string;
    apiExecutionFrame: AmuxV22ReadOnlyApiExecutionFrame;
    apiExecutionFrameDigest: string;
  }): Promise<AmuxV22ReadOnlyApiExecutionResult>;
}>;
