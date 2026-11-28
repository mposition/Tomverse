import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { extensionsCommand } from "../src/extensions-cli.js";
import { loadMcpServers } from "../src/mcp-config.js";
import { mcpGate, openProjectTrust } from "../src/project-trust.js";
import { tempDir } from "./helpers.js";

const setup = () => {
    const home = tempDir("ext-home");
    const root = tempDir("ext-root");
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { command: "node", args: ["server.js"] } } }));
    return { home, root };
};

test("tomverse mcp lists the project's server as needing approval, and approving needs a person at a terminal", async () => {
    const { home, root } = setup();
    const listed = await extensionsCommand("mcp", ["list"], root, { interactive: false, confirm: async () => true, home });
    assert.match(listed.lines.join("\n"), /repo\s+project\s+needs approval\s+node server\.js/);
    // A command the agent runs has no terminal: it cannot approve its own project's server.
    const refused = await extensionsCommand("mcp", ["approve", "repo"], root, { interactive: false, confirm: async () => true, home });
    assert.deepEqual([refused.ok, refused.lines[0]], [false, "Approving a project server needs you at a terminal."]);
    assert.equal(mcpGate(openProjectTrust(root, home))(loadMcpServers(root, home).servers[0]!), "pending_approval");
    const declined = await extensionsCommand("mcp", ["approve", "repo"], root, { interactive: true, confirm: async () => false, home });
    assert.equal(declined.ok, false);
    const approved = await extensionsCommand("mcp", ["approve", "repo"], root, { interactive: true, confirm: async () => true, home });
    assert.equal(approved.ok, true);
    assert.equal(mcpGate(openProjectTrust(root, home))(loadMcpServers(root, home).servers[0]!), "yes");
    await extensionsCommand("mcp", ["disable", "repo"], root, { interactive: false, confirm: async () => false, home });
    assert.equal(mcpGate(openProjectTrust(root, home))(loadMcpServers(root, home).servers[0]!), "disabled");
});

test("tomverse hooks lists project hooks by number and approves them the same way", async () => {
    const { home, root } = setup();
    const dir = join(root, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }));
    const listed = await extensionsCommand("hooks", ["list"], root, { interactive: false, confirm: async () => true, home });
    assert.match(listed.lines.join("\n"), /1\. Stop\s+project\s+needs approval\s+echo done/);
    assert.equal((await extensionsCommand("hooks", ["approve", "1"], root, { interactive: false, confirm: async () => true, home })).ok, false);
    assert.equal((await extensionsCommand("hooks", ["approve", "1"], root, { interactive: true, confirm: async () => true, home })).ok, true);
    assert.match((await extensionsCommand("hooks", ["list"], root, { interactive: false, confirm: async () => true, home })).lines.join("\n"), /approved, on/);
});
