import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { discoverExtensions, expandInvocation, skillListing, slashEntries } from "../src/extensions.js";
import { HookRunner, loadHooks } from "../src/hooks.js";
import { loadMcpServers, expandMcpServer } from "../src/mcp-config.js";
import { copyTreeSafely, PluginError } from "../src/plugin-fs.js";
import { pluginCommand, type PluginIo } from "../src/plugin-cli.js";
import { inspectPlugin } from "../src/plugin-inspect.js";
import { commitStaged, describeStaged, listInstalledPlugins, removePlugin, stagePlugin, type StagedPlugin } from "../src/plugin-manager.js";
import { activePlugins, installedDir, readPluginState, setPluginEnabled, setPluginEnabledIn } from "../src/plugin-store.js";
import { hookGate, mcpGate, openProjectTrust } from "../src/project-trust.js";
import { tempDir } from "./helpers.js";

const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
const write = (root: string, path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
};
const json = (value: unknown) => JSON.stringify(value);

/** Isolated user folders: the CLI's own home, Claude Code's folder, a fake `~`, and a project. */
const world = () => {
    const home = tempDir("plug-home");
    const claude = tempDir("plug-claude");
    const user = tempDir("plug-user");
    const root = tempDir("plug-root");
    const env = { TOMVERSE_HOME: home, CLAUDE_CONFIG_DIR: claude, HOME: user, USERPROFILE: user } as NodeJS.ProcessEnv;
    return { home, claude, user, root, env, discover: () => discoverExtensions(root, { home: user, env }) };
};

/** The command a hook runs: a Node script of the plugin that logs into the project folder. */
const markCommand = (label: string) => `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${ROOT_VAR}/scripts/mark.mjs" ${label}`;

const makePlugin = (dir: string, options: { name?: string; version?: string; hook?: string; mcpArgs?: string[]; manifest?: boolean } = {}) => {
    const name = options.name ?? "demo";
    if (options.manifest !== false) write(dir, ".claude-plugin/plugin.json", json({ name, version: options.version ?? "1.0.0", description: "Demo plugin", author: { name: "Someone" } }));
    write(dir, "skills/greet/SKILL.md", `---\ndescription: Greet from ${name}\nargument-hint: "[who]"\n---\nSay hello to $ARGUMENTS. Helper: ${ROOT_VAR}/scripts/helper.txt\n`);
    write(dir, "skills/hidden/SKILL.md", "---\ndescription: Only the user runs this\ndisable-model-invocation: true\n---\nHidden body.\n");
    write(dir, "commands/db/migrate.md", "---\ndescription: Migrate the database\n---\nMigrate with $ARGUMENTS.\n");
    write(dir, "commands/status.md", "Report the status.\n");
    write(dir, "agents/review/security.md", "---\nname: audit\ndescription: Security reviewer\ntools: Read, Grep\nhooks: ignored\n---\nReview for security. Notes: " + ROOT_VAR + "/notes.md\n");
    write(dir, "scripts/mark.mjs", `import { appendFileSync, readFileSync } from "node:fs";\nreadFileSync(0, "utf8");\nappendFileSync(process.env.CLAUDE_PROJECT_DIR + "/hook.log", process.argv[2] + " " + (process.env.CLAUDE_PLUGIN_ROOT ? "root" : "no-root") + "\\n");\n`);
    write(dir, "scripts/helper.txt", "helper\n");
    write(dir, "hooks/hooks.json", json({ hooks: { PostToolUse: [{ matcher: "read_file", hooks: [{ type: "command", command: options.hook ?? markCommand("one") }] }] } }));
    write(dir, ".mcp.json", json({ mcpServers: { db: { command: process.execPath, args: [`${ROOT_VAR}/server.mjs`, ...(options.mcpArgs ?? [])], env: { DB_ROOT: ROOT_VAR } } } }));
    write(dir, "server.mjs", "// fixture server\n");
    write(dir, "bin/tool", "#!/bin/sh\n");
    write(dir, "monitors/monitors.json", "[]");
};

const install = async (home: string, path: string): Promise<StagedPlugin> => {
    const result = await stagePlugin(home, { kind: "folder", path });
    assert.ok("staged" in result);
    commitStaged(home, result.staged);
    return result.staged;
};

test("a plugin folder is read as documented: manifest, default places, namespaced names, hooks and servers as written, and what is not used", () => {
    const dir = tempDir("plug-src");
    makePlugin(dir);
    const found = inspectPlugin(dir);
    assert.equal(found.name, "demo");
    assert.equal(found.version, "1.0.0");
    assert.equal(found.author, "Someone");
    assert.deepEqual(found.skills.sort(), ["demo:greet", "demo:hidden"]);
    assert.deepEqual(found.commands.sort(), ["demo:db:migrate", "demo:status"]);
    // A sub folder of agents/ is part of the name, and a front matter name replaces the file name only.
    assert.deepEqual(found.agents, ["demo:review:audit"]);
    assert.equal(found.hooks.length, 1);
    assert.equal(found.hooks[0]!.event, "PostToolUse");
    assert.equal(found.hooks[0]!.matcher, "read_file");
    assert.ok(found.hooks[0]!.command.includes(ROOT_VAR), "the confirmation shows the command as the plugin wrote it, not a path of the staging folder");
    assert.equal(found.mcpServers.length, 1);
    assert.equal(found.mcpServers[0]!.name, "plugin:demo:db");
    assert.match(found.mcpServers[0]!.summary, /server\.mjs/);
    assert.ok(found.notUsed.some((entry) => entry.startsWith("bin/")) && found.notUsed.some((entry) => entry.startsWith("monitors/")));
    assert.match(found.digest, /^[0-9a-f]{64}$/);
});

test("the manifest can name other places (skills, commands, agents, hooks, servers); a path that leaves the folder or is not ./ is refused", () => {
    const dir = tempDir("plug-manifest");
    write(dir, ".claude-plugin/plugin.json", json({
        name: "mapped",
        skills: ["./extra-skills/", "../outside", "/etc"],
        commands: { about: { source: "./docs/about.md" }, inline: { content: "inline text" } },
        agents: ["./custom/reviewer.md", "./custom/missing.md"],
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }] },
        mcpServers: { web: { type: "http", url: "https://example.test/mcp" }, local: { command: "node", args: ["x", "${user_config.token}"] } },
        lspServers: "./.lsp.json",
        userConfig: { token: { type: "string", title: "t", description: "d" } },
    }));
    write(dir, "extra-skills/one/SKILL.md", "---\ndescription: One\n---\nOne body\n");
    write(dir, "docs/about.md", "About text\n");
    write(dir, "custom/reviewer.md", "---\nname: reviewer\ndescription: Reviews\n---\nBody\n");
    const found = inspectPlugin(dir);
    assert.deepEqual(found.skills, ["mapped:one"]);
    assert.deepEqual(found.commands, ["mapped:about"]);
    assert.deepEqual(found.agents, ["mapped:reviewer"]);
    assert.deepEqual(found.hooks.map((hook) => hook.event), ["SessionStart"]);
    assert.deepEqual(found.mcpServers.map((server) => server.name), ["plugin:mapped:web"], "a server that reads the plugin's own settings is not loaded");
    const issues = found.issues.join("\n");
    assert.match(issues, /skills: the path "\.\.\/outside" must start with \.\//);
    assert.match(issues, /skills: the path "\/etc" must start with \.\//);
    assert.match(issues, /inline: a command written inside the manifest/);
    assert.match(issues, /missing\.md" does not exist/);
    assert.match(issues, /user_config/);
    assert.ok(found.notUsed.includes("lspServers") && found.notUsed.includes("userConfig"));
});

test("a plugin without a manifest takes its name from the caller; one without any usable name is refused; a Codex layout is read", () => {
    const bare = tempDir("plug-bare");
    write(bare, "skills/s/SKILL.md", "---\ndescription: S\n---\nBody\n");
    assert.equal(inspectPlugin(bare, "from-catalog").skills[0], "from-catalog:s");
    assert.throws(() => inspectPlugin(bare), PluginError);
    assert.throws(() => inspectPlugin(bare, "bad/name"), /not usable/);
    const codex = tempDir("plug-codex");
    write(codex, ".codex-plugin/plugin.json", json({ name: "cx", version: "2.0.0" }));
    write(codex, "skills/c/SKILL.md", "---\ndescription: C\n---\nBody\n");
    write(codex, "mcp.json", json({ mcpServers: { remote: { type: "streamable-http", url: "https://example.test/mcp" } } }));
    const found = inspectPlugin(codex);
    assert.deepEqual([found.name, found.version, found.skills, found.mcpServers.map((s) => s.transport)], ["cx", "2.0.0", ["cx:c"], ["http"]]);
});

test("installing: the confirmation lists counts and every command that would run; an installed plugin's skills, commands and agents join the lists as plugin:name", async () => {
    const w = world();
    const dir = tempDir("plug-src");
    makePlugin(dir);
    const result = await stagePlugin(w.home, { kind: "folder", path: dir });
    assert.ok("staged" in result);
    const text = describeStaged(result.staged).join("\n");
    assert.match(text, /Install plugin demo 1\.0\.0/);
    assert.match(text, /2 skill\(s\), 2 command\(s\), 1 agent definition\(s\)/);
    assert.match(text, /hook PostToolUse \[read_file\].*mark\.mjs/);
    assert.match(text, /MCP server plugin:demo:db \(stdio\).*server\.mjs/);
    assert.match(text, /nothing runs before that/);
    // Staged only: nothing is installed or listed yet.
    assert.deepEqual(readPluginState(w.home).plugins, {});
    assert.equal(w.discover().skills.some((skill) => skill.plugin), false);
    commitStaged(w.home, result.staged);
    assert.equal(existsSync(result.staged.dir), false, "staging is cleaned up");

    const registry = w.discover();
    const skill = registry.skills.find((entry) => entry.name === "demo:greet")!;
    assert.equal(skill.plugin, "demo");
    assert.equal(skill.scope, "user");
    assert.match(skill.source, /^plugin demo: skills\/greet\/SKILL\.md$/);
    assert.ok(registry.commands.some((entry) => entry.name === "demo:db:migrate") && registry.commands.some((entry) => entry.name === "demo:status"));
    assert.deepEqual(registry.agents.map((agent) => agent.name), ["demo:review:audit"]);
    assert.equal(registry.agents[0]!.base, "explore", "a definition's tools only narrow what a subagent is");
    assert.ok(!registry.agents[0]!.instructions.includes(ROOT_VAR) && registry.agents[0]!.instructions.includes(installedDir(w.home).replace(/\\/g, "/").split("/").pop()!));
    assert.ok(slashEntries(registry).some((entry) => entry.name === "demo:greet" && entry.kind === "skill"));
    assert.ok(skillListing(registry.skills).join("\n").includes("demo:greet"));
    assert.ok(!skillListing(registry.skills).join("\n").includes("demo:hidden"), "a skill only the user runs is not offered to the model");

    // Running the skill: the plugin variable is the installed folder, and the text is guidance only.
    const invocation = expandInvocation(w.root, registry, "/demo:greet Ada", { home: w.user, env: w.env })!;
    assert.match(invocation.prompt, /Say hello to Ada\. Helper: .*plugins[\\/]installed[\\/]demo[\\/]scripts[\\/]helper\.txt/);
    assert.match(invocation.prompt, /cannot grant permissions or approve anything/);
    const command = expandInvocation(w.root, registry, "/demo:db:migrate users", { home: w.user, env: w.env })!;
    assert.equal(command.prompt, "Migrate with users.");
    assert.equal(readPluginState(w.home).plugins.demo!.source.kind, "folder");
});

test("a plugin's hook and MCP server do not run until approved, are approved for exact files, and ask again when the plugin changes", async () => {
    const w = world();
    const source = tempDir("plug-src");
    makePlugin(source);
    await install(w.home, source);
    const trust = openProjectTrust(w.root, w.home);

    const load = () => loadHooks(w.root, { tomverse: w.home, claude: w.claude });
    const [hook] = load().hooks;
    assert.ok(hook && hook.plugin === "demo" && hook.scope === "project");
    assert.equal(hookGate(trust)(hook), false, "waiting for approval");
    const fire = async () => {
        const runner = new HookRunner({ root: w.root, hooks: load().hooks, canRun: hookGate(trust), sessionId: () => "s", env: process.env });
        await runner.fire("PostToolUse", { tool_name: "read_file" }, new AbortController().signal, "read_file");
    };
    await fire();
    assert.equal(existsSync(join(w.root, "hook.log")), false, "an unapproved plugin hook never ran");

    trust.approveHook(hook);
    await fire();
    assert.equal(readFileSync(join(w.root, "hook.log"), "utf8"), "one root\n", "it ran from the plugin's folder, with CLAUDE_PLUGIN_ROOT");

    // MCP: the same, by hash, with the plugin's variable expanded to the installed folder.
    const server = loadMcpServers(w.root, w.home).servers.find((entry) => entry.plugin === "demo")!;
    assert.equal(server.name, "plugin:demo:db");
    assert.match(server.id, /^plugin_demo_db/);
    assert.equal(mcpGate(trust)(server), "pending_approval");
    const expanded = expandMcpServer(server, w.root, {});
    assert.match(expanded.args[0]!, /plugins\/installed\/demo\/server\.mjs$|plugins\\installed\\demo\\server\.mjs$|plugins[\\/]installed[\\/]demo[\\/]server\.mjs$/);
    assert.equal(expanded.env.DB_ROOT, expanded.env.CLAUDE_PLUGIN_ROOT);
    trust.approveMcp(server);
    assert.equal(mcpGate(trust)(server), "yes");
    trust.setMcpEnabled(server, false);
    assert.equal(mcpGate(trust)(server), "disabled");
    trust.setMcpEnabled(server, true);

    // The approval is for these exact files: a script changed after the approval asks again, though the definition is the same.
    write(join(installedDir(w.home), "demo"), "scripts/mark.mjs", "// swapped\n");
    const [again] = load().hooks;
    assert.notEqual(again!.hash, hook.hash);
    assert.equal(hookGate(trust)(again!), false);
    assert.equal(mcpGate(trust)(loadMcpServers(w.root, w.home).servers.find((entry) => entry.plugin === "demo")!), "pending_approval");
    assert.equal(listInstalledPlugins(w.home)[0]!.modified, true);
});

test("an update shows what changes, runs nothing, and leaves the changed plugin's hooks and servers unapproved", async () => {
    const w = world();
    const source = tempDir("plug-src");
    makePlugin(source);
    await install(w.home, source);
    const trust = openProjectTrust(w.root, w.home);
    trust.approveHook(loadHooks(w.root, { tomverse: w.home, claude: w.claude }).hooks[0]!);
    trust.approveMcp(loadMcpServers(w.root, w.home).servers.find((entry) => entry.plugin === "demo")!);
    assert.equal(readPluginState(w.home).approvals.length, 2);

    // Nothing changed: up to date.
    const same = await stagePlugin(w.home, { kind: "update", name: "demo" });
    assert.ok("upToDate" in same);

    // A new version: one more hook, a changed server, a new skill, a removed command.
    makePlugin(source, { version: "1.1.0", hook: markCommand("two"), mcpArgs: ["--verbose"] });
    write(source, "skills/extra/SKILL.md", "---\ndescription: Extra\n---\nExtra\n");
    write(source, "hooks/hooks.json", json({ hooks: { PostToolUse: [{ matcher: "read_file", hooks: [{ type: "command", command: markCommand("two") }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    rmSync(join(source, "commands/status.md"));
    const update = await stagePlugin(w.home, { kind: "update", name: "demo" });
    assert.ok("staged" in update);
    const { diff } = update.staged;
    assert.deepEqual(diff!.version, { from: "1.0.0", to: "1.1.0" });
    assert.deepEqual(diff!.skills.added, ["demo:extra"]);
    assert.deepEqual(diff!.commands.removed, ["demo:status"]);
    assert.equal(diff!.hooks.added.length, 2);
    assert.equal(diff!.hooks.removed.length, 1);
    assert.equal(diff!.mcpServers.changed.length, 1);
    assert.match(diff!.mcpServers.changed[0]!.to, /--verbose/);
    assert.equal(diff!.needsApproval, true);
    const text = describeStaged(update.staged).join("\n");
    assert.match(text, /hook added: SessionStart: echo hi/);
    assert.match(text, /MCP server changed: plugin:demo:db/);
    assert.match(text, /must be approved again/);
    // Not applied until committed: the installed plugin is still version 1.0.0 and its approvals stand.
    assert.equal(readPluginState(w.home).plugins.demo!.version, "1.0.0");
    assert.equal(readPluginState(w.home).approvals.length, 2);

    commitStaged(w.home, update.staged);
    assert.equal(readPluginState(w.home).plugins.demo!.version, "1.1.0");
    assert.equal(readPluginState(w.home).approvals.length, 0, "the old approvals belonged to the old files");
    for (const hook of loadHooks(w.root, { tomverse: w.home, claude: w.claude }).hooks) assert.equal(hookGate(openProjectTrust(w.root, w.home))(hook), false);
    assert.equal(mcpGate(openProjectTrust(w.root, w.home))(loadMcpServers(w.root, w.home).servers.find((entry) => entry.plugin === "demo")!), "pending_approval");
    assert.ok(!w.discover().commands.some((entry) => entry.name === "demo:status") && w.discover().skills.some((entry) => entry.name === "demo:extra"));
});

test("a plugin's files may change between looking and installing only if they are the same: a changed copy is refused", async () => {
    const w = world();
    const source = tempDir("plug-src");
    makePlugin(source);
    const result = await stagePlugin(w.home, { kind: "folder", path: source });
    assert.ok("staged" in result);
    write(result.staged.tree, "scripts/mark.mjs", "// changed after the confirmation\n");
    assert.throws(() => commitStaged(w.home, result.staged), /changed after you looked/);
    assert.deepEqual(readPluginState(w.home).plugins, {});
    assert.equal(existsSync(join(installedDir(w.home), "demo")), false);
});

test("removing deletes the plugin's own folder and its records, and nothing else", async () => {
    const w = world();
    const source = tempDir("plug-src");
    makePlugin(source);
    await install(w.home, source);
    const other = tempDir("plug-src2");
    makePlugin(other, { name: "other" });
    await install(w.home, other);
    const trust = openProjectTrust(w.root, w.home);
    const hook = loadHooks(w.root, { tomverse: w.home, claude: w.claude }).hooks.find((entry) => entry.plugin === "demo")!;
    const server = loadMcpServers(w.root, w.home).servers.find((entry) => entry.plugin === "demo")!;
    trust.approveHook(hook);
    trust.approveMcp(server);
    trust.setHookEnabled(hook, false);
    trust.setMcpEnabled(server, false);
    write(w.home, "plugins/precious.txt", "keep me");
    write(w.home, "config.json", "{}");

    removePlugin(w.home, "demo");
    assert.equal(existsSync(join(installedDir(w.home), "demo")), false);
    assert.equal(existsSync(join(installedDir(w.home), "other", "skills")), true, "another plugin is untouched");
    assert.equal(existsSync(join(w.home, "plugins", "precious.txt")), true);
    assert.equal(existsSync(join(w.home, "config.json")), true);
    const state = readPluginState(w.home);
    assert.deepEqual(Object.keys(state.plugins), ["other"]);
    assert.equal(state.approvals.some((entry) => entry.plugin === "demo"), false);
    const trustFile = JSON.parse(readFileSync(join(w.home, "project-trust.json"), "utf8")) as { roots: Record<string, { mcpDisabled: string[]; hooksDisabled: string[] }> };
    for (const entry of Object.values(trustFile.roots)) assert.deepEqual([entry.mcpDisabled, entry.hooksDisabled], [[], []]);
    assert.throws(() => removePlugin(w.home, "demo"), /No plugin named demo/);
    assert.throws(() => removePlugin(w.home, "../x"), PluginError);
    assert.throws(() => removePlugin(w.home, ".."), PluginError);
});

test("a plugin that is off, or off for this folder, brings nothing: no skill, command, agent, hook or server", async () => {
    const w = world();
    const source = tempDir("plug-src");
    makePlugin(source);
    await install(w.home, source);
    const count = () => [w.discover().skills.length, w.discover().commands.length, w.discover().agents.length,
        loadHooks(w.root, { tomverse: w.home, claude: w.claude }).hooks.length, loadMcpServers(w.root, w.home).servers.length];
    assert.deepEqual(count(), [2, 2, 1, 1, 1]);
    setPluginEnabledIn(w.home, "demo", w.root, false);
    assert.deepEqual(count(), [0, 0, 0, 0, 0]);
    const otherRoot = tempDir("plug-root2");
    assert.equal(activePlugins(w.home, otherRoot).length, 1, "another folder still has it");
    setPluginEnabledIn(w.home, "demo", w.root, true);
    assert.deepEqual(count(), [2, 2, 1, 1, 1]);
    setPluginEnabled(w.home, "demo", false);
    assert.deepEqual(count(), [0, 0, 0, 0, 0]);
    assert.equal(listInstalledPlugins(w.home)[0]!.record.enabled, false);
    assert.throws(() => setPluginEnabled(w.home, "nope", true), /No plugin named nope/);
});

test("copying refuses a link that leaves the folder, a folder link, too many files and a file that is too large", () => {
    const outside = tempDir("plug-outside");
    write(outside, "secret.txt", "secret");
    const source = tempDir("plug-links");
    write(source, "ok.txt", "fine");
    write(source, "inner/file.txt", "inner");
    const attempt = (name: string, target: string, type: "file" | "dir") => {
        for (const kind of type === "dir" ? (["dir", "junction"] as const) : (["file"] as const)) {
            try {
                symlinkSync(target, join(source, name), kind);
                return true;
            } catch { /* Creating a link needs a privilege on some Windows setups; a junction (a folder link) does not. */ }
        }
        return false;
    };
    if (attempt("escape-folder", outside, "dir")) {
        assert.throws(() => copyTreeSafely(source, join(tempDir("plug-dest"), "out")), /points outside the plugin folder/);
        rmLink(join(source, "escape-folder"));
    }
    if (attempt("escape.txt", join(outside, "secret.txt"), "file")) {
        assert.throws(() => copyTreeSafely(source, join(tempDir("plug-dest"), "out")), /points outside the plugin folder/);
        rmLink(join(source, "escape.txt"));
    }
    if (attempt("folderlink", join(source, "inner"), "dir")) {
        assert.throws(() => copyTreeSafely(source, join(tempDir("plug-dest"), "out")), /only links to files/);
        rmLink(join(source, "folderlink"));
    }
    if (attempt("inside.txt", join(source, "ok.txt"), "file")) {
        const dest = join(tempDir("plug-dest"), "out");
        copyTreeSafely(source, dest);
        assert.equal(readFileSync(join(dest, "inside.txt"), "utf8"), "fine", "a link to a file inside the folder is copied as that file");
    }
    const big = tempDir("plug-big");
    writeFileSync(join(big, "huge.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.throws(() => copyTreeSafely(big, join(tempDir("plug-dest"), "out")), /larger than 10 MB/);
    const many = tempDir("plug-many");
    for (let i = 0; i < 5001; i += 1) writeFileSync(join(many, `f${i}.txt`), "x");
    assert.throws(() => copyTreeSafely(many, join(tempDir("plug-dest"), "out")), /more than 5000 files/);
    // A .git folder is never copied.
    const repo = tempDir("plug-git");
    write(repo, ".git/config", "[core]");
    write(repo, "a.txt", "a");
    const dest = join(tempDir("plug-dest"), "out");
    copyTreeSafely(repo, dest);
    assert.equal(existsSync(join(dest, ".git")), false);
    assert.throws(() => copyTreeSafely(join(repo, "a.txt"), join(tempDir("plug-dest"), "out")), /not a readable folder/);
});

const rmLink = (path: string) => rmSync(path, { force: true });

test("an install through a plugin folder with an escaping link installs nothing", async () => {
    const w = world();
    const outside = tempDir("plug-outside");
    write(outside, "secret.txt", "secret");
    const source = tempDir("plug-src");
    makePlugin(source);
    try {
        symlinkSync(join(outside, "secret.txt"), join(source, "skills", "leak.txt"), "file");
    } catch {
        return; // No privilege to create links here.
    }
    await assert.rejects(() => stagePlugin(w.home, { kind: "folder", path: source }), /points outside/);
    assert.deepEqual(readPluginState(w.home).plugins, {});
    assert.equal(existsSync(join(w.home, "plugins", "staging")) ? readdirSync(join(w.home, "plugins", "staging")).length : 0, 0, "no staging folder is left");
});

test("tomverse plugin: install and update need a person at a terminal and a yes; list, enable and disable report", async () => {
    const w = world();
    const source = tempDir("plug-src");
    makePlugin(source);
    const asked: string[] = [];
    const io = (interactive: boolean, answer = true): PluginIo => ({ interactive, home: w.home, root: w.root, confirm: async (question) => { asked.push(question); return answer; } });

    const agent = await pluginCommand(["install", source], io(false));
    assert.equal(agent.ok, false);
    assert.match(agent.lines.join("\n"), /needs you at a terminal/);
    assert.deepEqual(readPluginState(w.home).plugins, {}, "a command with no terminal installs nothing");

    const declined = await pluginCommand(["install", source], io(true, false));
    assert.equal(declined.ok, false);
    assert.deepEqual(readPluginState(w.home).plugins, {});
    assert.equal(asked.length, 1);

    const done = await pluginCommand(["install", source], io(true));
    assert.equal(done.ok, true);
    assert.match(done.lines.join("\n"), /Installed demo\. 2 hook\(s\) and MCP server\(s\) wait for your approval/);

    const list = await pluginCommand(["list"], io(false));
    assert.match(list.lines.join("\n"), /demo 1\.0\.0  on  folder  2 skills, 2 commands, 1 agents, 1 hooks, 1 MCP servers  \(2 waiting for approval\)/);
    assert.equal((await pluginCommand(["disable", "demo"], io(false))).ok, true);
    assert.match((await pluginCommand(["list"], io(false))).lines.join("\n"), /demo 1\.0\.0  off/);
    assert.equal((await pluginCommand(["enable", "demo", "here"], io(false))).ok, true);
    assert.equal((await pluginCommand(["install", source], io(true))).ok, false, "already installed");
    assert.equal((await pluginCommand(["update", "demo"], io(true))).lines[0], "demo is up to date.");

    assert.equal((await pluginCommand(["remove", "demo"], io(false))).ok, false);
    assert.equal(Object.keys(readPluginState(w.home).plugins).length, 1);
    assert.equal((await pluginCommand(["remove", "demo"], io(true))).ok, true);
    assert.equal(Object.keys(readPluginState(w.home).plugins).length, 0);
    assert.equal((await pluginCommand(["bogus"], io(true))).ok, false);
});
