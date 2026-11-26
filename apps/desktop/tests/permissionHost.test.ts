import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { permissionCommand } from "../src/permission-contract";
import { DesktopPermissions } from "../src/host/permission-host";

const setup = () => {
  const base = mkdtempSync(join(tmpdir(), "tvd-permissions-"));
  const home = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root);
  const modeFile = join(base, "permission-mode.txt");
  const make = (projectRoot: string | null = root) => new DesktopPermissions({ modeFile: () => modeFile, root: () => projectRoot, env: { TOMVERSE_HOME: home } });
  return { base, home, root, modeFile, make };
};

test("the mode starts at ask, is remembered between runs, and Allow all needs confirmation and is never remembered", () => {
  const { make, modeFile } = setup();
  const permissions = make();
  permissions.load();
  assert.equal(permissions.view().mode, "ask");
  assert.deepEqual(permissions.run({ action: "set-mode", mode: "read_only" }), { ok: true });
  assert.equal(readFileSync(modeFile, "utf8"), "read_only");
  const next = make();
  next.load();
  assert.equal(next.current, "read_only");

  assert.equal(next.run({ action: "set-mode", mode: "allow_all" }).ok, false, "no confirmation, no change");
  assert.equal(next.current, "read_only");
  assert.deepEqual(next.run({ action: "set-mode", mode: "allow_all", confirmed: true }), { ok: true });
  assert.equal(next.current, "allow_all");
  assert.equal(next.runtimeMessage().mode, "allow_all");
  const restarted = make();
  restarted.load();
  assert.equal(restarted.current, "ask", "the app starts in ask mode again");

  assert.deepEqual(next.run({ action: "set-mode", mode: "auto_review" }), { ok: true });
  const again = make();
  again.load();
  assert.equal(again.current, "auto_review");
});

test("a mode the screen did not send, or a rule that is not valid, changes nothing", () => {
  const { make, modeFile, home } = setup();
  const permissions = make();
  assert.equal(permissionCommand.safeParse({ action: "set-mode", mode: "yolo" }).success, false);
  assert.equal(permissionCommand.safeParse({ action: "set-mode", mode: "ask", extra: 1 }).success, false);
  assert.equal(permissionCommand.safeParse({ action: "add-rule", scope: "global", rule: { effect: "allow", tool: "run_command", pattern: "x" } }).success, false);
  assert.equal(permissions.run({ action: "add-rule", scope: "user", rule: { effect: "allow", tool: "bash", pattern: "x" } }).ok, false);
  assert.equal(permissions.run({ action: "add-rule", scope: "user", rule: { effect: "allow", tool: "run_command" } }).ok, false);
  assert.equal(permissions.run({ action: "add-rule", scope: "project", rule: { effect: "deny", tool: "run_command", pattern: "rm" } }).ok, true);
  assert.equal(make(null).run({ action: "add-rule", scope: "project", rule: { effect: "deny", tool: "run_command", pattern: "rm" } }).ok, false, "no project open");
  assert.throws(() => readFileSync(modeFile, "utf8"));
  assert.throws(() => readFileSync(join(home, "permissions.json"), "utf8"), "nothing was written to the user rules");
});

test("rules are added to and removed from the user and project files; the view follows the files", () => {
  const { make, home, root } = setup();
  const permissions = make();
  const rule = { effect: "deny", tool: "run_command", pattern: "rm -rf" } as const;
  assert.deepEqual(permissions.run({ action: "add-rule", scope: "user", rule }), { ok: true });
  assert.deepEqual(permissions.run({ action: "add-rule", scope: "project", rule: { effect: "ask", tool: "apply_patch", pattern: "migrations/**" } }), { ok: true });
  assert.equal(JSON.parse(readFileSync(join(home, "permissions.json"), "utf8")).rules[0].pattern, "rm -rf");
  assert.equal(JSON.parse(readFileSync(join(root, ".tomverse", "permissions.json"), "utf8")).rules[0].tool, "apply_patch");
  assert.deepEqual(permissions.view().rules.user, [rule]);
  assert.equal(permissions.view().rules.project.length, 1);
  assert.deepEqual(permissions.run({ action: "remove-rule", scope: "user", rule }), { ok: true });
  assert.deepEqual(permissions.view().rules.user, []);
});

test("allow rules a repository brings wait for the person's confirmation; the view says so", () => {
  const { make, root } = setup();
  mkdirSync(join(root, ".tomverse"));
  writeFileSync(join(root, ".tomverse", "permissions.json"), JSON.stringify({ version: 1, rules: [{ effect: "allow", tool: "run_command", pattern: "curl" }] }));
  const permissions = make();
  assert.equal(permissions.view().rules.trust, "untrusted");
  assert.deepEqual(permissions.run({ action: "trust-project" }), { ok: true });
  assert.equal(permissions.view().rules.trust, "trusted");
  assert.deepEqual(permissions.run({ action: "revoke-trust" }), { ok: true });
  assert.equal(permissions.view().rules.trust, "untrusted");
  writeFileSync(join(root, ".tomverse", "permissions.json"), "{ nope");
  assert.match(permissions.view().rules.problems[0] ?? "", /not valid JSON/);
});
