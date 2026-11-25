import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { canonicalDigest } from "../../../tomverse-cli/src/session.js";
import { same } from "../../../tomverse-cli/src/workspace.js";
import type { ZCodeFixtureInput } from "./cli-fixture-input";
import { stageZCodeRuntime, zCodeVersion } from "./zcode-runtime";

export const zCodeFixtureProvider = "fixture-local";
export const zCodePlanProvider = "account:zai-individual-coding-plan";
export const zCodeFixtureSelection = (model: string, codingPlan = false) => ({
  providerId: codingPlan ? zCodePlanProvider : zCodeFixtureProvider, modelId: model,
  options: { reasoningLevel: codingPlan ? "high" : "disabled" },
});

const builtinConfig = z.looseObject({
  revision: z.int().positive(),
  config: z.looseObject({ providerConfigRules: z.looseObject({
    providerRules: z.array(z.looseObject({ providerId: z.string(), config: z.looseObject({
      api: z.looseObject({ type: z.string(), baseUrl: z.string() }).optional(),
    }) })),
  }) }),
});

export async function zCodeLaunch(fixture: ZCodeFixtureInput, directory: string, profile: string, resume: boolean, signal: AbortSignal) {
  if (fixture.version !== zCodeVersion) throw new Error("The ZCode task fixture requires the verified CLI version.");
  const personal = join(profile, "provider_config.json");
  const database = join(profile, "session.sqlite");
  const config = { schemaVersion: 1, config: {
    providerConfigRules: { providerRules: fixture.codingPlan ? [] : [{ providerId: zCodeFixtureProvider, config: {
      group: "standard-personal", access: { type: "api-key", apiKey: "tomverse-loopback-only" },
      api: { type: "openai-chat-completions", baseUrl: fixture.origin + "/v1" }, personalModelIds: [fixture.model],
    } }] },
    modelConfigRules: { providerModelRules: fixture.codingPlan ? [] : [{ providerId: zCodeFixtureProvider, modelId: fixture.model,
      config: { properties: { inputFormat: { supportsImage: false } } } }], manualProviderModelRules: [] },
    defaultModelSelection: zCodeFixtureSelection(fixture.model, fixture.codingPlan),
  } };
  if (resume) {
    const file = await lstat(personal);
    // ZCode reformats its provider file while persisting the first session.
    if (!file.isFile() || file.size > 16 * 1024 || !same(await realpath(personal), personal) ||
        canonicalDigest(JSON.parse(await readFile(personal, "utf8"))) !== canonicalDigest(config)) {
      throw new Error("The saved ZCode Desktop configuration changed.");
    }
    if (!(await lstat(database)).isFile() || !same(await realpath(database), database)) {
      throw new Error("The saved ZCode Desktop session database moved.");
    }
  } else await writeFile(personal, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  const { executable, entry, config: builtin } = await stageZCodeRuntime(fixture.executable, join(directory, "distribution"), signal);
  let builtinPath = builtin;
  let codingPlanRevision: string | undefined;
  if (fixture.codingPlan) {
    const release = builtinConfig.parse(JSON.parse(await readFile(builtin, "utf8")));
    const plan = release.config.providerConfigRules.providerRules.filter(({ providerId }) => providerId === zCodePlanProvider);
    const api = plan[0]?.config.api;
    if (plan.length !== 1 || api?.type !== "anthropic-messages" || api.baseUrl !== "https://api.z.ai/api/anthropic") {
      throw new Error("ZCode changed its Coding Plan provider configuration.");
    }
    api.baseUrl = fixture.origin;
    // Keep the verified release intact. Only this disposable profile uses the loopback provider.
    builtinPath = join(directory, "builtin-loopback.json");
    await writeFile(builtinPath, JSON.stringify(release), { mode: 0o600, flag: "wx" });
    codingPlanRevision = `zcode-builtin:${release.revision}:${createHash("sha256").update(builtinPath).digest("hex")}`;
  }
  return { executable, codingPlanRevision, args: ["--no-global-search-paths", entry, "app-server", "--stdio"], env: {
    ELECTRON_RUN_AS_NODE: "1", ZCODE_RUNTIME_ENV: "production", ZCODE_MODEL_TELEMETRY_ENABLED: "false",
    ZCODE_HOME: profile, ZCODE_DATA_BASE_DIR: profile, ZCODE_SESSION_DB: database, ZCODE_STORAGE_DIR: join(profile, "storage"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
  } };
}

// The pinned CLI uses CONNECT even for loopback. Allow only the two endpoints
// created for this run, without resolving names or forwarding to other ports.
export async function startZCodeFixtureProxy(modelOrigin: string, mcpUrl: string, signal: AbortSignal) {
  const targets = new Map<string, number>();
  for (const endpoint of [modelOrigin, mcpUrl]) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
      throw new Error("ZCode fixture endpoints must be local.");
    }
    targets.set(url.host, Number(url.port));
  }
  const sockets = new Set<Socket>();
  const listener = createServer((_request, response) => response.writeHead(403).end());
  listener.on("connect", (request, downstream, head) => {
    const port = targets.get(request.url ?? "");
    if (!port || signal.aborted || sockets.size >= 16) {
      downstream.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connect({ port, host: "127.0.0.1" });
    sockets.add(upstream);
    downstream.once("error", () => upstream.destroy());
    upstream.once("error", () => downstream.destroy());
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => { sockets.delete(upstream); downstream.destroy(); });
    upstream.once("connect", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
  });
  signal.throwIfAborted();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") {
    listener.close();
    throw new Error("The ZCode fixture proxy did not acquire a loopback address.");
  }
  let closed: Promise<void> | undefined;
  const close = () => {
    signal.removeEventListener("abort", stop);
    closed ??= new Promise<void>((resolve) => {
      listener.close(() => resolve());
      for (const socket of sockets) socket.destroy();
      listener.closeAllConnections();
    });
    return closed;
  };
  const stop = () => { void close(); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return { origin: "http://127.0.0.1:" + address.port, close };
}
