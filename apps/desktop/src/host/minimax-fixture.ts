import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { same } from "../../../tomverse-cli/src/workspace.js";
import type { CliFixtureInput } from "./cli-fixture-input";
import { miniMaxRegion, miniMaxVersion, stageMiniMaxRuntime } from "./minimax-runtime";

const provider = "desktop-fixture";
export const miniMaxFixtureRoute = "custom_provider:" + provider;
export const miniMaxFixtureVariant = "thinking";
export const miniMaxFixtureModelSelection = (model: string) =>
  ["m", encodeURIComponent(miniMaxFixtureRoute), encodeURIComponent(model), "v", miniMaxFixtureVariant].join(":");

export async function miniMaxLaunch(fixture: CliFixtureInput, directory: string, profile: string, resume: boolean, signal: AbortSignal) {
  if (fixture.version !== miniMaxVersion) throw new Error("The MiniMax task fixture requires the verified CLI version.");
  const path = join(profile, "config.yaml");
  const config = JSON.stringify({
    agents: { default: { tools: ["todowrite"], builtinTools: [], skills: [],
      features: { mavis: false, delegation: false, webSearch: false } } },
    memory: { enabled: false, proactive: false },
    askUser: { enabled: false },
    skills: { external: { enabled: false } },
    beta: { ptc: false, ptcScripts: false, ptcStore: false, pluginMarketplaces: false, autoMemory: false,
      modelAccess: false, threadGoal: false },
    permissionMode: "default",
    custom_provider: { [provider]: { name: provider, kind: "custom", enabled: true, api: "openai-completions",
      options: { baseURL: fixture.origin + "/v1", authMode: "api-key", apiKey: "tomverse-loopback-only" },
      models: { [fixture.model]: { reasoning: true, thinking_config: { mode: "switchable", default_value: "true" } } },
    } },
    defaultModel: miniMaxFixtureRoute + "/" + fixture.model,
  });
  if (resume) {
    const file = await lstat(path);
    if (!file.isFile() || file.size !== Buffer.byteLength(config) || !same(await realpath(path), path) ||
        await readFile(path, "utf8") !== config) throw new Error("The saved MiniMax Desktop configuration changed.");
  } else await writeFile(path, config, { mode: 0o600, flag: "wx" });
  const { executable, entry } = await stageMiniMaxRuntime(fixture.executable, join(directory, "distribution"), signal);
  return { executable, args: ["--no-global-search-paths", entry, "acp"],
    env: { MINIMAX_DATA_DIR: profile, MAVIS_REGION: miniMaxRegion, DO_NOT_TRACK: "1" } };
}
