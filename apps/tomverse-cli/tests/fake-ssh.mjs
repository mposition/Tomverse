#!/usr/bin/env node
// A stand-in for `ssh` that "connects" to this computer's own shell, for tests. It takes the arguments the CLI gives ssh, checks the
// ones a real ssh must get, and runs the remote command string through `sh -c` exactly as a remote login shell would read it (so the
// quoting is really parsed), with the folders of this computer as "the remote machine". A destination name picks a failure:
//   badauth, newhost, changedhost, nohost, refused, slow  -> what ssh says for that, exit 255
//   anything else                                          -> runs the command
// A control file (--fake-control=<path>, JSON, rewritten by the test between calls) can make the next calls fail:
//   {"fail":"reset","times":1}                 the connection resets before the command starts
//   {"fail":"drop-mid","afterMs":300}          the connection goes away while the command runs
// --fake-log=<path> gets one JSON line per call. --fake-sh=<program> is the shell that reads the command (default: sh); --fake-path=<dir> is
// put in front of PATH there, so a test can make `sh` another shell (dash) for the scripts themselves.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const raw = process.argv.slice(2);
const fake = {};
while (raw[0]?.startsWith("--fake-")) {
    const [name, ...value] = raw.shift().slice(7).split("=");
    fake[name] = value.join("=");
}
const withArgument = new Set(["-o", "-p", "-F", "-i", "-l", "-J", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-I", "-m", "-O", "-Q", "-S", "-W", "-w"]);
const options = [];
let at = 0;
while (at < raw.length) {
    const item = raw[at];
    if (item === "--") { at += 1; break; }
    if (withArgument.has(item)) { options.push([item, raw[at + 1]]); at += 2; }
    else if (item.startsWith("-")) { options.push([item]); at += 1; }
    else break;
}
const destination = raw[at++];
const command = raw.slice(at).join(" ");
const optionValues = options.filter(([flag]) => flag === "-o").map(([, value]) => value);

if (fake.log) appendFileSync(fake.log, `${JSON.stringify({ destination, options, command })}\n`);

const say = (text, code = 255) => { process.stderr.write(`${text}\n`); process.exitCode = code; };
if (!destination || destination.startsWith("-")) { say("usage: ssh [options] destination [command]", 255); }
else if (!optionValues.includes("BatchMode=yes")) { say("fake-ssh: BatchMode=yes was not given", 99); }
else if (!command) { say("fake-ssh: no command", 98); }
else run();

function run() {
    switch (destination) {
        case "badauth": return say(`user@${destination}: Permission denied (publickey).`);
        case "newhost": return say("Host key verification failed.");
        case "changedhost": return say("@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@\nHost key verification failed.");
        case "nohost": return say(`ssh: Could not resolve hostname ${destination}: Name or service not known`);
        case "refused": return say(`ssh: connect to host ${destination} port 22: Connection refused`);
        case "slow": return void setTimeout(() => say("never"), 120_000);
        default: break;
    }
    let drop = null;
    if (fake.control && existsSync(fake.control)) {
        try {
            const control = JSON.parse(readFileSync(fake.control, "utf8"));
            if (control.fail && (control.times ?? 1) > 0) {
                drop = control;
                writeFileSync(fake.control, JSON.stringify({ ...control, times: (control.times ?? 1) - 1 }));
            }
        } catch { /* a control file being rewritten is not a failure */ }
    }
    if (drop?.fail === "reset") return say(`client_loop: send disconnect: Connection reset`);
    const pathExtra = process.platform === "win32" ? `C:\\Program Files\\Git\\usr\\bin${";"}C:\\Program Files\\Git\\bin${";"}` : "";
    // The command string is the shell's input as a file, not an argument: no operating system re-reads its quoting on the way.
    const folder = mkdtempSync(join(tmpdir(), "fake-ssh-"));
    const script = join(folder, "command.sh");
    writeFileSync(script, command);
    const child = spawn(fake.sh || "sh", [script.replaceAll("\\", "/")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MSYS: "winsymlinks:lnk", PATH: `${fake.path ? `${fake.path}${process.platform === "win32" ? ";" : ":"}` : ""}${pathExtra}${process.env.PATH ?? ""}` },
    });
    process.stdin.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("error", (error) => say(`fake-ssh: cannot start sh: ${error.message}`, 97));
    let dropped = false;
    if (drop?.fail === "drop-mid") {
        setTimeout(() => {
            dropped = true;
            // The connection goes: the remote side's input ends, and the client reports it.
            child.stdin.end();
            process.stdin.unpipe(child.stdin);
            say(`Connection to ${destination} closed by remote host.`);
            process.stdin.destroy();
            setTimeout(() => process.exit(255), 100);
        }, drop.afterMs ?? 300);
    }
    child.on("close", (code) => {
        try { rmSync(folder, { recursive: true, force: true }); } catch { /* best effort */ }
        if (dropped) return;
        process.stdin.unpipe(child.stdin);
        process.stdin.destroy();
        process.exitCode = code ?? 255;
    });
}
