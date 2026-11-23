import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";

import { DM_LAUNCHER_SPECS, DM_REQUEST_ROOT, dmExecutionPlan } from "./decisionMakerLauncherCore.ts";
import {
  dmCleanupVendor,
  dmCreateTemporaryDirectory,
  dmHostPath,
  dmVerifyScratch,
  type DmLauncherHost,
} from "./decisionMakerLauncherFs.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";
import {
  DM_DEPENDENCY_CACHE_ROOT,
  DM_NPM_CACHE,
  DM_PINNED_NPM_CLI,
  dmWriteWorkJail,
  type DmWorkOptions,
} from "./decisionMakerWorkCopy.ts";

/**
 * The Decision Maker command jail's self-test (docs/policy/amux-decision-maker.md
 * §0f-4, §5a), for the operator before the launcher serves requests: run as
 * the vendor account inside a transient unit with the launcher unit's
 * sandbox, it makes one synthetic request's temporary directory, writes the
 * jail as a request would, runs fixed checks in it -- and, for codex, the same
 * checks through codex's own sandbox with the plan's permissions profile --
 * and then runs the vendor cleanup. No model call and nothing sent; no request
 * directory is read. It refuses while a request's temporary directory exists.
 */

export type DmJailSelfTestLine = { ok: boolean; name: string; got: string; want: string };
export type DmJailSelfTestReport = { ok: boolean; proc: boolean | null; lines: DmJailSelfTestLine[]; cleanup: string };

const BLOCKED_OR_OPEN = (command: string) => `(${command}) >/dev/null 2>&1 && echo open || echo blocked`;

/** A stand-in credential in the caller's environment: the jail must not pass it on. */
const SELFTEST_SECRET = "ANTHROPIC_API_KEY";

const commandChecks = (input: {
  home: string;
  keep: string;
  work: string;
}): Array<[name: string, command: string, want: "open" | "blocked"]> => [
  ["write the work directory", BLOCKED_OR_OPEN(`echo x > '${input.work}/.amux-selftest' && rm '${input.work}/.amux-selftest'`), "open"],
  ["read the CLI login", BLOCKED_OR_OPEN(`cat '${input.keep}'`), "blocked"],
  ["see the home beyond the work directory", BLOCKED_OR_OPEN(`ls -A '${input.home}' | grep -qv '^dm-scratch$'`), "blocked"],
  ["read the request root", BLOCKED_OR_OPEN(`ls '${DM_REQUEST_ROOT}'`), "blocked"],
  ["write /tmp", BLOCKED_OR_OPEN("echo x > /tmp/amux-selftest"), "blocked"],
  ["write /usr", BLOCKED_OR_OPEN("echo x > /usr/amux-selftest"), "blocked"],
  ["network: TCP", BLOCKED_OR_OPEN(
    `node -e 'const s=require("net").connect(443,"140.82.112.3");s.setTimeout(4000,()=>process.exit(1));` +
      `s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1))'`,
  ), "blocked"],
  ["network: DNS", BLOCKED_OR_OPEN(`node -e 'require("dns").lookup("registry.npmjs.org",(e)=>process.exit(e?1:0))'`), "blocked"],
  ["a credential in the caller's environment", BLOCKED_OR_OPEN(`[ -n "\${${SELFTEST_SECRET}+x}" ]`), "blocked"],
  ["node runs", BLOCKED_OR_OPEN("node -e 0"), "open"],
];

const run = (file: string, args: string[], env: Record<string, string>, cwd: string): string => {
  try {
    return execFileSync(file, args, { cwd, env: env as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", windowsHide: true }).trim();
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr ?? (error as Error).message).trim().slice(0, 160);
    return `error: ${detail}`;
  }
};

export function dmJailSelfTest(
  host: DmLauncherHost,
  instance: DmInstanceScope,
  options: DmWorkOptions = {},
): DmJailSelfTestReport {
  const lines: DmJailSelfTestLine[] = [];
  const line = (name: string, got: string, want: string) => lines.push({ ok: got === want, name, got, want });
  if (dmVerifyScratch(host, instance).length > 0) {
    line("no request in flight (the scratch root is empty)", "a temporary directory is left", "empty");
    return { ok: false, proc: null, lines, cleanup: "not_run" };
  }
  const planned = dmExecutionPlan(instance, randomUUID());
  if (!planned.ok) throw new Error("AMUX Decision Maker self-test made an invalid plan");
  const { plan } = planned;
  const spec = DM_LAUNCHER_SPECS[instance];
  const at = (path: string) => dmHostPath(host, path);
  let proc: boolean | null = null;
  try {
    if (!dmCreateTemporaryDirectory(host, plan)) {
      line("make the request's temporary directory", "failed", "made");
    } else {
      mkdirSync(at(plan.paths.workDirectory), { mode: 0o700 });
      const work = dmWriteWorkJail(host, plan, options);
      line("the jail starts", work.ok ? "starts" : "does not start", "starts");
      if (work.ok) {
        proc = work.proc;
        line("the jail has its own /proc (Next's type generation needs it)", work.proc ? "yes" : "no", "yes");
        line("the npm cache is filled (scripts/amux-dm-dependency-cache.sh)", existsSync(at(`${DM_NPM_CACHE}/_cacache`)) ? "yes" : "no", "yes");
        line("the pinned npm is installed", existsSync(at(DM_PINNED_NPM_CLI)) ? "yes" : "no", "yes");
        const checks = commandChecks({
          home: at(spec.home),
          keep: at(`${spec.home}/${spec.stateKeep[0]!.slice(2)}`),
          work: at(plan.paths.workDirectory),
        });
        const callerEnv = { PATH: "/usr/bin:/bin", [SELFTEST_SECRET]: "selftest-not-a-key" };
        for (const [name, command, want] of checks) {
          line(`jail: ${name}`, run(work.jail, ["-c", command], callerEnv, at(plan.paths.workDirectory)), want);
        }
        line(
          "jail: the cache is read-only",
          run(work.jail, ["-c", BLOCKED_OR_OPEN(`touch '${at(DM_DEPENDENCY_CACHE_ROOT)}/.amux-selftest'`)], callerEnv, at(plan.paths.workDirectory)),
          "blocked",
        );
        if (spec.cli === "codex") {
          // codex's own sandbox, with the plan's two permission tokens and the fixed environment.
          const profile = plan.argv.flatMap((token, index) =>
            plan.argv[index - 1] === "-c" && /^(default_permissions|permissions\.)/.test(token) ? ["-c", token] : [],
          );
          const environment = Object.fromEntries(plan.environment);
          const sandboxChecks = commandChecks({
            home: spec.home,
            keep: `${spec.home}/${spec.stateKeep[0]!.slice(2)}`,
            work: plan.paths.workDirectory,
          });
          const sandboxed = (command: string) =>
            run(
              at(plan.executable),
              [...profile, "sandbox", "-P", "dm", "-C", plan.paths.workDirectory, "--", "/usr/bin/bash", "-c", command],
              environment,
              at(plan.paths.workDirectory),
            );
          for (const [name, command, want] of sandboxChecks) {
            // The fixed environment holds no credential to leak; the jail's own check covers a caller's.
            if (name === "a credential in the caller's environment") continue;
            line(`codex sandbox: ${name}`, sandboxed(command), want);
          }
          if (plan.paths.outputFile !== null) {
            // Inside, the account's home is codex's empty stand-in: a write may succeed there and land nowhere.
            sandboxed(`echo x > '${plan.paths.outputFile}' 2>/dev/null; true`);
            line("codex sandbox: the -o file is untouched", existsSync(at(plan.paths.outputFile)) ? "written" : "untouched", "untouched");
          }
        }
      }
    }
  } catch (error) {
    line("the self-test itself", `error: ${(error as Error).message.slice(0, 160)}`, "no error");
  }
  const cleanup = dmCleanupVendor(host, instance, plan.requestId);
  line("the vendor cleanup verifies", cleanup.status, "verified");
  return { ok: lines.every((entry) => entry.ok), proc, lines, cleanup: cleanup.status };
}
