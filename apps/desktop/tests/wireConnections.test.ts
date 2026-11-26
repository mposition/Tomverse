import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserCommand } from "../src/browser-contract";
import { serializeElementComments } from "../src/element-comment";
import { browserToolsFor, createBrowserAgentSwitch } from "../src/host/code-browser-switch";
import { discoverForRuntime } from "../src/host/code-extensions";
import { createPullLinker, MAX_WAITING_PULL_LINKS } from "../src/host/task-pull-links";
import { createTestHome } from "../scripts/test-home.mjs";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `tomverse-wire-${name}-`));

test("the agent's browser tools are the person's switch, off by default and off when the file cannot be read", () => {
  const file = join(temp("switch"), "code-browser-agent.txt");
  const first = createBrowserAgentSwitch(() => file);
  first.load();
  assert.equal(first.enabled, false);
  first.set(true);
  assert.equal(readFileSync(file, "utf8"), "enabled");
  const second = createBrowserAgentSwitch(() => file);
  second.load();
  assert.equal(second.enabled, true, "kept after a restart");
  second.set(false);
  writeFileSync(file, "yes please");
  second.load();
  assert.equal(second.enabled, false, "anything but the exact word is off");
  assert.equal(createBrowserAgentSwitch(() => join(temp("none"), "missing.txt")).enabled, false);
});

test("a test fixture can still turn the browser tools on, and the person's switch needs no fixture", () => {
  assert.deepEqual(browserToolsFor({ switchOn: false, fixtureAgent: false, fixtureInspection: false }), { agent: false, inspection: false });
  assert.deepEqual(browserToolsFor({ switchOn: true, fixtureAgent: false, fixtureInspection: false }), { agent: true, inspection: true });
  assert.deepEqual(browserToolsFor({ switchOn: false, fixtureAgent: true, fixtureInspection: false }), { agent: true, inspection: true });
  assert.deepEqual(browserToolsFor({ switchOn: false, fixtureAgent: false, fixtureInspection: true }), { agent: false, inspection: true });
});

test("the switch is a typed command with no address or path in it", () => {
  assert.deepEqual(browserCommand.parse({ type: "agent-tools", enabled: true }), { type: "agent-tools", enabled: true });
  for (const bad of [{ type: "agent-tools" }, { type: "agent-tools", enabled: "yes" }, { type: "agent-tools", enabled: true, url: "http://localhost:3000" }, { type: "agent-tools", enabled: true, tab: crypto.randomUUID() }]) {
    assert.throws(() => browserCommand.parse(bad), JSON.stringify(bad));
  }
});

const pick = { id: "pick-01234567", tab: crypto.randomUUID(), url: "http://localhost:3000/", selector: "#add", tag: "button", text: "Add", box: { x: 1, y: 2, width: 30, height: 10 } };

test("an element comment mentions the picture only when the agent has the tool that can read it", () => {
  assert.match(serializeElementComments([{ pick, comment: "Blue." }]), /picture pick-01234567 \(browser_screenshot with pick/);
  const without = serializeElementComments([{ pick, comment: "Blue." }], { picture: false });
  assert.doesNotMatch(without, /picture|browser_screenshot/);
  assert.match(without, /selector "#add"/);
  assert.match(without, /comment: Blue\./);
});

test("the runtime reads skills from the folders it is handed, not from the home of whoever runs the tests", () => {
  const home = temp("home");
  const claude = temp("claude");
  const root = temp("project");
  mkdirSync(join(home, ".claude", "skills", "mine"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "mine", "SKILL.md"), "---\ndescription: From the handed home\n---\nDo it.\n");
  mkdirSync(join(claude, "commands"), { recursive: true });
  writeFileSync(join(claude, "commands", "hello.md"), "Say hello\n");
  const names = (env: NodeJS.ProcessEnv) => { const registry = discoverForRuntime(root, env); return [...registry.skills, ...registry.commands].map((item) => item.name).sort(); };
  assert.deepEqual(names({ TOMVERSE_DESKTOP_USER_HOME: home }), ["mine"]);
  assert.deepEqual(names({ TOMVERSE_DESKTOP_USER_HOME: home, TOMVERSE_DESKTOP_CLAUDE_DIR: claude }), ["hello"], "the Claude folder it is told about replaces ~/.claude");
});

test("tests get an empty home of their own for the home, Claude, Tomverse and Codex folders, and it can be removed", () => {
  const first = createTestHome();
  const second = createTestHome();
  try {
    assert.notEqual(first.root, second.root);
    const { env } = first;
    assert.equal(env.HOME, env.USERPROFILE);
    assert.equal(new Set([env.HOME, env.CLAUDE_CONFIG_DIR, env.TOMVERSE_HOME, env.CODEX_HOME]).size, 4);
    for (const folder of [env.HOME, env.CLAUDE_CONFIG_DIR, env.TOMVERSE_HOME, env.CODEX_HOME]) {
      assert.ok(folder!.startsWith(first.root), folder);
      assert.ok(existsSync(folder!));
    }
  } finally {
    first.remove();
    second.remove();
  }
  assert.equal(existsSync(first.root), false);
});

test("a pull request the agent opens is linked when its run ends, and one the person opens at once", async () => {
  const linked: string[] = [];
  const task = "s-1";
  let ready = false;
  const linker = createPullLinker({ currentTask: () => task, ready: () => ready, link: async (url) => { linked.push(url); } });
  await linker.add("https://github.com/o/r/pull/1");
  await linker.add("https://github.com/o/r/pull/2");
  await linker.add("https://github.com/o/r/pull/1");
  assert.deepEqual(linked, [], "the run is still going: nothing is linked yet");
  assert.deepEqual(linker.waiting("s-1"), ["https://github.com/o/r/pull/2", "https://github.com/o/r/pull/1"]);
  ready = true;
  await linker.flush("s-1");
  assert.deepEqual(linked, ["https://github.com/o/r/pull/2", "https://github.com/o/r/pull/1"]);
  assert.deepEqual(linker.waiting("s-1"), []);
  await linker.add("https://github.com/o/r/pull/3");
  assert.equal(linked.at(-1), "https://github.com/o/r/pull/3", "made from the Git panel: linked at once");
  await linker.flush("s-1");
  assert.equal(linked.length, 3, "nothing is linked twice");
});

test("a waiting link is only made for the task it belongs to, and the list stays small", async () => {
  const linked: string[] = [];
  let task: string | null = "s-1";
  let ready = false;
  const linker = createPullLinker({ currentTask: () => task, ready: () => ready, link: async (url) => { linked.push(url); } });
  await linker.add("https://github.com/o/r/pull/1");
  task = "s-2";
  ready = true;
  await linker.flush("s-1");
  assert.deepEqual(linked, [], "another task is on screen: the link is dropped, not attached to it");
  await linker.flush("s-2");
  assert.deepEqual(linked, []);
  task = null;
  await linker.add("https://github.com/o/r/pull/9");
  assert.deepEqual(linked, [], "no task, no link");
  task = "s-3";
  ready = false;
  for (let number = 1; number <= MAX_WAITING_PULL_LINKS + 5; number += 1) await linker.add(`https://github.com/o/r/pull/${number}`);
  assert.equal(linker.waiting("s-3").length, MAX_WAITING_PULL_LINKS);
  linker.forget("s-3");
  assert.deepEqual(linker.waiting("s-3"), []);
});
