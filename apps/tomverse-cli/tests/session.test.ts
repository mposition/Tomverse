import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimLock, deleteSession, Journal, JournalError, listSessions, SessionLockedError, sessionsDir, writeFileAtomic } from "../src/session.js";
import { tempDir } from "./helpers.js";

const init = (root = "/tmp/x") => ({
    workspace: { root },
    endpointOrigin: "https://tomverse.app",
    keyPrefix: "tvk_abcdefgh",
    readOnly: false,
    model: { requested: "m", pinned: "m", pinnedFrom: "user" as const, contextWindowTokens: 1000, maxOutputTokens: 100 },
    limits: { maxRequests: 20, timeoutMs: 900_000, commandTimeoutMs: 120_000 },
});

test("one writer per session; a stale lock from a dead process is taken over", () => {
    const home = tempDir("home");
    const journal = Journal.create(home, init());
    assert.throws(() => Journal.open(home, journal.state.id), SessionLockedError);
    journal.release();
    const reopened = Journal.open(home, journal.state.id);
    reopened.release();
    // A lock left by a process that no longer exists on this host.
    writeFileSync(join(sessionsDir(home), journal.state.id, "lock"), JSON.stringify({ pid: 2 ** 30, host: hostname(), at: "x" }));
    const taken = Journal.open(home, journal.state.id);
    taken.release();
});


test("a failed checkpoint stops every later request, backup and commit", () => {
    const home = tempDir("home");
    let fail = false;
    const journal = Journal.create(home, init(), {
        writeFileAtomic: (path, data) => {
            if (fail) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
            writeFileAtomic(path, data);
        },
    });
    fail = true;
    journal.state.messages.push({ role: "user", content: "x" });
    assert.throws(() => journal.commit(), /could not be saved \(ENOSPC/);
    fail = false;
    // Even though the disk is fine again, this process does not carry on unrecorded.
    assert.throws(() => journal.commit(), JournalError);
    assert.throws(() => journal.newGeneration("agent"), JournalError);
    assert.throws(() => journal.saveBackup("c1", Buffer.from("x")), JournalError);
    journal.release();
});

test("checkpoints are atomic files; a corrupt one is reported, never silently replaced", () => {
    const home = tempDir("home");
    const journal = Journal.create(home, init());
    journal.state.messages.push({ role: "user", content: "keep me" });
    journal.commit();
    journal.release();
    const dir = join(sessionsDir(home), journal.state.id);
    assert.ok(existsSync(join(dir, "session.prev.json")));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
    writeFileSync(join(dir, "session.json"), '{"schemaVersion":1,"id":"trunc');
    assert.throws(() => Journal.open(home, journal.state.id), /cannot be read\. The previous checkpoint is kept/);
    assert.equal(listSessions(home)[0]!.status, "unreadable");
});

test("session files are private to their owner on POSIX", { skip: process.platform === "win32" }, () => {
    const home = tempDir("home");
    const journal = Journal.create(home, init());
    journal.saveBackup("c1", Buffer.from("old"));
    journal.release();
    const dir = join(sessionsDir(home), journal.state.id);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "session.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "backups", "c1.pre")).mode & 0o777, 0o600);
});

test("--no-persist writes nothing to disk; backups live in memory only", () => {
    const journal = Journal.create(null, init());
    journal.commit();
    assert.equal(journal.persisted, false);
    const name = journal.saveBackup("c1", Buffer.from("old"))!;
    assert.equal(journal.readBackup(name)!.toString(), "old");
});

test("every request gets its own key, and request counts only grow", () => {
    const journal = Journal.create(null, init());
    const keys = Array.from({ length: 5 }, () => journal.newGeneration("agent").idempotencyKey);
    assert.equal(new Set(keys).size, 5);
    assert.ok(keys.every((k) => k.startsWith(`tvcli-${journal.state.id}-`)));
    assert.equal(journal.state.usage.requests, 5);
    assert.equal(journal.unresolvedGenerations().length, 5, "a recorded intent is unknown until its answer is seen");
});

test("sessions delete removes the folder and its backups, not while it is open", () => {
    const home = tempDir("home");
    const journal = Journal.create(home, init());
    journal.saveBackup("c1", Buffer.from("x"));
    assert.throws(() => deleteSession(home, journal.state.id), SessionLockedError);
    journal.release();
    deleteSession(home, journal.state.id);
    assert.equal(existsSync(join(sessionsDir(home), journal.state.id)), false);
    assert.throws(() => deleteSession(home, "../../etc"), /not a session id/);
});

test("a live process's lock is never removed, by open or by delete; a dead one's is taken over", () => {
    const home = tempDir("home");
    const journal = Journal.create(home, init());
    journal.release();
    const lock = join(sessionsDir(home), journal.state.id, "lock");
    const live = JSON.stringify({ pid: process.pid, host: hostname(), at: "x" });
    writeFileSync(lock, live);
    assert.throws(() => Journal.open(home, journal.state.id), SessionLockedError);
    assert.throws(() => deleteSession(home, journal.state.id), SessionLockedError);
    assert.equal(readFileSync(lock, "utf8"), live, "the live lock is untouched");
    assert.ok(existsSync(join(sessionsDir(home), journal.state.id, "session.json")));
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, host: hostname(), at: "x" }));
    claimLock(lock, journal.state.id);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
    assert.deepEqual(readdirSync(join(sessionsDir(home), journal.state.id)).filter((f) => f.includes(".stale-")), []);
});
test("a leftover reclaim guard blocks a takeover instead of being guessed away; locks are never empty", () => {
    const home = tempDir("home");
    const journal = Journal.create(home, init());
    journal.release();
    const lock = join(sessionsDir(home), journal.state.id, "lock");
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, host: hostname(), at: "x" }));
    writeFileSync(`${lock}.reclaim`, JSON.stringify({ pid: 2 ** 30, host: hostname(), at: "x" }));
    assert.throws(() => claimLock(lock, journal.state.id), /delete .*\.reclaim/);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, 2 ** 30, "the lock is left as it was");
    unlinkSync(`${lock}.reclaim`);
    claimLock(lock, journal.state.id);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
    assert.deepEqual(readdirSync(join(sessionsDir(home), journal.state.id)).filter((f) => /\.tmp$|\.reclaim$/.test(f)), []);
});