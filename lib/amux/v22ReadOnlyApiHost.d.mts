import type { AmuxV22ReadOnlyApiExecutionFrame } from "./v22ReadOnlyApiProtocol.mjs";

export declare function amuxV22ReadOnlyApiCredentialMetadataDigest(
  input: Record<string, unknown>,
): string;

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
  modelAccess(request: unknown): Promise<import("./v22ApiModelAccessProtocol.mjs").AmuxV22ApiModelAccessResult>;
  capabilities(): string[];
}>>;

export declare function probeAmuxV22ReadOnlyApiModelAccess(
  request: unknown,
  host: Record<string, unknown>,
  dependencies?: Record<string, unknown>,
): Promise<import("./v22ApiModelAccessProtocol.mjs").AmuxV22ApiModelAccessResult>;

export declare function readAmuxV22ReadOnlyApiLauncherState(
  worker: string,
  frame: AmuxV22ReadOnlyApiExecutionFrame,
  options?: Record<string, unknown>,
): Promise<Readonly<Record<string, unknown>>>;

export declare function inspectAmuxV22ReadOnlyApiLauncher(
  worker: string,
  frame: AmuxV22ReadOnlyApiExecutionFrame,
  options?: Record<string, unknown>,
): Promise<{ current: false } | { current: true; launcherConfigDigest: string }>;

export declare function inspectAmuxV22ReadOnlyApiStateDirectory(
  path: string,
  uid: number,
  options?: Record<string, unknown>,
): Promise<string>;
