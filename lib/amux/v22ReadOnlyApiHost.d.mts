import type { AmuxV22ReadOnlyApiExecutionFrame } from "./v22ReadOnlyApiProtocol.mjs";

export declare function amuxV22ReadOnlyApiLauncherConfigDigest(
  input: Record<string, unknown>,
): string;

export declare function createAmuxV22ReadOnlyApiHost(
  environment: Record<string, string | undefined>,
  dependencies?: Record<string, unknown>,
): Promise<Readonly<{
  worker: string;
  frame: AmuxV22ReadOnlyApiExecutionFrame;
  executor: Record<string, unknown>;
  apiExecutionFrameDigest: string;
  launcherConfigDigest: string;
  hostDeadlineAtMs: number;
  capabilities(): string[];
}>>;

export declare function inspectAmuxV22ReadOnlyApiLauncher(
  worker: string,
  frame: AmuxV22ReadOnlyApiExecutionFrame,
  options?: Record<string, unknown>,
): Promise<{ current: false } | { current: true; launcherConfigDigest: string }>;
