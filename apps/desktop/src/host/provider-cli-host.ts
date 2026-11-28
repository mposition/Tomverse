import { readFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { cliLoginArguments, isCliScanProvider, type CliLoginOpen, type CliPathCheck, type CliProvider, type CliScan, type SavedCliPath } from "../code-execution";
import { cliLoginCommandLine, readCliLogin, type CliRunner, type LoginShell } from "./provider-cli-login";
import { nodeExecutable, resolveMiniMaxInstall } from "./minimax-install";
import { cliPathStillMatches, inspectCliPath } from "./provider-cli-path";
import { cliScanDirectories, expandScanDirectories, scanCliProviders, scanHome, type ScanOptions } from "./provider-cli-scan";
import { cliTrustFile, trustRecordFor, trustedCliFile, withTrust, type CliTrustFile } from "./provider-cli-trust";

export type ProviderCliHostOptions = {
  /** The account's settings file for trusted files and the first-run offer. Null while no scope is available. */
  trustPath: () => string | null;
  writeTrust: (path: string, text: string) => void;
  hasSaved: () => boolean;
  /** Types the sign-in command into a task terminal, when the terminal is on and a task is open. */
  typeIntoTerminal: (command: string) => CliLoginOpen;
  /** The syntax of the shell the terminal opens. */
  shell: () => LoginShell;
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

  /**
   * The file whose bytes the person trusts: the file itself, or for a MiniMax Code install folder its entry file (the package's
   * `cli.js`, found inside the folder without leaving it). Null when a folder is no install.
   */
  async function trustTarget(provider: CliProvider, path: string): Promise<string | null> {
    if (provider !== "minimax") return path;
    try { if (!(await lstat(await realpath(path))).isDirectory()) return path; } catch { return path; }
    return (await resolveMiniMaxInstall(path))?.entry ?? null;
  }

  async function trustedWith(trust: CliTrustFile, provider: CliProvider, path: string, signal?: AbortSignal) {
    if (!isCliScanProvider(provider)) return null;
    const target = await trustTarget(provider, path);
    return target ? trustedCliFile(target, trust.trusted?.[provider], signal) : null;
  }

  async function scan(): Promise<CliScan> {
    const signal = controller.current.signal;
    const trust = readTrust();
    const providers = await scanCliProviders({
      ...options.scan, signal, inspect,
      readLogin: (provider, file, aborted) => readCliLogin(provider, file, aborted, options.run),
      isTrusted: async (provider, file, aborted) => (await trustedWith(trust, provider, file, aborted)) !== null,
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
      return trustedWith(readTrust(), provider, path, signal);
    },

    /** Records that the person trusts this exact file. Returns "verified" when the file needs no trust. */
    async trust(provider: CliProvider, path: string): Promise<"stored" | "verified" | CliPathCheck> {
      if (!isCliScanProvider(provider)) return { status: "wrongFile" };
      const inspection = await inspectCliPath(provider, path);
      if (inspection.status === "pathVerified") return "verified";
      if (inspection.status !== "versionUnverified") return inspection;
      const target = await trustTarget(provider, path);
      const hashed = target ? await trustRecordFor(target) : null;
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
      const command = cliLoginCommandLine(provider, inspection.file, options.shell());
      return command ? options.typeIntoTerminal(command) : "unavailable";
    },

    /**
     * The saved file as a task may start it, checked again now: a verified file against its pinned release, a file the
     * person trusted against its record. Null when the saved file is gone, changed or was never checked.
     */
    async resolveSaved(provider: CliProvider, saved: SavedCliPath | undefined, signal?: AbortSignal): Promise<{ file: string; version: string | null; basis: "release" | "person"; args?: string[] } | null> {
      if (!saved) return null;
      if (saved.status === "pathVerified") {
        const inspection = await inspect(provider, saved.path, signal);
        return inspection.status === "pathVerified" && inspection.version === saved.version ? { file: inspection.file, version: inspection.version, basis: "release" } : null;
      }
      if (saved.status === "userTrusted") {
        const trusted = await this.trustedFile(provider, saved.path, signal);
        if (!trusted) return null;
        if (provider !== "minimax") return { file: trusted.file, version: null, basis: "person" };
        // MiniMax Code is a Node program: the person's own Node runs the trusted entry file (Electron cannot stand in for it in a release build).
        const install = await resolveMiniMaxInstall(saved.path);
        if (!install || install.entry !== trusted.file) return null;
        const platform = options.scan?.platform ?? process.platform;
        const env = options.scan?.env ?? process.env;
        const directories = await expandScanDirectories(cliScanDirectories(platform, env, options.scan?.home ?? scanHome(env, platform)), platform);
        const node = await nodeExecutable(directories, install.root, platform);
        return node ? { file: node, version: null, basis: "person", args: [trusted.file] } : null;
      }
      return null;
    },

    close() {
      controller.current.abort();
      controller.current = new AbortController();
    },
  };
}
