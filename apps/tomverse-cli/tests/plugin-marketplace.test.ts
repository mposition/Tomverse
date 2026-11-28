import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { PluginError } from "../src/plugin-fs.js";
import { pluginCommand, type PluginIo } from "../src/plugin-cli.js";
import { checkGitUrl, fetchGitSnapshot } from "../src/plugin-git.js";
import { commitStaged, describeStaged, stagePlugin } from "../src/plugin-manager.js";
import {
    addMarketplace, classifyMarketplaceInput, listMarketplaces, readCatalog, readMarketplace, refreshMarketplace, removeMarketplace,
} from "../src/plugin-marketplace.js";
import { readPluginState } from "../src/plugin-store.js";
import { tempDir } from "./helpers.js";

const write = (root: string, path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
};
const json = (value: unknown) => JSON.stringify(value);

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

/** A working repository and a bare copy of it standing in for a remote: the only "network" these tests use. */
const repository = (files: Record<string, string>) => {
    const work = tempDir("mk-work");
    git(work, "init", "-q", "-b", "main");
    for (const [path, text] of Object.entries(files)) write(work, path, text);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "first");
    const bare = join(tempDir("mk-bare"), "remote.git");
    git(work, "clone", "-q", "--bare", work, bare);
    const push = (message: string) => {
        git(work, "add", "-A");
        git(work, "commit", "-q", "-m", message);
        git(work, "push", "-q", bare, "main");
        return git(work, "rev-parse", "HEAD");
    };
    return { work, bare, head: () => git(work, "rev-parse", "HEAD"), push };
};

const hookCommand = (label: string) => `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "\${CLAUDE_PLUGIN_ROOT}/mark.mjs" ${label}`;
const pluginFiles = (prefix: string, version: string, label: string) => ({
    [`${prefix}.claude-plugin/plugin.json`]: json({ name: "demo", version }),
    [`${prefix}skills/greet/SKILL.md`]: `---\ndescription: Greet ${label}\n---\nHello ${label}\n`,
    [`${prefix}hooks/hooks.json`]: json({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand(label) }] }] } }),
    [`${prefix}mark.mjs`]: `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.MARKER ?? "marker-should-not-exist.txt", "ran");\n`,
});

const catalogFile = (plugins: unknown[], extra: Record<string, unknown> = {}) => json({ name: "acme", owner: { name: "Acme" }, plugins, ...extra });

const io = (home: string, root: string, answer = true): PluginIo => ({ interactive: true, home, root, confirm: async () => answer });

test("a catalog is read as documented: relative paths, pluginRoot names, github, url and git-subdir sources, Codex local; bad or unsupported entries are reported", () => {
    const dir = tempDir("mk-catalog");
    write(dir, ".claude-plugin/marketplace.json", catalogFile([
        { name: "inside", source: "./plugins/inside", description: "In the repo", version: "1.2.3" },
        { name: "bare", source: "other" },
        { name: "gh", source: { source: "github", repo: "acme/gh", ref: "v1", sha: "a".repeat(40) } },
        { name: "remote", source: { source: "url", url: "https://git.example.test/acme/remote.git" } },
        { name: "mono", source: { source: "git-subdir", url: "acme/mono", path: "tools/mono" } },
        { name: "codex", source: { source: "local", path: "./plugins/codex" } },
        { name: "npmy", source: { source: "npm", package: "x" } },
        { name: "pipy", source: { source: "pip", package: "x" } },
        { name: "escape", source: "./../outside" },
        { name: "bad name", source: "./x" },
        { name: "inside", source: "./dupe" },
        { source: "./no-name" },
        { name: "badsha", source: { source: "github", repo: "acme/x", sha: "short" } },
    ], { metadata: { pluginRoot: "./plugins" } }));
    const catalog = readCatalog(dir);
    assert.equal(catalog.name, "acme");
    assert.equal(catalog.owner, "Acme");
    const bySource = Object.fromEntries(catalog.entries.map((entry) => [entry.name, entry.source]));
    assert.deepEqual(bySource.inside, { kind: "relative", path: "plugins/inside" });
    assert.deepEqual(bySource.bare, { kind: "relative", path: "plugins/other" });
    assert.deepEqual(bySource.gh, { kind: "git", url: "https://github.com/acme/gh.git", ref: "v1", sha: "a".repeat(40) });
    assert.deepEqual(bySource.remote, { kind: "git", url: "https://git.example.test/acme/remote.git" });
    assert.deepEqual(bySource.mono, { kind: "git", url: "https://github.com/acme/mono.git", subdir: "tools/mono" });
    assert.deepEqual(bySource.codex, { kind: "relative", path: "plugins/codex" });
    assert.deepEqual(bySource.npmy, { kind: "npm", package: "x" });
    assert.deepEqual(bySource.pipy, { kind: "unsupported", type: "pip" });
    assert.equal(bySource.escape?.kind, "unsupported");
    assert.equal(bySource.badsha?.kind, "unsupported");
    assert.equal(catalog.entries.some((entry) => entry.name === "bad name"), false);
    assert.equal(catalog.entries.filter((entry) => entry.name === "inside").length, 1);
    assert.ok(catalog.issues.length >= 4);
    assert.throws(() => readCatalog(tempDir("mk-empty")), /no \.claude-plugin\/marketplace\.json/);
    const codexDir = tempDir("mk-codex");
    write(codexDir, ".agents/plugins/marketplace.json", catalogFile([{ name: "p", source: { source: "local", path: "./plugins/p" } }]));
    assert.equal(readCatalog(codexDir).entries[0]!.name, "p");
});

test("git addresses: https, ssh, file and local folders pass; options, helpers and passwords do not", () => {
    assert.equal(checkGitUrl("https://github.com/acme/x.git").protocol, "https");
    assert.equal(checkGitUrl("git@github.com:acme/x.git").protocol, "ssh");
    assert.equal(checkGitUrl("ssh://git@host/acme/x.git").protocol, "ssh");
    assert.equal(checkGitUrl(tempDir("mk-local")).protocol, "file");
    for (const bad of ["--upload-pack=calc", "ext::sh -c id", "https://user:secret@host/x.git", "http://host/x.git", "ftp://host/x", "relative/path", "https://host/a b", ""]) {
        assert.throws(() => checkGitUrl(bad), PluginError, bad);
    }
});

test("adding a git marketplace downloads one commit (pinned), runs nothing, and installing from it is a separate confirmed step", async () => {
    const remote = repository({
        ".claude-plugin/marketplace.json": catalogFile([{ name: "demo", source: "./plugins/demo", version: "1.0.0" }, { name: "far", source: { source: "npm", package: "x" } }]),
        ...pluginFiles("plugins/demo/", "1.0.0", "one"),
    });
    const home = tempDir("mk-home");
    const root = tempDir("mk-root");
    const marker = join(root, "marker.txt");
    process.env.MARKER = marker;
    try {
        const added = await addMarketplace(home, classifyMarketplaceInput(remote.bare));
        assert.equal(added.name, "acme");
        assert.equal(added.commit, remote.head(), "the fetched commit is recorded");
        assert.equal(readPluginState(home).marketplaces.acme!.commit, remote.head());
        assert.equal(existsSync(join(home, "plugins", "marketplaces", "acme", ".git")), false, "no git metadata is kept");
        assert.equal(existsSync(join(home, "plugins", "marketplaces", "acme", "plugins", "demo", "mark.mjs")), true);
        assert.deepEqual(listMarketplaces(home).map((entry) => [entry.name, entry.catalog?.entries.length]), [["acme", 2]]);
        assert.deepEqual(readdirSync(join(home, "plugins", "staging")), [], "staging is empty afterwards");
        assert.equal(existsSync(marker), false, "downloading ran nothing");
        await assert.rejects(() => addMarketplace(home, classifyMarketplaceInput(remote.bare)), /already added/);

        // Install from the catalog: staged, confirmed, committed; the hook still has not run.
        const staged = await stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "demo" });
        assert.ok("staged" in staged);
        assert.match(describeStaged(staged.staged).join("\n"), /hook SessionStart.*mark\.mjs.* one/);
        commitStaged(home, staged.staged);
        assert.deepEqual(readPluginState(home).plugins.demo!.source, { kind: "marketplace", marketplace: "acme", plugin: "demo", commit: remote.head() });
        assert.equal(existsSync(marker), false, "installing ran nothing");
        await assert.rejects(() => stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "far" }), /does not support \(npm\)/);
        await assert.rejects(() => stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "missing" }), /has no plugin named missing/);

        // The remote moves on. Nothing changes until the person refreshes, and then updates, each on purpose.
        const before = remote.head();
        write(remote.work, "plugins/demo/.claude-plugin/plugin.json", json({ name: "demo", version: "2.0.0" }));
        write(remote.work, "plugins/demo/skills/greet/SKILL.md", "---\ndescription: Greet two\n---\nHello two\n");
        write(remote.work, "plugins/demo/hooks/hooks.json", json({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand("two") }] }] } }));
        const after = remote.push("second");
        assert.notEqual(before, after);
        assert.equal(readMarketplace(home, "acme").record.commit, before);
        const fresh = await stagePlugin(home, { kind: "update", name: "demo" });
        assert.ok("staged" in fresh, "an update refreshes the marketplace it came from");
        assert.equal(fresh.staged.diff!.version.to, "2.0.0");
        assert.equal(fresh.staged.diff!.hooks.added.length, 1);
        assert.equal(fresh.staged.diff!.hooks.removed.length, 1);
        assert.equal(fresh.staged.diff!.needsApproval, true);
        assert.equal(readPluginState(home).plugins.demo!.version, "1.0.0", "not applied before the confirmation");
        commitStaged(home, fresh.staged);
        assert.equal(readPluginState(home).plugins.demo!.version, "2.0.0");
        assert.equal(readPluginState(home).marketplaces.acme!.commit, after);
        assert.equal(existsSync(marker), false);

        // Removing the marketplace leaves the installed plugin alone.
        removeMarketplace(home, "acme");
        assert.deepEqual(listMarketplaces(home), []);
        assert.equal(existsSync(join(home, "plugins", "marketplaces", "acme")), false);
        assert.ok(readPluginState(home).plugins.demo);
        await assert.rejects(() => stagePlugin(home, { kind: "update", name: "demo", }), /No marketplace named acme/);
    } finally {
        delete process.env.MARKER;
    }
});

test("a catalog entry that points at another git repository (url, ref, subdir, pinned sha) is fetched when installing, and a wrong pin is refused", async () => {
    const plugin = repository({ "tools/inner/.claude-plugin/plugin.json": json({ name: "inner" }), "tools/inner/skills/s/SKILL.md": "---\ndescription: S\n---\nS\n" });
    const pinned = plugin.head();
    write(plugin.work, "later.txt", "later");
    plugin.push("later");
    const market = repository({
        ".claude-plugin/marketplace.json": catalogFile([
            { name: "inner", source: { source: "git-subdir", url: plugin.bare, path: "tools/inner", sha: pinned } },
            { name: "wrong", source: { source: "git-subdir", url: plugin.bare, path: "tools/inner", sha: "b".repeat(40) } },
        ]),
    });
    const home = tempDir("mk-home");
    await addMarketplace(home, classifyMarketplaceInput(market.bare));
    const staged = await stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "inner" });
    assert.ok("staged" in staged);
    assert.equal(staged.staged.source.kind === "marketplace" && staged.staged.source.commit, pinned, "the pinned commit is what was fetched");
    assert.deepEqual(staged.staged.inspection.skills, ["inner:s"]);
    commitStaged(home, staged.staged);
    await assert.rejects(() => stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "wrong" }), /git failed|different commit/);
    assert.deepEqual(readdirSync(join(home, "plugins", "staging")), [], "a failed download leaves nothing behind");
});

test("a local folder marketplace is copied; refresh picks up changes; the plugin folder a catalog names cannot lead outside it", async () => {
    const folder = tempDir("mk-folder");
    write(folder, ".claude-plugin/marketplace.json", catalogFile([{ name: "demo", source: "./demo" }, { name: "up", source: "./../elsewhere" }]));
    for (const [path, text] of Object.entries(pluginFiles("demo/", "1.0.0", "one"))) write(folder, path, text);
    const home = tempDir("mk-home");
    const first = (await addMarketplace(home, classifyMarketplaceInput(folder))).catalog;
    assert.deepEqual(first.entries.map((entry) => [entry.name, entry.source.kind]), [["demo", "relative"], ["up", "unsupported"]], "an entry that leaves the marketplace cannot be installed");
    assert.deepEqual(readPluginState(home).marketplaces.acme!.source, { kind: "directory", path: folder });
    write(folder, ".claude-plugin/marketplace.json", catalogFile([{ name: "demo", source: "./demo" }, { name: "second", source: "./demo" }]));
    assert.equal((await refreshMarketplace(home, "acme")).catalog.entries.length, 2);
    write(folder, ".claude-plugin/marketplace.json", json({ name: "renamed", plugins: [] }));
    await assert.rejects(() => refreshMarketplace(home, "acme"), /now calls itself renamed/);
    assert.throws(() => classifyMarketplaceInput(tempDir("mk-nothing")), /no \.claude-plugin\/marketplace\.json/);
    assert.throws(() => removeMarketplace(home, "nope"), /No marketplace named nope/);
    assert.throws(() => removeMarketplace(home, "../x"), PluginError);
});

test("fetching refuses a pinned commit the repository does not give, and keeps no .git", async () => {
    const remote = repository({ "a.txt": "a" });
    const dest = join(tempDir("mk-dest"), "out");
    const { commit } = await fetchGitSnapshot({ url: remote.bare }, dest);
    assert.equal(commit, remote.head());
    assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "a");
    assert.equal(existsSync(join(dest, ".git")), false);
    await assert.rejects(() => fetchGitSnapshot({ url: remote.bare, sha: "c".repeat(40) }, join(tempDir("mk-dest"), "out")), PluginError);
    await assert.rejects(() => fetchGitSnapshot({ url: remote.bare, ref: "--upload-pack=x" }, join(tempDir("mk-dest"), "out")), /not usable/);
});

test("tomverse plugin marketplace: add, list, show, update and remove; none is built in; each download needs a terminal and a yes", async () => {
    const remote = repository({ ".claude-plugin/marketplace.json": catalogFile([{ name: "demo", source: "./demo", description: "A demo" }]), ...pluginFiles("demo/", "1.0.0", "one") });
    const home = tempDir("mk-home");
    const root = tempDir("mk-root");
    assert.match((await pluginCommand(["marketplace", "list"], io(home, root))).lines.join("\n"), /none is built in/);
    const noTerminal = await pluginCommand(["marketplace", "add", remote.bare], { ...io(home, root), interactive: false });
    assert.equal(noTerminal.ok, false);
    assert.equal((await pluginCommand(["marketplace", "add", remote.bare], io(home, root, false))).ok, false);
    assert.deepEqual(listMarketplaces(home), []);
    const added = await pluginCommand(["marketplace", "add", remote.bare], io(home, root));
    assert.equal(added.ok, true, added.lines.join("\n"));
    assert.match(added.lines[0]!, /Added the marketplace acme with 1 plugin\(s\) at [0-9a-f]{12}/);
    assert.match((await pluginCommand(["marketplace", "list"], io(home, root))).lines.join("\n"), /acme {2}1 plugin\(s\)/);
    assert.match((await pluginCommand(["marketplace", "show", "acme"], io(home, root))).lines.join("\n"), /demo {2}A demo/);
    const install = await pluginCommand(["install", "demo@acme"], io(home, root));
    assert.equal(install.ok, true, install.lines.join("\n"));
    assert.match((await pluginCommand(["marketplace", "show", "acme"], io(home, root))).lines.join("\n"), /demo {2}\(installed\)/);
    assert.match((await pluginCommand(["list"], io(home, root, false))).lines.join("\n"), /demo@acme/);
    assert.equal((await pluginCommand(["marketplace", "update", "acme"], io(home, root))).ok, true);
    assert.equal((await pluginCommand(["marketplace", "remove", "acme"], io(home, root))).ok, true);
    assert.equal((await pluginCommand(["install", "demo@acme"], io(home, root))).ok, false, "the marketplace is gone");
});
