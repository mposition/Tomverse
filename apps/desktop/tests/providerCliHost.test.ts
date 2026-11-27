import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderCliHost } from "../src/host/provider-cli-host";
import type { CliOutput } from "../src/host/provider-cli-login";
import { applyCliReleaseFixture } from "../src/host/provider-cli-path";
import { trustRecordFor, trustedCliFile } from "../src/host/provider-cli-trust";

const windows = process.platform === "win32";
const exe = (name: string) => (windows ? name + ".exe" : name);

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tomverse-cli-host-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  await Promise.all([mkdir(bin), mkdir(home)]);
  const codex = join(bin, exe("codex"));
  const claude = join(bin, exe("claude"));
  await Promise.all([copyFile(process.execPath, codex), copyFile(process.execPath, claude)]);
  if (!windows) await Promise.all([chmod(codex, 0o755), chmod(claude, 0o755)]);
  // The copy of this program stands in for an official release of Codex; the Claude copy matches no release.
  applyCliReleaseFixture({ openai: { version: "9.9.9", bytes: (await stat(codex)).size, sha256: await sha256(codex) } });
  return { root, bin, home, codex, claude, env: { PATH: bin, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot } as NodeJS.ProcessEnv };
}

function hostFor(world: Awaited<ReturnType<typeof setup>>, extra: { saved?: boolean; type?: (command: string) => "opened" | "terminalOff" | "noTask" | "unavailable"; trustName?: string } = {}) {
  const started: Array<{ file: string; args: readonly string[] }> = [];
  const typed: string[] = [];
  const host = createProviderCliHost({
    trustPath: () => join(world.root, extra.trustName ?? "trust-a.json"),
    writeTrust: (path, text) => writeFileSync(path, text),
    hasSaved: () => extra.saved === true,
    typeIntoTerminal: (command) => { typed.push(command); return extra.type?.(command) ?? "opened"; },
    shell: () => (windows ? "powershell" : "posix"),
    scan: { env: world.env, home: world.home },
    run: async (file, args): Promise<CliOutput> => { started.push({ file, args }); return { code: 1, output: "Not logged in\n", timedOut: false }; },
  });
  return { host, started, typed };
}

test("A scan finds the verified and the unverified CLI, starts only the verified one, and offers it once", { timeout: 60_000 }, async () => {
  const world = await setup();
  try {
    const { host, started } = hostFor(world);
    const scan = await host.scan();
    const codex = scan.providers.find(({ provider }) => provider === "openai");
    const claude = scan.providers.find(({ provider }) => provider === "anthropic");
    assert.deepEqual(codex?.candidates.map(({ status, version, login, trusted }) => [status, version, login, trusted]), [["pathVerified", "9.9.9", "loginRequired", false]]);
    assert.deepEqual(claude?.candidates.map(({ status, login, trusted }) => [status, login, trusted]), [["versionUnverified", "unknown", false]]);
    assert.equal(scan.offer, true);
    // Only the verified file was started, once, with the read-only status command.
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].args, ["login", "status"]);
    assert.equal(await realpath(started[0].file), await realpath(world.codex));

    // Answering the offer ends it for this account only, and a saved path ends it too.
    host.dismissOffer();
    assert.equal((await host.scan()).offer, false);
    assert.equal((await hostFor(world, { trustName: "trust-b.json" }).host.scan()).offer, true);
    assert.equal((await hostFor(world, { saved: true, trustName: "trust-c.json" }).host.scan()).offer, false);
  } finally {
    await rm(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Two scans at once share one run, and a verified file that changed is no longer served as verified", { timeout: 60_000 }, async () => {
  const world = await setup();
  try {
    const { host, started } = hostFor(world);
    const [first, second] = await Promise.all([host.scan(), host.scan()]);
    assert.equal(first, second);
    assert.equal(started.length, 1);
    await appendFile(world.codex, "\u0000");
    const changed = await host.scan();
    assert.deepEqual(changed.providers.find(({ provider }) => provider === "openai")?.candidates.map(({ status }) => status), ["versionUnverified"]);
    assert.equal(started.length, 1);
  } finally {
    await rm(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Trusting records one exact file, and any change to it asks again", { timeout: 60_000 }, async () => {
  const world = await setup();
  try {
    const { host } = hostFor(world);
    assert.equal(await host.trust("anthropic", world.claude), "stored");
    const claude = async () => (await host.scan()).providers.find(({ provider }) => provider === "anthropic")?.candidates[0];
    assert.deepEqual([(await claude())?.status, (await claude())?.trusted], ["versionUnverified", true]);
    const trusted = await host.trustedFile("anthropic", world.claude);
    assert.equal(trusted?.file, await realpath(world.claude));
    assert.ok(trusted?.fileStamp);

    // The same size with other content, then an appended byte: the record no longer matches.
    const original = await readFile(world.claude);
    const altered = Buffer.from(original);
    altered[altered.length - 1] ^= 0xff;
    await writeFile(world.claude, altered);
    assert.equal(await host.trustedFile("anthropic", world.claude), null);
    assert.equal((await claude())?.trusted, false);
    await writeFile(world.claude, original);
    assert.ok(await host.trustedFile("anthropic", world.claude));
    await appendFile(world.claude, "x");
    assert.equal(await host.trustedFile("anthropic", world.claude), null);
    // Another provider, another path and a missing file never match it.
    assert.equal(await host.trustedFile("openai", world.claude), null);
    assert.equal(await host.trustedFile("anthropic", join(world.bin, "missing")), null);

    // Trust is only for a file that is unverified: a verified one needs none, and nothing else can be trusted.
    assert.equal(await host.trust("openai", world.codex), "verified");
    assert.deepEqual(await host.trust("openai", join(world.bin, exe("codex") + ".missing")), { status: "wrongFile" });
    assert.deepEqual(await host.trust("openai", join(world.root, "empty", exe("codex"))), { status: "fileMissing" });
    assert.deepEqual(await host.trust("anthropic", join(world.bin, "notes.txt")), { status: "wrongFile" });
    assert.deepEqual(await host.trust("qwen", world.claude), { status: "wrongFile" });
    assert.deepEqual(await host.trust("anthropic", "relative/claude"), { status: "invalidPath" });
  } finally {
    await rm(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Sign-in is typed only for a verified file with a documented command", { timeout: 60_000 }, async () => {
  const world = await setup();
  try {
    const { host, typed } = hostFor(world);
    assert.equal(await host.login("openai", world.codex), "opened");
    assert.equal(typed.length, 1);
    assert.ok(typed[0].endsWith(" login\r"));
    assert.ok(typed[0].includes(await realpath(world.codex)));
    // An unverified file, a provider without a command and a missing file type nothing.
    assert.equal(await host.login("anthropic", world.claude), "unavailable");
    assert.equal(await host.login("google", world.codex), "unavailable");
    assert.equal(await host.login("openai", join(world.bin, exe("missing"))), "unavailable");
    assert.equal(typed.length, 1);
    // The terminal's own answer is passed on, so the screen can explain a terminal that is off.
    const off = hostFor(world, { type: () => "terminalOff" });
    assert.equal(await off.host.login("openai", world.codex), "terminalOff");
    // A file replaced after the scan is checked again before anything is typed.
    await appendFile(world.codex, "\u0000");
    assert.equal(await host.login("openai", world.codex), "unavailable");
    assert.equal(typed.length, 1);
  } finally {
    await rm(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("A saved file is resolved for a run only while its release or its trust record still holds", { timeout: 60_000 }, async () => {
  const world = await setup();
  try {
    const { host } = hostFor(world);
    const verified = { path: world.codex, status: "pathVerified" as const, version: "9.9.9" };
    const resolved = await host.resolveSaved("openai", verified);
    assert.deepEqual([resolved?.basis, resolved?.version, resolved?.file], ["release", "9.9.9", await realpath(world.codex)]);
    assert.equal(await host.resolveSaved("openai", { ...verified, version: "1.0.0" }), null);
    assert.equal(await host.resolveSaved("openai", { path: world.codex, status: "checkRequired" }), null);
    assert.equal(await host.resolveSaved("openai", { path: world.codex, status: "versionUnverified" }), null);
    assert.equal(await host.resolveSaved("openai", undefined), null);

    // A file the person trusted is resolved only after the record exists, and not once the file changed.
    const trusted = { path: world.claude, status: "userTrusted" as const };
    assert.equal(await host.resolveSaved("anthropic", trusted), null);
    assert.equal(await host.trust("anthropic", world.claude), "stored");
    const person = await host.resolveSaved("anthropic", trusted);
    assert.deepEqual([person?.basis, person?.version, person?.file], ["person", null, await realpath(world.claude)]);
    await appendFile(world.claude, "x");
    assert.equal(await host.resolveSaved("anthropic", trusted), null);
    // A verified file that changed is refused as well.
    await appendFile(world.codex, "x");
    assert.equal(await host.resolveSaved("openai", verified), null);
  } finally {
    await rm(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("A trust record belongs to the exact file, size and content it was made for", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-cli-trust-"));
  try {
    const file = join(root, "tool.bin");
    await writeFile(file, Buffer.from("one"));
    const made = await trustRecordFor(file);
    assert.ok(made);
    assert.equal(made.record.size, 3);
    assert.equal(made.record.sha256, createHash("sha256").update("one").digest("hex"));
    assert.equal(made.record.path, await realpath(file));
    assert.ok(await trustedCliFile(file, made.record));
    await writeFile(file, Buffer.from("two"));
    assert.equal(await trustedCliFile(file, made.record), null);
    await writeFile(file, Buffer.from("one"));
    assert.ok(await trustedCliFile(file, made.record));
    const copy = join(root, "copy.bin");
    await copyFile(file, copy);
    assert.equal(await trustedCliFile(copy, made.record), null);
    assert.equal(await trustedCliFile(file, undefined), null);
    // A folder, a missing file and a path that is not local give no record.
    assert.equal(await trustRecordFor(root), null);
    assert.equal(await trustRecordFor(join(root, "missing")), null);
    assert.equal(await trustRecordFor("relative"), null);
    const controller = new AbortController();
    controller.abort();
    assert.equal(await trustRecordFor(file, controller.signal), null);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
