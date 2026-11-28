import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { unknownCliAccount, type CliAccount } from "../code-execution";
import { isolatedCliEnvironment } from "./cli-protocol";
import { stageCliExecutable } from "./provider-cli-path";

const exec = promisify(execFile);
const authStatus = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string(),
  apiProvider: z.string().nullish(),
  subscriptionType: z.string().nullish(),
  loginExpiresAt: z.iso.datetime({ offset: true }).nullish(),
  configDirectory: z.string().optional(),
});
const subscriptionPlans = new Set(["pro", "max", "ultra", "team", "enterprise"]);

export function claudeAccountFromStatus(output: string, exitCode: number, now = Date.now(), expectedProfile?: string): CliAccount {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return unknownCliAccount; }
  const parsed = authStatus.safeParse(value);
  if (!parsed.success || exitCode !== (parsed.data.loggedIn ? 0 : 1)) return unknownCliAccount;
  if (expectedProfile && (!parsed.data.configDirectory || normalize(parsed.data.configDirectory) !== normalize(expectedProfile))) return unknownCliAccount;
  const { loggedIn, authMethod, apiProvider, subscriptionType, loginExpiresAt } = parsed.data;
  if (authMethod === "claude.ai" && loginExpiresAt && Date.parse(loginExpiresAt) <= now) {
    return { status: "signInExpired", billingSource: "unknown" };
  }
  if (!loggedIn) return { status: "signInRequired", billingSource: "unknown" };
  if (authMethod === "none") return unknownCliAccount;
  if (apiProvider === "firstParty" && authMethod === "claude.ai" && subscriptionType && subscriptionPlans.has(subscriptionType)) {
    return { status: "signedIn", billingSource: "provider_subscription" };
  }
  if ((apiProvider === "firstParty" && ["api_key", "api_key_helper"].includes(authMethod)) ||
      (authMethod === "third_party" && apiProvider && ["bedrock", "vertex", "foundry"].includes(apiProvider))) {
    return { status: "signedIn", billingSource: "provider_api" };
  }
  return { status: "signedIn", billingSource: "unknown" };
}

// The development probe uses an empty provider profile. The installed user's
// login is outside this probe's scope, including when a launch is retried.
export async function probeIsolatedClaudeAccount(file: string, cancel: AbortSignal, version: string): Promise<CliAccount> {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(60_000)]);
  if (signal.aborted) return unknownCliAccount;
  const directory = await mkdtemp(join(tmpdir(), "tomverse-claude-account-"));
  let profile: string | undefined;
  try {
    profile = await realpath(directory);
    const executable = await stageCliExecutable("anthropic", file, profile, version, signal);
    signal.throwIfAborted();
    await exec(executable, ["auth", "status"], {
      cwd: profile, env: { ...isolatedCliEnvironment(process.env, profile), CLAUDE_CONFIG_DIR: profile,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
      signal, timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true, shell: false, encoding: "utf8",
    });
    return unknownCliAccount;
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; killed?: boolean };
    if (!profile || failure.code !== 1 || failure.killed || signal.aborted || typeof failure.stdout !== "string") return unknownCliAccount;
    const account = claudeAccountFromStatus(failure.stdout, 1, Date.now(), profile);
    return account.status === "signInRequired" ? account : unknownCliAccount;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
