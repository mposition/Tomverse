import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_ALLOWED_DOMAINS, normalizeAllowedDomains } from "../../../tomverse-cli/src/net-proxy.js";
import { writeFileAtomic } from "../../../tomverse-cli/src/runtime.js";
import {
  createSandboxRuntime, defaultSandboxSettings, normalizeSandboxSettings, sandboxEnforcement, sandboxPlatform, type SandboxRuntime, type SandboxSettings,
} from "../../../tomverse-cli/src/sandbox.js";
import { clearWindowsMarks, markedWorkspaces } from "../../../tomverse-cli/src/sandbox-windows.js";
import type { CodeSandboxEnforcement, CodeSandboxInput, CodeSandboxView } from "../code-sandbox-contract";

/**
 * The OS sandbox for Desktop Code tasks (the Tomverse API path; the provider CLIs run their own). The settings live in Desktop's
 * own data folder, which the file tools never touch, and are read again when each task starts, so a change applies to the next
 * task. Off is the default and what anything unreadable means.
 */

const settingsFile = (directory: string) => join(directory, "settings.json");
const stateDirectory = (directory: string) => join(directory, "state");

export function readCodeSandboxSettings(directory: string): SandboxSettings {
  try { return normalizeSandboxSettings(JSON.parse(readFileSync(settingsFile(directory), "utf8"))); }
  catch { return defaultSandboxSettings(); }
}

function writeCodeSandboxSettings(directory: string, settings: SandboxSettings) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(settingsFile(directory), JSON.stringify(settings));
}

/** The sandbox a task of this project runs commands in, or null when the person left it off. One that cannot be built comes back too and refuses commands. */
export async function startCodeSandbox(directory: string | undefined, projectPath: string): Promise<SandboxRuntime | null> {
  if (!directory) return null;
  return createSandboxRuntime({
    settings: readCodeSandboxSettings(directory),
    workspaceRoot: projectPath,
    stateDir: stateDirectory(directory),
    // Desktop's own data folder holds the signed-in session and the saved tasks: a command may not read it.
    extraDenyRead: [dirname(directory)],
  });
}

const enforcementView = ({ available, unavailable, writes, credentialReads, network }: Awaited<ReturnType<typeof sandboxEnforcement>>): CodeSandboxEnforcement =>
  ({ available, ...(unavailable ? { unavailable } : {}), writes, credentialReads, network });

export async function codeSandboxView(directory: string, input: CodeSandboxInput): Promise<CodeSandboxView> {
  let settings = readCodeSandboxSettings(directory);
  let ignoredDomains = 0;
  if (input.action === "set-mode") settings = { ...settings, mode: input.mode };
  if (input.action === "set-localhost") settings = { ...settings, allowLocalhost: input.enabled };
  if (input.action === "set-domains") {
    const domains = normalizeAllowedDomains(input.domains);
    ignoredDomains = new Set(input.domains.map((value) => value.trim().toLowerCase())).size - domains.length;
    settings = { ...settings, allowedDomains: domains };
  }
  if (input.action !== "read" && input.action !== "clear-marks") writeCodeSandboxSettings(directory, settings);
  if (input.action === "clear-marks") await clearWindowsMarks(stateDirectory(directory));
  const preview = settings.mode === "off";
  const enforcement = await sandboxEnforcement(preview ? "workspace-write" : settings.mode, { stateDir: stateDirectory(directory) });
  return {
    mode: settings.mode,
    domains: settings.allowedDomains,
    defaultDomains: [...DEFAULT_ALLOWED_DOMAINS],
    ignoredDomains,
    allowLocalhost: settings.allowLocalhost,
    platform: sandboxPlatform(),
    enforcement: enforcementView(enforcement),
    preview,
    markedFolders: process.platform === "win32" ? markedWorkspaces(stateDirectory(directory)).length : 0,
  };
}
