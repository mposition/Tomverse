import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codeExtensionsInput } from "../src/contract";
import { codeExtensionsView, slashPromptFor } from "../src/host/code-extensions";

const write = (root: string, path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

test("the typed action accepts only what the renderer may ask for", () => {
  assert.ok(codeExtensionsInput.safeParse({ action: "list" }).success);
  assert.ok(codeExtensionsInput.safeParse({ action: "import-apply", ids: ["i-0123456789ab"] }).success);
  for (const bad of [{ action: "list", path: "/etc" }, { action: "import-apply", ids: [] }, { action: "import-apply", ids: ["/etc/passwd"] }, { action: "read-file" }]) {
    assert.equal(codeExtensionsInput.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("the view carries text only, and with no project there is nothing to show", () => {
  assert.deepEqual(codeExtensionsView(null, { action: "list" }), { project: false, skills: [], commands: [], agents: [], slash: [], issues: [] });
  const root = mkdtempSync(join(tmpdir(), "tomverse-ext-view-"));
  write(root, ".claude/skills/ship/SKILL.md", "---\ndescription: Ship it\nhooks:\n  PreToolUse: x\n---\nShip.\n");
  write(root, ".claude/commands/greet.md", "Say hi to $ARGUMENTS\n");
  write(root, ".claude/agents/reader.md", "---\nname: reader\ndescription: Reads\ntools: Read\nmodel: haiku\n---\nRead.\n");
  const view = codeExtensionsView(root, { action: "list" });
  assert.ok(view.skills.some((skill) => skill.name === "ship" && skill.source === ".claude/skills/ship/SKILL.md" && skill.ignored.join() === "hooks"));
  assert.ok(view.commands.some((command) => command.name === "greet"));
  assert.ok(view.agents.some((agent) => agent.name === "reader" && agent.base === "explore" && agent.model === "haiku"));
  assert.ok(view.slash.some((entry) => entry.name === "ship" && entry.kind === "skill"));
  assert.ok(!JSON.stringify(view).includes(root), "no absolute path of the project reaches the renderer");
});

test("a task that starts with /name stands for the skill or command, and anything else is left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "tomverse-ext-slash-"));
  write(root, ".claude/commands/greet.md", "Say hi to $ARGUMENTS\n");
  const run = slashPromptFor(root, "/greet Ada");
  assert.equal(run?.prompt, "Say hi to Ada");
  assert.match(run!.notice, /Running command \/greet \(\.claude\/commands\/greet\.md\)/);
  assert.equal(slashPromptFor(root, "/nope"), null);
  assert.equal(slashPromptFor(root, "/help"), null);
  assert.equal(slashPromptFor(root, "fix the bug"), null);
});
