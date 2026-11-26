import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyImport, collectImport, maskArgs, maskValue, normalizeClaudeServer, normalizeCodexServer } from "../src/extension-import.js";
import { tempDir } from "./helpers.js";

const SECRET = "sk-live-0123456789abcdef";
const HEADER_SECRET = "hdr-secret-value-987";

const write = (root: string, path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
};

const setup = () => {
    const root = tempDir("imp-proj");
    const home = tempDir("imp-home");
    const tv = tempDir("imp-tv");
    write(root, "AGENTS.md", "Project rules\n");
    write(root, "CLAUDE.md", "@AGENTS.md\n");
    write(root, ".claude/skills/review/SKILL.md", "---\ndescription: Review\nallowed-tools: Bash\n---\nReview it\n");
    write(root, ".mcp.json", JSON.stringify({ mcpServers: { shared: { command: "node", args: ["server.js"], env: { TOKEN: SECRET } } } }));
    write(home, ".claude.json", JSON.stringify({
        mcpServers: {
            notes: { command: "npx", args: ["-y", "notes-mcp", `--api-key=${SECRET}`], env: { API_KEY: SECRET, REGION: "${REGION}" }, timeout: 5 },
            remote: { type: "http", url: `https://mcp.example.com/mcp?token=${SECRET}`, headers: { Authorization: `Bearer ${HEADER_SECRET}` }, headersHelper: "get-token.sh" },
            events: { type: "sse", url: "https://mcp.example.com/sse" },
            "__proto__": { command: "evil" },
        },
        projects: { [root.replaceAll("\\", "/")]: { mcpServers: { local: { command: "python", args: ["srv.py"] } } }, "/somewhere/else": { mcpServers: { other: { command: "x" } } } },
    }));
    write(home, ".codex/config.toml", [
        "[mcp_servers.context7]", 'command = "npx"', 'args = ["-y", "@upstash/context7-mcp"]', 'env_vars = ["LOCAL_TOKEN"]', "[mcp_servers.context7.env]", `MY_ENV_VAR = "${SECRET}"`,
        "[mcp_servers.figma]", 'url = "https://mcp.figma.com/mcp"', 'bearer_token_env_var = "FIGMA_OAUTH_TOKEN"', 'http_headers = { "X-Figma-Region" = "us-east-1" }', 'startup_timeout_sec = 20',
        "[mcp_servers.off]", 'command = "x"', "enabled = false",
    ].join("\n"));
    return { root, home, tv, options: { home, env: {}, tomverseHome: tv } };
};

test("the preview lists what is already used and what can be copied, with every secret hidden", () => {
    const { root, options } = setup();
    const { items } = collectImport(root, options);
    const byName = (name: string) => items.find((item) => item.name === name)!;
    assert.equal(byName("AGENTS.md").status, "in-use");
    assert.equal(byName("CLAUDE.md").status, "in-use");
    assert.equal(byName("review").status, "in-use");
    assert.match(byName("review").detail!, /allowed-tools/);
    const shared = byName("shared");
    assert.deepEqual([shared.scope, shared.status, shared.source], ["project", "in-use", ".mcp.json"]);
    for (const name of ["notes", "remote", "local", "context7", "figma"]) assert.equal(byName(name).status, "importable", name);
    assert.equal(byName("local").source, "~/.claude.json (this project, local)");
    assert.ok(!items.some((item) => item.name === "other"), "another project's servers are not offered");
    assert.ok(!items.some((item) => item.name === "__proto__" && item.status === "importable"));
    assert.equal(byName("events").status, "unsupported");
    assert.match(byName("events").detail!, /sse transport/);
    assert.equal(byName("off").status, "unsupported");
    assert.match(byName("notes").detail!, /Not copied: timeout/);
    assert.match(byName("remote").detail!, /headersHelper/);
    assert.deepEqual(byName("notes").mcp!.values, [{ key: "API_KEY", value: "••••••" }, { key: "REGION", value: "${REGION}" }]);
    assert.match(byName("notes").mcp!.summary, /^npx -y notes-mcp --api-key=••••••$/);
    assert.equal(byName("remote").mcp!.summary, "https://mcp.example.com/mcp?token=••••••");
    assert.deepEqual(byName("remote").mcp!.values, [{ key: "Authorization", value: "••••••" }]);
    assert.deepEqual(byName("figma").mcp!.values, [{ key: "Authorization", value: "Bearer ${FIGMA_OAUTH_TOKEN}" }, { key: "X-Figma-Region", value: "••••••" }]);
    const shown = JSON.stringify(items);
    assert.ok(!shown.includes(SECRET) && !shown.includes(HEADER_SECRET), "no secret value is in the preview");
});

test("only the selected servers are written, in the shape of a project .mcp.json, with environment references kept as references", () => {
    const { root, options, tv } = setup();
    const { items } = collectImport(root, options);
    const id = (name: string) => items.find((item) => item.name === name)!.id;
    assert.deepEqual(applyImport(root, [], options).written, []);
    assert.equal(existsSync(join(tv, "mcp.json")), false, "nothing is written until something is selected");
    const result = applyImport(root, [id("notes"), id("context7"), id("figma"), id("events"), "i-doesnotexist"], options);
    assert.deepEqual(result.written.sort(), ["context7", "figma", "notes"]);
    assert.deepEqual(result.skipped.map((entry) => entry.id).sort(), [id("events"), "i-doesnotexist"].sort());
    const file = JSON.parse(readFileSync(join(tv, "mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(file.mcpServers).sort(), ["context7", "figma", "notes"], "remote and local were not selected");
    assert.deepEqual(file.mcpServers.notes, { command: "npx", args: ["-y", "notes-mcp", `--api-key=${SECRET}`], env: { API_KEY: SECRET, REGION: "${REGION}" } });
    assert.deepEqual(file.mcpServers.context7, { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { MY_ENV_VAR: SECRET, LOCAL_TOKEN: "${LOCAL_TOKEN}" } });
    assert.deepEqual(file.mcpServers.figma, { type: "http", url: "https://mcp.figma.com/mcp", headers: { "X-Figma-Region": "us-east-1", Authorization: "Bearer ${FIGMA_OAUTH_TOKEN}" } });
    if (process.platform !== "win32") assert.equal(statSync(join(tv, "mcp.json")).mode & 0o777, 0o600);
    // Seen again: already there, and a different server of the same name is never replaced.
    const again = collectImport(root, options).items;
    assert.equal(again.find((item) => item.name === "notes")!.status, "imported");
    assert.equal(again.find((item) => item.name === "remote")!.status, "importable");
    writeFileSync(join(tv, "mcp.json"), JSON.stringify({ extra: 1, mcpServers: { ...file.mcpServers, remote: { command: "mine" } } }));
    const conflict = collectImport(root, options).items.find((item) => item.name === "remote")!;
    assert.equal(conflict.status, "conflict");
    assert.equal(applyImport(root, [conflict.id], options).written.length, 0);
    const added = applyImport(root, [id("local")], options);
    assert.deepEqual(added.written, ["local"]);
    const merged = JSON.parse(readFileSync(join(tv, "mcp.json"), "utf8"));
    assert.equal(merged.extra, 1, "other content of the file is kept");
    assert.deepEqual(merged.mcpServers.remote, { command: "mine" });
});

test("an id from an earlier preview is refused once its source has changed, and an unreadable target file is left alone", () => {
    const { root, home, options, tv } = setup();
    const before = collectImport(root, options).items.find((item) => item.name === "notes")!.id;
    write(home, ".claude.json", JSON.stringify({ mcpServers: { notes: { command: "changed" } } }));
    assert.equal(applyImport(root, [before], options).written.length, 0);
    write(tv, "mcp.json", "{ not json");
    const item = collectImport(root, options).items.find((entry) => entry.name === "notes")!;
    assert.equal(item.status, "conflict");
    assert.match(item.detail!, /not valid JSON/);
    assert.equal(applyImport(root, [item.id], options).written.length, 0);
    assert.equal(readFileSync(join(tv, "mcp.json"), "utf8"), "{ not json");
});

test("servers that Tomverse cannot read are named, not guessed at", () => {
    assert.match(normalizeClaudeServer({ type: "ws", url: "wss://x" }).unsupported!, /ws transport/);
    assert.match(normalizeClaudeServer({ type: "http" }).unsupported!, /no url/);
    assert.match(normalizeClaudeServer({ command: "x", args: [1] }).unsupported!, /args/);
    assert.equal(normalizeClaudeServer({ type: "streamable-http", url: "https://x" }).server && "type" in normalizeClaudeServer({ type: "streamable-http", url: "https://x" }).server!, true);
    assert.match(normalizeCodexServer({ command: "x", enabled: false }).unsupported!, /turned off/);
    assert.deepEqual(normalizeCodexServer({ command: "x", cwd: "/tmp" }).dropped, ["cwd"]);
    assert.equal(maskValue("${TOKEN}"), "${TOKEN}");
    assert.equal(maskValue("plain"), "••••••");
    assert.deepEqual(maskArgs(["--token", "abc", "--name", "ok", "--secret=zzz", "--key=${K}"]), ["--token", "••••••", "--name", "ok", "--secret=••••••", "--key=${K}"]);
});
