import { z } from "zod";

/**
 * What the sandbox settings screen asks of the main process, and what it gets back. The screen never names a folder or a path:
 * it picks a mode, edits a list of host names, and asks for the markers Windows left on working folders to be removed. The main
 * process validates every one of them and decides.
 */

export const codeSandboxMode = z.enum(["off", "workspace-write", "read-only"]);
export type CodeSandboxMode = z.infer<typeof codeSandboxMode>;

export const MAX_SANDBOX_DOMAINS = 200;

export const codeSandboxInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("set-mode"), mode: codeSandboxMode }).strict(),
  z.object({ action: z.literal("set-domains"), domains: z.array(z.string().trim().min(1).max(253)).max(MAX_SANDBOX_DOMAINS) }).strict(),
  z.object({ action: z.literal("set-localhost"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("clear-marks") }).strict(),
]);
export type CodeSandboxInput = z.infer<typeof codeSandboxInput>;

export type CodeSandboxPlatform = "macos" | "linux" | "windows" | "other";

/** What the operating system really enforces on this computer. `none` is stated as plainly as `os`. */
export type CodeSandboxEnforcement = {
  available: boolean;
  /** Why it is not available. The screen has its own words for each. */
  unavailable?: "unsupported-platform" | "missing-sandbox-exec" | "sandbox-exec-failed" | "missing-bwrap" | "bwrap-failed" | "workspace-too-broad"
    | "windows-launcher-failed" | "windows-workspace-not-markable" | "proxy-failed";
  writes: "os" | "none";
  credentialReads: "os" | "partial" | "none";
  network: "os-proxy-only" | "os-blocked" | "environment-only" | "none";
};

export type CodeSandboxView = {
  mode: CodeSandboxMode;
  domains: string[];
  defaultDomains: string[];
  /** Entries of the last edit that were not host names and were dropped. */
  ignoredDomains: number;
  allowLocalhost: boolean;
  platform: CodeSandboxPlatform;
  /** What would be enforced for the chosen mode, or for workspace-write when the sandbox is off. */
  enforcement: CodeSandboxEnforcement;
  /** Whether `enforcement` describes the mode in use (false: a preview of workspace-write while the sandbox is off). */
  preview: boolean;
  /** Windows: working folders that carry the marker `workspace-write` needs. Removing the markers puts them back as they were. */
  markedFolders: number;
};
