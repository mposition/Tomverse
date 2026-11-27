import { readFileSync } from "node:fs";
import { cliLoginArguments, isCliScanProvider, type CliLoginOpen, type CliPathCheck, type CliProvider, type CliScan } from "../code-execution";
import { cliLoginCommandLine, readCliLogin, type CliRunner } from "./provider-cli-login";
import { cliPathStillMatches, inspectCliPath } from "./provider-cli-path";
import { scanCliProviders, type ScanOptions } from "./provider-cli-scan";
import { cliTrustFile, trustRecordFor, trustedCliFile, withTrust, type CliTrustFile } from "./provider-cli-trust";

export type ProviderCliHostOptions = {
  /** The account's settings file for trusted files and the first-run offer. Null while no scope is available. */
  trustPath: () => string | null;
  writeTrust: (path: string, text: string) => void;
  hasSaved: () => boolean;
  /** Types the sign-in command into a task terminal, when the terminal is on and a task is open. */
  typeIntoTerminal: (command: string) => CliLoginOpen;
  scan?: Pick<ScanOptions, "platform" | "arch" | "env" | "home">;
  /** Replaces the program runner, for tests. */
  run?: CliRunner;
};

/** Finds, checks and signs in the provider CLIs installed on this computer. It starts a program only for a file that matched its pinned release. */
export function createProviderCliHost(options: ProviderCliHostOptions) {
  const verified = new Map<string, Awaited<ReturnType<typeof inspectCliPath>> & { status: "pathVerified" }>();
  const controller = { current: new AbortController() };
  let running: Promise<CliScan> | null = null;

  function readTrust(): CliTrustFile {
    const path = options.trustPath();
    if (!path) return {};
    try { return cliTrustFile.parse(JSON.parse(readFileSync(path, "utf8"))); } catch { return {}; }
  }

  function storeTrust(next: CliTrustFile) {
    const path = options.trustPath();
    if (!path) throw new Error("No account settings are available.");
    options.writeTrust(path, JSON.stringify(cliTrustFile.parse(next)));
  }

  /** A verified file is not hashed again while its size, times and identity stay the same. */
  async function inspect(provider: CliProvider, path: string, signal?: AbortSignal) {
    const key = provider + "\0" + path;
    const cached = verified.get(key);
    if (cached && await cliPathStillMatches(provider, path, cached, signal)) return cached;
    verified.delete(key);
    const result = await inspectCliPath(provider, path, signal);
    if (result.status === "pathVerified") verified.set(key, result);
    return result;
  }

  async function scan(): Promise<CliScan> {
    const signal = controller.current.signal;
    const trust = readTrust();
    const providers = await scanCliProviders({
      ...options.scan, signal, inspect,
      readLogin: (provider, file, aborted) => readCliLogin(provider, file, aborted, options.run),
      isTrusted: async (provider, file, aborted) => (await trustedCliFile(file, trust.trusted?.[provider], aborted)) !== null,
    });
    const found = providers.some(({ candidates }) => candidates.some(({ status }) => status === "pathVerified"));
    return { providers, offer: found && !options.hasSaved() && trust.offered !== true };
  }

  return {
    /** One scan at a time: a second request while one runs gets the same result. */
    scan() {
      running ??= scan().finally(() => { running = null; });
      return running;
    },

    /** The saved file's trust, for the check that saves a path. */
    async trustedFile(provider: CliProvider, path: string, signal?: AbortSignal) {
      return isCliScanProvider(provider) ? trustedCliFile(path, readTrust().trusted?.[provider], signal) : null;
    },

    /** Records that the person trusts this exact file. Returns "verified" when the file needs no trust. */
    async trust(provider: CliProvider, path: string): Promise<"stored" | "verified" | CliPathCheck> {
      if (!isCliScanProvider(provider)) return { status: "wrongFile" };
      const inspection = await inspectCliPath(provider, path);
      if (inspection.status === "pathVerified") return "verified";
      if (inspection.status !== "versionUnverified") return inspection;
      const hashed = await trustRecordFor(path);
      if (!hashed) return { status: "checkFailed" };
      storeTrust(withTrust(readTrust(), provider, hashed.record));
      return "stored";
    },

    /** Marks the first-run offer as answered, so it is shown once. */
    dismissOffer() {
      if (options.trustPath()) storeTrust({ ...readTrust(), offered: true });
    },

    /** Types the official sign-in command into a task terminal for a file that still matches its pinned release. */
    async login(provider: CliProvider, path: string): Promise<CliLoginOpen> {
      if (!cliLoginArguments[provider]) return "unavailable";
      const inspection = await inspect(provider, path);
      if (inspection.status !== "pathVerified") return "unavailable";
      const command = cliLoginCommandLine(provider, inspection.file);
      return command ? options.typeIntoTerminal(command) : "unavailable";
    },

    close() {
      controller.current.abort();
      controller.current = new AbortController();
    },
  };
}
