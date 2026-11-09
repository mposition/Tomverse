// Owner request 2026-11-09: the v22 Claude and Copilot implement workers get a
// shell, inside the sidecar's jail: no network, the checkout the one writable
// path (.git read-only), none of the sidecar's sign-in, home or journal.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AMUX_V22_SHELL_ENV_KEEP, amuxV22ShellJailArgs, amuxV22ShellJailScript,
  amuxV22ShellPrefixScript, createAmuxV22ShellJail } from "../lib/amux/v22ShellJail.mjs";

const W = "/var/lib/tomverse-amux-v22-claude-impl/worktree";
const paths = { worktreePath: W, tmpPath: `${W}/node_modules/.cache/amux-tmp`,
  gitPath: `${W}/.git` };

test("the jail has no network, binds only the checkout writable and rebuilds the environment", () => {
  const args = amuxV22ShellJailArgs(paths);
  for (const flag of ["--unshare-net", "--unshare-user", "--unshare-pid", "--disable-userns",
    "--die-with-parent", "--clearenv"]) assert.ok(args.includes(flag), flag);
  // Every writable bind is the checkout itself.
  const writable = args.flatMap((arg, i) => arg === "--bind" || arg === "--dev-bind" ?
    [args[i + 1]] : []);
  assert.deepEqual(writable, [W]);
  const at = (flag, value) => args.findIndex((arg, i) => arg === flag && args[i + 1] === value);
  assert.ok(at("--ro-bind", `${W}/.git`) > at("--bind", W), ".git read-only over the checkout");
  assert.ok(at("--remount-ro", "/") > at("--ro-bind", `${W}/.git`), "jail root read-only last");
  assert.ok(at("--remount-ro", "/tmp") > at("--tmpfs", "/tmp"));
  // Nothing of the sidecar's own state, the home or the host root is bound.
  for (const arg of args) {
    assert.ok(!/\/cli\b|\/home\b|\/journal\b|^\/var\/lib\/?$|^\/root|tomverse-bridge/.test(arg), arg);
  }
  assert.ok(!args.includes("--share-net") && !args.some((arg) => /^--(bind|dev-bind)-try$/.test(arg)));
  // Tools see the checkout's ignored temp dir as HOME and TMPDIR.
  assert.equal(args[at("--setenv", "HOME") + 2], paths.tmpPath);
  assert.equal(args[at("--setenv", "TMPDIR") + 2], paths.tmpPath);
  // No kept name carries a secret (Copilot's token, a provider key).
  assert.ok(AMUX_V22_SHELL_ENV_KEEP.every((name) => !/TOKEN|KEY|SECRET|AUTH|PASS/.test(name)));
});

test("the launcher fixes every path when written and refuses one it would have to quote", () => {
  const script = amuxV22ShellJailScript(paths);
  assert.match(script, /^#!\/usr\/bin\/bash\n/);
  assert.match(script, /exec \/usr\/bin\/bwrap .*-- \/usr\/bin\/bash "\$@"\n$/);
  assert.ok(script.includes(`'--unshare-net'`) && script.includes(`'${W}'`));
  assert.match(amuxV22ShellPrefixScript(`${W}x/bin/bash`), /exec '.*' -c "\$1"\n$/);
  for (const bad of [`${W} x`, `${W}'`, `${W}/$(id)`, "relative/path", `${W}/../etc`])
    assert.throws(() => amuxV22ShellJailScript({ ...paths, worktreePath: bad,
      tmpPath: `${bad}/t`, gitPath: `${bad}/.git` }), /unsafe jail path|outside/);
  assert.throws(() => amuxV22ShellJailArgs({ ...paths, tmpPath: "/tmp/amux" }), /outside the checkout/);
  assert.throws(() => amuxV22ShellJailArgs({ ...paths, gitPath: "/srv/other/.git" }), /outside/);
});

test("the sidecar writes the launcher outside the checkout and removes it; no .git, no jail", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-jail-"));
  try {
    // mkdtemp's name holds only characters the launcher accepts.
    const worktreePath = join(root, "worktree");
    const homePath = join(root, "home");
    const tmpPath = join(worktreePath, "node_modules", ".cache", "amux-tmp");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(homePath);
    if (!/^\/[A-Za-z0-9._/-]+$/.test(worktreePath)) return; // Windows temp paths
    assert.equal(await createAmuxV22ShellJail({ worktreePath, tmpPath, homePath }), null);
    await mkdir(join(worktreePath, ".git"));
    const jail = await createAmuxV22ShellJail({ worktreePath, tmpPath, homePath });
    assert.ok(jail.jailPath.startsWith(`${homePath}/shell-`));
    assert.equal(jail.binPath, join(jail.jailPath, ".."));
    assert.equal(await readFile(join(jail.binPath, "sh"), "utf8"),
      await readFile(jail.jailPath, "utf8"));
    assert.ok((await readFile(jail.prefixPath, "utf8")).includes(jail.jailPath));
    assert.ok(existsSync(tmpPath));
    await jail.cleanup();
    assert.deepEqual(await readdir(homePath), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const bwrapUsable = () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return "bwrap is not installed";
  try {
    execFileSync("/usr/bin/bwrap", ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/",
      "/usr/bin/true"], { stdio: "ignore" });
    return false;
  } catch { return "this host cannot start an unprivileged bwrap sandbox"; }
};

test("a command in the real jail reaches no network and writes only the checkout", {
  skip: bwrapUsable() }, async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-jail-"));
  try {
    const worktreePath = join(root, "worktree");
    const homePath = join(root, "home");
    await mkdir(join(worktreePath, ".git"), { recursive: true });
    await mkdir(homePath);
    await writeFile(join(homePath, "secret"), "canary");
    const tmpPath = join(worktreePath, "node_modules", ".cache", "amux-tmp");
    const jail = await createAmuxV22ShellJail({ worktreePath, tmpPath, homePath });
    const out = execFileSync(jail.jailPath, ["-c", [
      "cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' ' | tr '\\n' ,; echo",
      `(echo x > ${root}/outside) 2>/dev/null && echo outside-open || echo outside-refused`,
      "(echo x > .git/x) 2>/dev/null && echo git-open || echo git-refused",
      "(echo x > /tmp/x) 2>/dev/null && echo tmp-open || echo tmp-refused",
      `cat ${homePath}/secret 2>/dev/null || echo home-refused`,
      "echo x > inside && echo inside-ok", "echo token=${COPILOT_GITHUB_TOKEN-unset}"].join("\n")],
    { cwd: worktreePath, encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", COPILOT_GITHUB_TOKEN: "gho_synthetic", TERM: "dumb" } });
    assert.deepEqual(out.trim().split("\n"), ["lo,", "outside-refused", "git-refused",
      "tmp-refused", "home-refused", "inside-ok", "token=unset"]);
    assert.equal(await readFile(join(worktreePath, "inside"), "utf8"), "x\n");
    await jail.cleanup();
  } finally { await rm(root, { recursive: true, force: true }); }
});
