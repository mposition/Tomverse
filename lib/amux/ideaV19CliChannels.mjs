import { posix } from "node:path";

import { amuxV4ApprovedAnalysisCliForModel } from
  "./ideaLocalApprovedCliCatalog.mjs";

/** One execution profile per v19 subscription CLI channel (owner decision
 * 2026-10-20: every channel signs in with a subscription account). A provider
 * value names the CLI channel, as in lib/amux/ideaAnalysisChannelCore.ts.
 *
 * The anthropic channel keeps its pinned Claude binary, OAuth bridge and
 * strict stream parser (ideaTrackedCheckoutSandbox.mjs and friends). The other
 * channels resolve the CLI the operator installed, check its owner and mode,
 * stage a private copy and record that copy's sha256 with the result instead
 * of pinning a digest: these CLIs update themselves often.
 *
 * Every value below was measured inside the v19 bwrap sandbox, under strace and
 * the v19 seccomp filter, on the Ubuntu runner (2026-10-20, synthetic prompt):
 * egress hosts are the minimum each CLI needed with every other CONNECT
 * refused; no seccomp change was needed. */
const HOME = "/home/tommy";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CHECKOUT = /^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/;
const SOCKET_DIRECTORY = /^\/tmp\/amux-v4-[A-Za-z0-9-]{1,80}$/;
const STAGED_ROOT = /^\/tmp\/amux-v4-cli-[A-Za-z0-9-]{1,80}$/;
const AUTH_FILE = /^\/tmp\/amux-v19-auth-[A-Za-z0-9]{6}\/(?:auth\.json|auth-token)$/;

const CHANNELS = Object.freeze({
  anthropic: Object.freeze({
    provider: "anthropic", launchable: true, pinned: true,
    authProfile: "claude-max-oauth", modelAttestation: "served",
  }),
  openai: Object.freeze({
    provider: "openai",
    // Measured: Codex's own read-only shell sandbox cannot start inside the v19
    // bwrap sandbox on this runner (its bwrap mode: AppArmor refuses the nested
    // user namespace; its legacy Landlock mode fails too), so Codex cannot read
    // the checkout. The channel stays closed until the owner decides how Codex
    // may run its shell; discovery then never claims a Codex reservation.
    launchable: false,
    authProfile: "codex-chatgpt", modelAttestation: "requested",
    install: Object.freeze({ kind: "directory", link: `${HOME}/.local/bin/codex`,
      entry: "bin/codex", root: /^\/home\/tommy\/\.codex\/packages\/standalone\/releases\/[0-9][0-9A-Za-z.+_-]{0,80}$/,
      skip: Object.freeze([]) }),
    mount: "/run/amux-cli/codex", staged: "codex",
    auth: "codex", authSource: `${HOME}/.codex/auth.json`,
    // ab.chatgpt.com (experiments) was refused without effect.
    egressHosts: Object.freeze(["chatgpt.com"]),
    efforts: Object.freeze(["low", "medium", "high", "xhigh"]),
    env: Object.freeze(["CODEX_HOME", "/tmp/.codex"]),
  }),
  "github-copilot": Object.freeze({
    provider: "github-copilot", launchable: true,
    authProfile: "copilot-github", modelAttestation: "served",
    // npm-loader.js only spawns this native binary on glibc x64.
    install: Object.freeze({ kind: "file", path: `${HOME}/.local/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot` }),
    mount: "/run/amux-cli/copilot", staged: "copilot",
    auth: "copilot", authSource: `${HOME}/.copilot/config.json`,
    // telemetry.individual.githubcopilot.com was refused without effect.
    egressHosts: Object.freeze(["api.github.com", "api.individual.githubcopilot.com"]),
    efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    env: Object.freeze([]),
  }),
  cursor: Object.freeze({
    provider: "cursor", launchable: true,
    authProfile: "cursor-login", modelAttestation: "requested",
    // `.running` holds the operator's live process markers, not code.
    install: Object.freeze({ kind: "directory", link: `${HOME}/.local/bin/cursor-agent`,
      entry: "cursor-agent", root: /^\/home\/tommy\/\.local\/share\/cursor-agent\/versions\/[0-9][0-9A-Za-z.+_-]{0,80}$/,
      skip: Object.freeze([".running"]) }),
    mount: "/run/amux-cli/cursor", staged: "cursor",
    auth: "cursor", authSource: `${HOME}/.config/cursor/auth.json`,
    // downloads.cursor.com (update check) was refused without effect; the
    // agent backend host is required.
    egressHosts: Object.freeze(["api2.cursor.sh", "agentn.global.api5.cursor.sh"]),
    // The Cursor model name carries any effort; the reservation's effort is
    // recorded but not passed.
    efforts: null,
    env: Object.freeze([]),
  }),
});

export const AMUX_V19_CLI_CHANNEL_PROVIDERS = Object.freeze(Object.keys(CHANNELS));

export function amuxV19CliChannel(provider) {
  return typeof provider === "string" && Object.hasOwn(CHANNELS, provider)
    ? CHANNELS[provider] : null;
}

/** CLI admission for one queued reservation. The app's audited Frontier
 * catalog, approved price, budget hold and switches remain separate gates.
 * Claude keeps the exact tuple the owner approved after the 2026-10-04 S0;
 * another channel admits any model its CLI can be asked for by name. */
export function amuxV19ChannelAdmits(input) {
  const channel = amuxV19CliChannel(input?.provider);
  if (!channel?.launchable || typeof input.modelId !== "string" ||
      !MODEL_ID.test(input.modelId) || !EFFORTS.includes(input.reasoningEffort))
    return false;
  if (channel.pinned) {
    const approved = amuxV4ApprovedAnalysisCliForModel(input.modelId);
    return approved?.provider === "anthropic" &&
      approved.reasoningEffort === input.reasoningEffort &&
      approved.egressHosts?.length === 1 &&
      approved.egressHosts[0] === "api.anthropic.com";
  }
  return channel.efforts === null || channel.efforts.includes(input.reasoningEffort);
}

// The prompt always arrives on stdin, never in argv (argv is visible to other
// local processes and bounded per argument).
const commandTemplate = (channel) => {
  switch (channel.provider) {
    case "openai": return [`${channel.mount}/bin/codex`, "exec", "--json",
      "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
      "-m", "{model}", "-c", "model_reasoning_effort=\"{effort}\"", "-"];
    case "github-copilot": return [channel.mount, "--output-format", "json",
      "--model", "{model}", "--reasoning-effort", "{effort}",
      "--available-tools", "view", "glob", "grep", "--allow-all-tools",
      "--no-ask-user", "--no-custom-instructions", "--no-auto-update",
      "--no-color", "--disable-builtin-mcps"];
    case "cursor": return [`${channel.mount}/node`, `${channel.mount}/index.js`,
      "-p", "--output-format", "stream-json", "--mode", "ask", "--trust",
      "--workspace", "{cwd}", "--model", "{model}"];
    default: return null;
  }
};

const fillCommand = (template, values) => template.map((part) => part
  .split("{cwd}").join(values.cwd).split("{model}").join(values.model)
  .split("{effort}").join(values.effort));

/** The exact command the in-sandbox bridge starts for a non-Claude channel.
 * Pure: it neither stages nor admits anything. A closed channel still has a
 * well-defined command; launching it remains gated by `launchable`. */
export function amuxV19ChannelCommand(input) {
  const channel = amuxV19CliChannel(input?.provider);
  if (!channel || channel.pinned || !CHECKOUT.test(input.directory ?? "") ||
      posix.normalize(input.directory) !== input.directory ||
      typeof input.modelId !== "string" || !MODEL_ID.test(input.modelId) ||
      !EFFORTS.includes(input.reasoningEffort) ||
      (channel.efforts !== null && !channel.efforts.includes(input.reasoningEffort))) {
    throw new TypeError("invalid v19 channel command");
  }
  return Object.freeze(fillCommand(commandTemplate(channel), {
    cwd: input.directory, model: input.modelId,
    effort: channel.efforts === null ? "-" : input.reasoningEffort,
  }));
}

/** Fixed bridge per channel: relays 127.0.0.1:3128 to the private proxy socket
 * and starts only its channel's command, rebuilt from the embedded template,
 * the checkout cwd and two checked argv values. The Copilot token is read from
 * a read-only mount into the child's environment only. */
export function amuxV19ChannelBridgeSource(provider) {
  const channel = amuxV19CliChannel(provider);
  if (!channel || channel.pinned) throw new TypeError("invalid v19 channel bridge");
  const spec = { command: commandTemplate(channel), cwd: CHECKOUT.source,
    model: MODEL_ID.source, efforts: channel.efforts,
    tokenFile: channel.auth === "copilot" ? "/run/amux-cli/auth-token" : null,
    tokenEnv: channel.auth === "copilot" ? "COPILOT_GITHUB_TOKEN" : null,
    tokenPattern: channel.auth === "copilot" ? "^gho_[A-Za-z0-9]{20,255}$" : null };
  return String.raw`
const net = require("node:net");
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const SPEC = ${JSON.stringify(spec)};
const cwd = process.cwd();
const [model, effort, ...extra] = process.argv.slice(1);
if (extra.length !== 0 || !new RegExp(SPEC.cwd).test(cwd) ||
    !new RegExp(SPEC.model).test(model || "") ||
    (SPEC.efforts ? !SPEC.efforts.includes(effort) : effort !== "-")) {
  process.stderr.write("bridge_command_invalid\n");
  process.exit(2);
}
const command = SPEC.command.map((part) => part.split("{cwd}").join(cwd)
  .split("{model}").join(model).split("{effort}").join(effort));
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect("/run/amux/proxy.sock");
  sockets.add(client); sockets.add(upstream);
  client.pipe(upstream); upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => { sockets.delete(client); upstream.destroy(); });
  upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
});
server.maxConnections = 16;
server.listen(3128, "127.0.0.1", () => {
  const env = { ...process.env };
  if (SPEC.tokenEnv) {
    try {
      const bytes = readFileSync(SPEC.tokenFile);
      const token = bytes.toString("utf8").trim();
      bytes.fill(0);
      if (!new RegExp(SPEC.tokenPattern).test(token)) throw new Error("invalid_token");
      env[SPEC.tokenEnv] = token;
    } catch {
      process.stderr.write("bridge_auth_unavailable\n");
      process.exitCode = 2;
      server.close();
      return;
    }
  }
  const child = spawn(command[0], command.slice(1), { shell: false, stdio: "inherit", env, cwd });
  if (SPEC.tokenEnv) delete env[SPEC.tokenEnv];
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    for (const socket of sockets) socket.destroy();
    server.close(() => { process.exitCode = code; });
  };
  child.once("error", () => finish(1));
  child.once("close", (code, signal) =>
    finish(signal ? 1 : (code === null || code === undefined ? 1 : code)));
});
server.once("error", () => {
  process.stderr.write("bridge_listen_failed\n");
  process.exitCode = 1;
});
`;
}

/** The read-only mounts for one staged credential copy. Nothing in the sandbox
 * can write it, and no refresh secret is in it (see ideaV19CliChannelHost.mjs). */
const authBinds = (channel, file) => {
  switch (channel.auth) {
    case "codex": return ["--dir", "/tmp/.codex", "--ro-bind", file, "/tmp/.codex/auth.json"];
    case "copilot": return ["--ro-bind", file, "/run/amux-cli/auth-token"];
    case "cursor": return ["--dir", "/tmp/.config", "--dir", "/tmp/.config/cursor",
      "--ro-bind", file, "/tmp/.config/cursor/auth.json"];
    default: return null;
  }
};

/** bwrap arguments for one non-Claude channel over a scanned checkout. Pure:
 * the host runner must verify the socket, staged copy, credential copy and
 * checkout immediately before spawning. */
export function planAmuxV19ChannelSandbox(input) {
  const channel = amuxV19CliChannel(input?.provider);
  const stagedRoot = typeof input?.installPath === "string"
    ? input.installPath.slice(0, input.installPath.lastIndexOf("/")) : "";
  if (!channel || channel.pinned ||
      !SOCKET_DIRECTORY.test(input.socketDirectory ?? "") ||
      !STAGED_ROOT.test(stagedRoot) ||
      input.installPath !== `${stagedRoot}/${channel.staged}` ||
      !AUTH_FILE.test(input.authFile ?? "") ||
      (channel.auth === "copilot") !== input.authFile.endsWith("/auth-token")) {
    throw new TypeError("invalid v19 channel sandbox");
  }
  const command = amuxV19ChannelCommand({ provider: channel.provider,
    directory: input.checkoutDirectory, modelId: input.modelId,
    reasoningEffort: input.reasoningEffort });
  const cwd = input.checkoutDirectory;
  return Object.freeze({
    command,
    args: Object.freeze([
      "--unshare-all", "--die-with-parent", "--cap-drop", "ALL", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--dir", "/run", "--dir", "/run/amux-cli",
      "--ro-bind", input.installPath, channel.mount,
      ...authBinds(channel, input.authFile),
      "--dir", "/etc", "--dir", "/etc/ssl",
      "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs",
      "--ro-bind", input.socketDirectory, "/run/amux",
      "--dir", cwd, "--ro-bind", cwd, cwd, "--chdir", cwd,
      "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
      "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128",
      "--setenv", "HTTP_PROXY", "http://127.0.0.1:3128",
      "--setenv", "SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt",
      ...(channel.env.length === 2 ? ["--setenv", ...channel.env] : []),
      "--", "/usr/bin/node", "-e", amuxV19ChannelBridgeSource(channel.provider),
      "--", input.modelId, channel.efforts === null ? "-" : input.reasoningEffort,
    ]),
  });
}
