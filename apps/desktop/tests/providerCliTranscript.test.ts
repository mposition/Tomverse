import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_CLI_LIMITS } from "../src/provider-cli-exec-contract";
import { approvalRequestFor, createTranscript } from "../src/host/provider-cli-transcript";
import type { ExecEvent } from "../src/host/provider-cli-exec";

const clean = (text: string) => text.replaceAll("SECRET", "[removed]");
const apply = (events: ExecEvent[]) => {
  const transcript = createTranscript(clean);
  for (const event of events) transcript.apply(event);
  return transcript;
};

test("A run reads as messages and one line per command or tool call, in the order they happened", () => {
  const transcript = apply([
    { type: "session", id: "t" },
    { type: "message", id: "m1", text: "I will check the status." },
    { type: "command", id: "c1", command: "git   status", state: "running" },
    { type: "command", id: "c1", command: "git   status", state: "done", exitCode: 0, output: "clean\n" },
    { type: "command", id: "c2", command: "npm test", state: "failed", exitCode: 2, output: "1 failing SECRET" },
    { type: "tool", id: "t1", name: "Read", detail: "src/a.ts", state: "done" },
    { type: "message", id: "m2", text: "All done." },
  ]);
  assert.deepEqual(transcript.entries, [
    { role: "assistant", text: "I will check the status." },
    { role: "event", text: "$ git status ✓\nclean\n" },
    { role: "event", text: "$ npm test ✗ 2\n1 failing [removed]" },
    { role: "event", text: "⚙ Read src/a.ts ✓" },
    { role: "assistant", text: "All done." },
  ]);
});

test("A command that ends without naming itself (Claude Code) keeps the command of its start", () => {
  const transcript = apply([
    { type: "command", id: "c1", command: "ls -la", state: "running" },
    { type: "command", id: "c1", command: "", state: "done", output: "x" },
  ]);
  assert.deepEqual(transcript.entries, [{ role: "event", text: "$ ls -la ✓\nx" }]);
});

test("The answer being written shows until a message replaces it, and a message repeated by id is one entry", () => {
  const transcript = createTranscript(clean);
  transcript.apply({ type: "delta", id: "stream", text: "Hel" });
  transcript.apply({ type: "delta", id: "stream", text: "lo" });
  assert.equal(transcript.streaming, "Hello");
  transcript.apply({ type: "message", id: "m", text: "Hello" });
  transcript.apply({ type: "message", id: "m", text: "Hello" });
  assert.equal(transcript.streaming, "");
  assert.deepEqual(transcript.entries, [{ role: "assistant", text: "Hello" }]);
});

test("The files a run changed are listed once each, and a failed change is not shown as applied", () => {
  const transcript = apply([
    { type: "files", id: "f1", files: [{ path: "a.ts", kind: "create" }], state: "running" },
    { type: "files", id: "f1", files: [{ path: "a.ts", kind: "create" }], state: "done" },
    { type: "files", id: "f2", files: [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "delete" }], state: "done" },
    { type: "files", id: "f3", files: [{ path: "c.ts", kind: "update" }], state: "failed" },
  ]);
  assert.deepEqual(transcript.changes.map(({ path, kind, current }) => ({ path, kind, current })), [
    { path: "a.ts", kind: "create", current: "applied" },
    { path: "b.ts", kind: "delete", current: "applied" },
    { path: "c.ts", kind: "update", current: "failed" },
  ]);
  assert.ok(transcript.changes.every(({ id }) => /^cli:[0-9a-f]{16}$/.test(id)));
  assert.equal(new Set(transcript.changes.map(({ id }) => id)).size, 3);
});

test("A long run stays bounded and says how many calls were left out", () => {
  const events: ExecEvent[] = [];
  for (let index = 0; index < LIVE_CLI_LIMITS.entries + 30; index += 1) events.push({ type: "tool", id: `t${index}`, name: "Read", state: "done" });
  events.push({ type: "message", id: "last", text: "The final answer is kept." });
  for (let index = 0; index < LIVE_CLI_LIMITS.changes + 10; index += 1) events.push({ type: "files", id: `f${index}`, files: [{ path: `f${index}.ts`, kind: "update" }], state: "done" });
  const transcript = apply(events);
  assert.ok(transcript.entries.length <= LIVE_CLI_LIMITS.entries + 51);
  assert.equal(transcript.entries.at(-1)?.role, "assistant", "a message still fits after the tool lines ran out of room");
  assert.ok(transcript.entries.some((entry) => entry.role === "event" && /^… \+\d+$/.test(entry.text)));
  assert.equal(transcript.changes.length, LIVE_CLI_LIMITS.changes);
  const long = apply([{ type: "command", id: "c", command: "x".repeat(10_000), state: "done", output: "y".repeat(100_000) }]);
  assert.ok(long.entries[0]!.role === "event" && long.entries[0]!.text.length < LIVE_CLI_LIMITS.commandOutput + 400);
});

test("The approval card shows what the CLI asked for and never offers to remember it", () => {
  const shell = approvalRequestFor({ id: "r1", tool: "Bash", input: { command: "rm -rf build SECRET", timeout: 5_000 } }, "/work", clean);
  assert.equal(shell.canRemember, false);
  assert.equal(shell.root, "/work");
  assert.equal(shell.command?.display, "rm -rf build [removed]");
  assert.equal(shell.command?.mode, "shell");
  assert.equal(shell.command?.timeoutMs, 5_000);
  assert.match(shell.id, /^[0-9a-f-]{36}$/);

  const write = approvalRequestFor({ id: "r2", tool: "Write", input: { file_path: "docs/a.md", content: "hello" } }, "/work", clean);
  assert.deepEqual(write.files, [{ path: "docs/a.md", action: "create", eol: "lf", bom: false, preimage: null, postimage: null, before: null, after: "hello" }]);
  const edit = approvalRequestFor({ id: "r3", tool: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } }, "/work", clean);
  assert.equal(edit.files?.[0]?.action, "update");
  assert.deepEqual([edit.files?.[0]?.before, edit.files?.[0]?.after], ["a", "b"]);

  const other = approvalRequestFor({ id: "r4", tool: "WebFetch", input: { url: "https://example.com" } }, "/work", clean);
  assert.match(other.explanation ?? "", /example\.com/);
  assert.equal(other.command, undefined);
  assert.equal(other.files, undefined);
});
