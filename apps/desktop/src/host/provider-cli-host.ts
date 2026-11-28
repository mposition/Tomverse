import { readFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { cliLoginArguments, isCliScanProvider, type CliLoginOpen, type CliPathCheck, type CliProvider, type CliScan, type SavedCliPath } from "../code-execution";
import { cliLoginCommandLine, readCliLogin, type CliRunner, type LoginShell } from "./provider-cli-login";
import { installManifest, modulesAbove, nodeExecutable, resolveMiniMaxInstall } from "./minimax-install";
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
    // Only an install folder is trusted: a launcher or entry file picked directly would be trusted but could not be started.
    try { if (!(await lstat(await realpath(path))).isDirectory()) return null; } catch { return null; }
    return (await resolveMiniMaxInstall(path))?.entry ?? null;
  }

  async function isInstallFolder(path: string) {
    try { return (await lstat(await realpath(path))).isDirectory(); } catch { return false; }
  }

  /** The Node that would run a MiniMax Code install now: the one in the install folder, else the first real one in the scan's folders. */
  async function miniMaxNode(root: string) {
    const platform = options.scan?.platform ?? process.platform;
    const env = options.scan?.env ?? process.env;
    const directories = await expandScanDirectories(cliScanDirectories(platform, env, options.scan?.home ?? scanHome(env, platform)), platform);
    return nodeExecutable(directories, root, platform);
  }

  /**
   * The trusted file when it is still exactly the one that was trusted. For a MiniMax Code install that is its entry file and
   * also the Node that would run it now (`node`): a different Node, from another folder after the PATH changed or with other
   * bytes, is not the one the person trusted, and the install must be trusted again.
   */
  /** Whether Node would look for modules above this MiniMax Code release: any `node_modules` in a folder above it, the user module folders of the home folder, and the global folder of the Node that runs it. */
  async function modulesAboveRelease(release: string, node?: string) {
    const platform = options.scan?.platform ?? process.platform;
    const env = options.scan?.env ?? process.env;
    return modulesAbove(release, options.scan?.home ?? scanHome(env, platform), node, platform);
  }

  async function trustedWith(trust: CliTrustFile, provider: CliProvider, path: string, signal?: AbortSignal): Promise<{ file: string; fileStamp: string; node?: string } | null> {
    if (!isCliScanProvider(provider)) return null;
    const target = await trustTarget(provider, path);
    if (!target) return null;
    const record = trust.trusted?.[provider];
    const trusted = await trustedCliFile(target, record, signal);
    if (!trusted || provider !== "minimax") return trusted;
    const install = await resolveMiniMaxInstall(path);
    if (!install || install.entry !== trusted.file || !record?.node) return null;
    const node = await miniMaxNode(install.root);
    if (!node || !await trustedCliFile(node, record.node, signal)) return null;
    // Checked before every task: a folder of modules above the release, or in the Node's global folder, is code the digest below
    // does not cover.
    if (await modulesAboveRelease(install.release, node)) return null;
    // Every file of the release folder, read again now: a changed, added, removed or linked file is not what was trusted.
    const manifest = record.install ? await installManifest(install.release, { signal }) : null;
    return manifest && manifest.sha256 === record.install?.sha256 ? { ...trusted, node } : null;
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
      // A MiniMax Code file (mcode.cmd, mcode, cli.js) is not an install: the person is told to choose the installation folder.
      if (!target && provider === "minimax" && !(await isInstallFolder(path))) return { status: "wrongFile" };
      const hashed = target ? await trustRecordFor(target) : null;
      if (!hashed) return { status: "checkFailed" };
      let record = hashed.record;
      if (provider === "minimax") {
        // The Node that runs the entry file is trusted with it; with no Node to run it there is nothing to trust.
        const install = await resolveMiniMaxInstall(path);
        const node = install ? await miniMaxNode(install.root) : null;
        if (install && await modulesAboveRelease(install.release, node ?? undefined)) return { status: "modulesAbove" };
        const nodeRecord = node ? await trustRecordFor(node) : null;
        // The release folder as a whole is trusted with them; a folder that cannot be read whole (a link, too many files) is not.
        const manifest = install ? await installManifest(install.release) : null;
        if (!nodeRecord || !manifest) return { status: "checkFailed" };
        record = { ...record, node: nodeRecord.record, install: manifest };
      }
      storeTrust(withTrust(readTrust(), provider, record));
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
        // MiniMax Code is a Node program: the person's own Node, the one trusted with the install, runs its trusted entry file
        // (Electron cannot stand in for it in a release build).
        return trusted.node ? { file: trusted.node, version: null, basis: "person", args: [trusted.file] } : null;
      }
      return null;
    },

    close() {
      controller.current.abort();
      controller.current = new AbortController();
    },
  };
}
