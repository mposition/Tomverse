#!/usr/bin/env node
// Checks the v22 implement shell jail (lib/amux/v22ShellJail.mjs) for one
// worker, inside a transient unit with that worker unit's sandbox, before a
// rollout restarts the worker. No model call. Usage, as root on the AMUX box:
//   systemd-run --wait --pipe ... /usr/bin/node shell-jail-selftest.mjs <worker>
// Exit 0 only when every check matches; the result table goes to stdout.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { createAmuxV22ShellJail } from "../lib/amux/v22ShellJail.mjs";
import { AMUX_V22_WORKTREE_TMP } from "../lib/amux/v22WorkerDependencies.mjs";

const worker = process.argv[2] ?? "";
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(worker)) {
  console.error("usage: amux-v22-shell-jail-selftest.mjs <worker>");
  process.exit(2);
}
// A second argument names another state root of the same layout (a dry run).
const root = process.argv[3] ?? `/var/lib/tomverse-amux-v22-${worker}`;
if (!/^\/[A-Za-z0-9._/-]+$/.test(root)) process.exit(2);
const worktreePath = `${root}/worktree`;
const tmpPath = join(worktreePath, AMUX_V22_WORKTREE_TMP);
const checks = [
  ["network: TCP", `node -e 'const s=require("net").connect(443,"140.82.112.3");` +
    `s.setTimeout(4000,()=>{console.log("open");process.exit()});` +
    `s.on("connect",()=>{console.log("open");process.exit()});s.on("error",()=>console.log("blocked"))'`],
  ["network: DNS", `node -e 'require("dns").lookup("registry.npmjs.org",(e)=>console.log(e?"blocked":"open"))'`],
  ["network: UDP", `node -e 'const d=require("dgram").createSocket("udp4");` +
    `d.send("x",53,"1.1.1.1",(e)=>{console.log(e?"blocked":"open");d.close()})'`],
  ...["/tmp", `${root}/home`, `${root}/cli`, `${root}/journal`, `${worktreePath}/.git`]
    .map((dir) => [`write ${dir}`,
      `(echo x > '${dir}/amux-selftest') 2>/dev/null && echo open || echo blocked`]),
  ...[`${root}/cli`, `${root}/home`, `${root}/journal`].map((dir) => [`read ${dir}`,
    `ls '${dir}' >/dev/null 2>&1 && echo open || echo blocked`]),
  ["write checkout", `echo x > '${tmpPath}/amux-selftest' && rm '${tmpPath}/amux-selftest' && echo open || echo blocked`],
  ["CLI token in env", `[ -n "\${COPILOT_GITHUB_TOKEN+x}" ] && echo open || echo blocked`],
  ["node runs", `node -e 'console.log(1+1===2?"open":"blocked")'`],
];
const want = (name) => /^(write checkout|node runs)$/.test(name) ? "open" : "blocked";

let jail;
try {
  jail = await createAmuxV22ShellJail({ worktreePath, tmpPath, homePath: `${root}/home` });
  if (!jail) throw new Error("no jail: the checkout has no .git");
  let failed = 0;
  for (const [name, command] of checks) {
    let got;
    try {
      got = execFileSync(jail.jailPath, ["-c", command], { cwd: worktreePath,
        env: { PATH: "/usr/bin:/bin", COPILOT_GITHUB_TOKEN: "gho_selftest_not_a_token" },
        encoding: "utf8", timeout: 30_000 }).trim();
    } catch (error) { got = `error: ${String(error.stderr ?? error.message).trim().slice(0, 120)}`; }
    const ok = got === want(name);
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${worker} ${name}: ${got} (want ${want(name)})`);
  }
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.log(`FAIL ${worker} jail: ${error.message}`);
  process.exitCode = 1;
} finally { await jail?.cleanup().catch(() => {}); }
