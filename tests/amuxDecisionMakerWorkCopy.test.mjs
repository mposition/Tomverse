// The Decision Maker's work directory and command jail (owner direction
// 2026-11-22, "DM은 접근권한 막지 마세요"; docs/policy/amux-decision-maker.md
// §0f-4, §5a): the v22 worker's jail, shared through amuxShellJailArgs, with
// the work directory the one writable place and the offline dependency cache
// read-only; DEPENDENCIES.md; and, where bwrap runs (Linux with unprivileged
// user namespaces), the real jail.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { dmExecutionPlan } from "../lib/amux/decisionMakerLauncherCore.ts";
import { DM_SYSTEM_HOST, dmCreateTemporaryDirectory, dmHostPath } from "../lib/amux/decisionMakerLauncherFs.ts";
import {
  DM_DEPENDENCY_CACHE_ROOT,
  DM_PINNED_NPM_CLI,
  DM_PINNED_NPM_DIRECTORY,
  dmDependenciesGuide,
  dmWorkJailArgs,
  dmWriteWorkJail,
} from "../lib/amux/decisionMakerWorkCopy.ts";
import { amuxShellJailArgs, amuxV22ShellJailArgs } from "../lib/amux/v22ShellJail.mjs";
import { AMUX_V22_PINNED_NPM_CLI } from "../lib/amux/v22WorkerDependencies.mjs";
import { REQUEST_ID, makeLauncherFixture } from "./support/amuxDmLauncherFixture.mjs";

const ANTHROPIC = "decision-maker-anthropic";
const OPENAI = "decision-maker-openai";
const planFor = (instance) => {
  const planned = dmExecutionPlan(instance, REQUEST_ID);
  assert.equal(planned.ok, true);
  return planned.plan;
};

test("the v22 worker's jail is unchanged by the shared builder", () => {
  const W = "/var/lib/tomverse-amux-v22-claude-impl/worktree";
  const paths = { worktreePath: W, tmpPath: `${W}/node_modules/.cache/amux-tmp`, gitPath: `${W}/.git` };
  assert.deepEqual(amuxV22ShellJailArgs(paths), [
    "--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-net", "--unshare-uts", "--unshare-cgroup", "--die-with-parent",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/sbin", "/sbin", "--ro-bind", "/etc", "/etc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", W, W, "--ro-bind", `${W}/.git`, `${W}/.git`, "--remount-ro", "/tmp", "--remount-ro", "/",
    "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "HOME", paths.tmpPath, "--setenv", "TMPDIR", paths.tmpPath,
  ]);
});

test("the DM's jail: the work directory the one writable bind, the cache read-only beside it, no home, no network", () => {
  // The system host: the policy paths as written (a pure computation, no file is touched).
  const host = DM_SYSTEM_HOST;
  const plan = planFor(ANTHROPIC);
  const work = dmHostPath(host, plan.paths.workDirectory);
  for (const proc of [false, true]) {
    const args = dmWorkJailArgs(host, plan, proc);
    for (const flag of ["--unshare-net", "--unshare-user", "--unshare-pid", "--die-with-parent", "--clearenv"]) assert.ok(args.includes(flag), flag);
    const binds = args.flatMap((arg, index) => (arg === "--bind" || arg === "--dev-bind" ? [args[index + 1]] : []));
    assert.deepEqual(binds, [work]);
    const readOnly = args.flatMap((arg, index) => (arg === "--ro-bind-try" ? [args[index + 1]] : []));
    assert.deepEqual(readOnly, [dmHostPath(host, DM_PINNED_NPM_DIRECTORY), dmHostPath(host, DM_DEPENDENCY_CACHE_ROOT)]);
    // Nothing of the account's home but the work directory, and never its login or the -o file.
    for (const arg of args) {
      assert.ok(!arg.includes(".credentials") && !arg.includes("last-message") && !arg.endsWith("/home/amux-dm-anthropic"), arg);
      assert.ok(!arg.includes("/shell/"), "the jail's own scripts are outside it");
    }
    // A fresh proc of the jail's own pid namespace, only when asked: never the unit's /proc.
    assert.equal(args.includes("--proc"), proc);
    assert.ok(!args.some((arg, index) => /bind/.test(arg) && args[index + 1] === "/proc"));
    const env = Object.fromEntries(args.flatMap((arg, index) => (arg === "--setenv" ? [[args[index + 1], args[index + 2]]] : [])));
    assert.equal(env.HOME, dmHostPath(host, plan.paths.workTemporaryDirectory));
    assert.equal(env.NPM_CONFIG_OFFLINE, "true");
    assert.equal(env.NPM_CONFIG_CACHE, dmHostPath(host, "/var/cache/tomverse-amux-dm/npm"));
    assert.ok(Object.keys(env).every((name) => !/TOKEN|KEY|SECRET|AUTH|PASS/.test(name)));
  }
  // The shared builder refuses a read-only path that holds or is inside the writable one.
  assert.throws(() => amuxShellJailArgs({ writablePath: work, tmpPath: `${work}/.t`, readOnlyBeside: [work] }), /outside the writable/);
  assert.throws(() => amuxShellJailArgs({ writablePath: work, tmpPath: `${work}/.t`, readOnlyBeside: ["/home"] }), /outside the writable/);
  assert.throws(() => amuxShellJailArgs({ writablePath: work, tmpPath: `${work}/.t`, environment: [["X", "it's"]] }), /unsafe jail environment/);
  // The DM uses the npm the v22 rollout installs.
  assert.equal(DM_PINNED_NPM_CLI, AMUX_V22_PINNED_NPM_CLI);
});

test("DEPENDENCIES.md names each tree's outcome and how to run checks, with or without /proc", () => {
  const withProc = dmDependenciesGuide({ proc: true, trees: { repo: "installed", "repo-patched": "generate_failed" } });
  assert.match(withProc, /- repo\/: installed/);
  assert.match(withProc, /- repo-patched\/: installed, but the Prisma client could not be generated/);
  assert.match(withProc, /npm run typecheck/);
  assert.match(withProc, /There is no network/);
  const withoutProc = dmDependenciesGuide({ proc: false, trees: {} });
  assert.match(withoutProc, /no tree to install/);
  assert.match(withoutProc, /no \/proc here, so `next typegen`/);
});

const posix = process.platform !== "win32";
const bwrap = posix && existsSync("/usr/bin/bwrap");

test("the real jail: commands write the work directory only, never see the login, and reach no network", { skip: !bwrap && "bwrap is not here" }, (t) => {
  const fixture = makeLauncherFixture(OPENAI);
  try {
    const plan = planFor(OPENAI);
    assert.equal(dmCreateTemporaryDirectory(fixture.host, plan), true);
    mkdirSync(fixture.at(plan.paths.workDirectory), { mode: 0o700 });
    const tries = (jail) => {
      try {
        execFileSync(jail, ["-c", "true"], { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    };
    const work = dmWriteWorkJail(fixture.host, plan, { jailStarts: (jail) => tries(jail) });
    if (!work.ok) {
      t.skip("bwrap does not start here (unprivileged user namespaces are off)");
      return;
    }
    const inJail = (command) =>
      execFileSync(work.jail, ["-c", `(${command}) >/dev/null 2>&1 && echo open || echo blocked`], {
        cwd: fixture.at(plan.paths.workDirectory),
        env: { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "selftest-not-a-key" },
        encoding: "utf8",
        timeout: 30_000,
      }).trim();
    const login = fixture.at(`${fixture.spec.home}/.codex/auth.json`);
    assert.equal(readFileSync(login, "utf8"), '{"synthetic":"auth"}');
    assert.equal(inJail(`echo x > '${fixture.at(plan.paths.workDirectory)}/f' && rm '${fixture.at(plan.paths.workDirectory)}/f'`), "open");
    assert.equal(inJail(`cat '${login}'`), "blocked");
    assert.equal(inJail(`echo x > '${fixture.at(plan.paths.shellDirectory)}/x'`), "blocked");
    assert.equal(inJail("echo x > /tmp/x"), "blocked");
    assert.equal(inJail('[ -n "${ANTHROPIC_API_KEY+x}" ]'), "blocked");
    assert.equal(
      inJail(`node -e 'require("dns").lookup("registry.npmjs.org",(e)=>process.exit(e?1:0))'`),
      "blocked",
    );
    if (work.proc) assert.equal(inJail("[ -d /proc/self ] && [ $(ls /proc | grep -c '^[0-9]*$') -lt 20 ]"), "open");
  } finally {
    fixture.dispose();
  }
});

test("the work tree's size: an unreadable directory is unmeasurable, never empty, and the walk changes nothing", { skip: !posix || process.getuid?.() === 0 }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { dmTreeCost, dmWorkTreeBytes } = await import("../lib/amux/decisionMakerWorkCopy.ts");
  const root = mkdtempSync(join(tmpdir(), "amux-dm-work-bytes-"));
  try {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "f"), Buffer.alloc(100_000, 1));
    for (let index = 0; index < 10; index += 1) writeFileSync(join(root, `empty-${index}`), "");
    const bytes = await dmWorkTreeBytes(root, Number.MAX_SAFE_INTEGER);
    assert.ok(typeof bytes === "number" && bytes >= 100_000 + 10 * 4096, String(bytes));
    assert.ok((await dmWorkTreeBytes(root, 10)) > 10, "stops once past the cap");
    // The broker's tree before the copy: bytes charged the same way, and one inode per entry.
    assert.deepEqual(dmTreeCost(root)?.entries, 13);
    chmodSync(join(root, "a"), 0o000);
    // Review r-20261123-112531-1a6c9d: the watch runs beside the DM's commands, so it never chmods.
    assert.equal(await dmWorkTreeBytes(root, Number.MAX_SAFE_INTEGER), "unmeasurable");
    assert.equal(statSync(join(root, "a")).mode & 0o777, 0);
    assert.equal(dmTreeCost(root), null);
  } finally {
    chmodSync(join(root, "a"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the free-inode floor: kept under a zero ratio, lost above the whole filesystem", { skip: !posix }, async () => {
  const { tmpdir } = await import("node:os");
  const { dmInodesKept, DM_WORK_DISK_LIMITS } = await import("../lib/amux/decisionMakerWorkCopy.ts");
  assert.equal(dmInodesKept(tmpdir(), 0), true);
  assert.equal(DM_WORK_DISK_LIMITS.freeInodeFloorRatio, 0.05);
  // A ratio over 1 can be kept only by a filesystem that reports no inodes at all.
  const { statfsSync } = await import("node:fs");
  assert.equal(dmInodesKept(tmpdir(), 2), Number(statfsSync(tmpdir()).files) === 0);
  assert.equal(dmInodesKept("/nonexistent/amux-dm", 0), false);
});
