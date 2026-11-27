import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    classifySshFailure, parseDestination, parsePort, parseRemoteFolder, parseRemoteShell, parseRemoteTarget, remoteShellCommand, RemoteError, scriptFailure, targetKey,
    shellQuote, sshArguments, targetLabel,
} from "../src/remote-target.js";
import { HAS_SH } from "./remote-fixture.js";

const refused = (run: () => unknown, code = "invalid-target") => assert.throws(run, (error) => error instanceof RemoteError && error.code === code);

test("an SSH target is a name or user@host and can never be read as an option", () => {
    for (const ok of ["devbox", "me@dev.example.com", "build-1_a", "10.0.0.5", "me@10.0.0.5", "user.name@host-1.internal", "fe80::1", "me@2001:db8::1"]) {
        assert.equal(parseDestination(ok), ok);
    }
    for (const bad of ["-oProxyCommand=calc", "-p22", "--", "-", "", "   ", "a b", "a;b", "a|b", "a&b", "a`b`", "$(id)", "a$b", "a\nb", "a\0b", "a\tb", "me@", "@host", "me@@host", "ssh://host", "host:22", "ho'st", 'ho"st', "ho\\st", "ho*st", "ho(st)", "a>b", "~", "me@-host"]) {
        refused(() => parseDestination(bad));
    }
    refused(() => parseDestination(undefined));
    refused(() => parseDestination(42));
    refused(() => parseDestination("a".repeat(400)));
});

test("a port is a whole number from 1 to 65535, or absent", () => {
    assert.equal(parsePort(undefined), undefined);
    assert.equal(parsePort(""), undefined);
    assert.equal(parsePort(22), 22);
    assert.equal(parsePort("2222"), 2222);
    for (const bad of [0, 65536, -1, 1.5, "22; id", "0x16", " ", "-p", "99999"]) refused(() => parsePort(bad));
});

test("a remote folder is an absolute path of plain characters, lexically cleaned, never the root, a credential folder or with ..", () => {
    assert.equal(parseRemoteFolder("/home/me/app"), "/home/me/app");
    assert.equal(parseRemoteFolder("/home/me//app/./src/"), "/home/me/app/src");
    assert.equal(parseRemoteFolder("/srv/my project"), "/srv/my project");
    assert.equal(parseRemoteFolder("/home/me/프로젝트"), "/home/me/프로젝트");
    for (const bad of ["home/me", "./app", "~/app", "", "/home/../etc", "/home/me/a;b", "/home/me/$(id)", "/home/me/`id`", "/home/me/a'b", '/home/me/a"b', "/home/me/a\\b", "/home/me/a\nb", "/home/me/a*", "/a/b|c", "/a b>c", "/a\0b"]) {
        refused(() => parseRemoteFolder(bad));
    }
    refused(() => parseRemoteFolder("/"), "folder-too-broad");
    refused(() => parseRemoteFolder("///"), "folder-too-broad");
    refused(() => parseRemoteFolder("/home/me/.ssh"), "folder-too-broad");
    refused(() => parseRemoteFolder("/home/me/.aws/x"), "folder-too-broad");
    refused(() => parseRemoteFolder("/home/me/app/.git"), "folder-too-broad");
    refused(() => parseRemoteFolder(`/${"a/".repeat(600)}`));
});

test("a target is validated as a whole and labelled for the person", () => {
    assert.deepEqual(parseRemoteTarget({ destination: " devbox ", port: "2200", folder: "/srv/app/" }), { destination: "devbox", port: 2200, folder: "/srv/app" });
    assert.deepEqual(parseRemoteTarget({ destination: "devbox", folder: "/srv/app" }), { destination: "devbox", folder: "/srv/app" });
    refused(() => parseRemoteTarget({ destination: "-x", folder: "/srv/app" }));
    refused(() => parseRemoteTarget({ destination: "devbox", folder: "srv/app" }));
    refused(() => parseRemoteTarget({ destination: "devbox", port: 70000, folder: "/srv/app" }));
    assert.equal(targetLabel({ destination: "me@devbox", port: 2200 }), "me@devbox:2200");
    assert.equal(targetLabel({ destination: "devbox" }), "devbox");
});

test("shellQuote wraps one value in single quotes and nothing in it stays special", () => {
    assert.equal(shellQuote("plain"), "'plain'");
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
    assert.equal(shellQuote(""), "''");
    assert.equal(shellQuote("a b $x `y` \"z\" ; | & > < * ? ! \\"), `'a b $x \`y\` "z" ; | & > < * ? ! \\'`);
    assert.throws(() => shellQuote("a\0b"), RemoteError);
});

test("what shellQuote and remoteShellCommand produce is read back exactly by a POSIX shell", { skip: !HAS_SH }, () => {
    const awkward = [
        "", "plain", "it's", "'''", "a b", "$HOME", "$(echo hi)", "`echo hi`", '"q"', "a\\nb", "line1\nline2", "; echo pwned", "| cat", "&& id",
        "*", "?", "[a-z]", "~", "!!", "%s", "-n", "--", "ünï cödé", "한국어 파일", "a\tb", " lead", "trail ", "\\", "\\\\'", "'; echo pwned; '", "x\\'y",
    ];
    // The shell reads the command as a file, as a remote login shell reads what ssh sends, so no operating system re-reads its quoting.
    const folder = mkdtempSync(join(tmpdir(), "tvq-"));
    const gitBin = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin;" : "";
    const env = { ...process.env, PATH: `${gitBin}${process.env.PATH}` };
    const read = (command: string) => {
        const file = join(folder, "c.sh");
        writeFileSync(file, command);
        return spawnSync("sh", [file.replaceAll("\\", "/")], { encoding: "utf8", env }).stdout;
    };
    try {
        for (const value of awkward) assert.equal(read(`printf '%s' ${shellQuote(value)}`), value, `value ${JSON.stringify(value)}`);
        // The whole command string: the script text and every argument arrive as written, in the order given.
        const script = 'for a in "$@"; do printf "[%s]" "$a"; done; printf "{%s}" "$0"';
        assert.equal(read(remoteShellCommand(script, awkward)), `${awkward.map((value) => `[${value}]`).join("")}{sh}`);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("ssh gets an argument array: options first, then --, then the target and one command; nothing is joined into a shell string", () => {
    const args = sshArguments({ destination: "me@devbox", port: 2200 }, "sh -c 'echo hi'", { platform: "linux" });
    assert.equal(args.at(-1), "sh -c 'echo hi'");
    assert.equal(args.at(-2), "me@devbox");
    assert.equal(args.at(-3), "--");
    assert.ok(args.includes("-T"));
    const options = args.flatMap((arg, index) => (args[index - 1] === "-o" ? [arg] : []));
    for (const required of ["BatchMode=yes", "ForwardAgent=no", "ClearAllForwardings=yes", "PermitLocalCommand=no", "RemoteCommand=none"]) assert.ok(options.includes(required), required);
    assert.equal(args[args.indexOf("-p") + 1], "2200");
    // The host key policy is not the configuration's to weaken: the command line wins over ~/.ssh/config, so `accept-new` or `no`
    // there cannot make the app connect to an unknown host or write to known_hosts.
    assert.ok(options.includes("StrictHostKeyChecking=yes"));
    assert.ok(options.includes("UpdateHostKeys=no"));
    assert.ok(!options.some((option) => /^(?:UserKnownHostsFile|StrictHostKeyChecking=(?!yes$)|CheckHostIP|VerifyHostKeyDNS)/.test(option)), "no option that points ssh at another set of keys");
    assert.ok(args.indexOf("StrictHostKeyChecking=yes") < args.indexOf("--"), "an option, before the target");
    assert.ok(!options.includes("ControlMaster=no"), "other systems keep the user's connection sharing");
    const windows = sshArguments({ destination: "devbox" }, "true", { platform: "win32" });
    assert.ok(windows.includes("ControlMaster=no") && windows.includes("ControlPath=none"), "Windows' OpenSSH has no connection sharing");
    assert.ok(!windows.includes("-p"));
    // The target is checked again where the arguments are made.
    refused(() => sshArguments({ destination: "-oProxyCommand=x" }, "true"));
    refused(() => sshArguments({ destination: "devbox", port: 0 }, "true"));
    // A hostile command string stays one argument.
    const hostile = sshArguments({ destination: "devbox" }, "x; rm -rf / # -o ProxyCommand=y");
    assert.equal(hostile.filter((arg) => arg === "devbox").length, 1);
    assert.equal(hostile.at(-1), "x; rm -rf / # -o ProxyCommand=y");
});

test("ssh's own words are told apart: key not usable without asking, unknown host key, changed host key, no ssh, unreachable, lost", () => {
    const kind = (stderr: string, rest: Partial<Parameters<typeof classifySshFailure>[0]> = {}) => classifySshFailure({ exitCode: 255, stderr, ...rest }, "devbox");
    assert.equal(kind("me@devbox: Permission denied (publickey,password).").code, "auth");
    assert.match(kind("me@devbox: Permission denied (publickey).").message, /terminal/);
    assert.match(kind("me@devbox: Permission denied (publickey).").message, /never asks/);
    assert.equal(kind("Too many authentication failures").code, "auth");
    assert.equal(kind("Host key verification failed.").code, "host-key");
    assert.match(kind("Host key verification failed.").message, /never accepts an unknown host/);
    assert.equal(kind("No ED25519 host key is known for devbox and you have requested strict checking.\nHost key verification failed.").code, "host-key");
    assert.equal(kind("@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.").code, "host-key-changed");
    assert.equal(kind("ssh: Could not resolve hostname devbox: Name or service not known").code, "name-not-found");
    assert.equal(kind("ssh: connect to host devbox port 22: Connection refused").code, "unreachable");
    assert.equal(kind("ssh: connect to host devbox port 22: Connection timed out").code, "unreachable");
    assert.equal(kind("client_loop: send disconnect: Connection reset").code, "connection-lost");
    assert.equal(kind("Connection to devbox closed by remote host.").code, "connection-lost");
    assert.equal(kind("", { exitCode: 255 }).code, "connection-lost");
    assert.equal(kind("", { exitCode: null, spawnError: "spawn ssh ENOENT" }).code, "ssh-missing");
    assert.match(kind("", { exitCode: null, spawnError: "spawn ssh ENOENT" }).message, /OpenSSH/);
    assert.equal(kind("", { exitCode: null, timedOut: true }).code, "timeout");
    assert.equal(kind("something odd", { exitCode: 3 }).code, "failed");
});

test("the remote scripts' exit codes become the error the person can act on", () => {
    assert.equal(scriptFailure(40, "", "devbox")?.code, "folder-missing");
    assert.equal(scriptFailure(41, "", "devbox")?.code, "not-a-folder");
    assert.equal(scriptFailure(42, "", "devbox")?.code, "outside-root");
    assert.equal(scriptFailure(43, "", "devbox")?.code, "changed");
    assert.equal(scriptFailure(44, "", "devbox")?.code, "not-found");
    assert.equal(scriptFailure(45, "", "devbox")?.code, "write-incomplete");
    assert.equal(scriptFailure(46, "", "devbox")?.code, "exists");
    assert.equal(scriptFailure(47, "tr\n", "devbox")?.code, "unsupported-remote");
    assert.match(scriptFailure(47, "tr\n", "devbox")!.message, /tr/);
    assert.equal(scriptFailure(1, "", "devbox"), null);
    assert.equal(scriptFailure(255, "", "devbox"), null);
});

test("the command shell of a remote project is sh unless it says bash-login, and it never changes what names the project", () => {
    assert.equal(parseRemoteShell(undefined), "sh");
    assert.equal(parseRemoteShell(""), "sh");
    assert.equal(parseRemoteShell("bash-login"), "bash-login");
    for (const bad of ["bash", "zsh", "sh -c", "bash-login ", 3, {}]) refused(() => parseRemoteShell(bad));
    const plain = parseRemoteTarget({ destination: "devbox", folder: "/srv/app" });
    assert.equal("shell" in plain, false, "sh is the default and is not written down");
    const login = parseRemoteTarget({ destination: "devbox", folder: "/srv/app", shell: "bash-login" });
    assert.equal(login.shell, "bash-login");
    assert.equal(targetKey(login), targetKey(plain));
    refused(() => parseRemoteTarget({ destination: "devbox", folder: "/srv/app", shell: "fish" }));
});
