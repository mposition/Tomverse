import assert from "node:assert/strict";
import test from "node:test";
import { AMUX_V19_OPEN_TRACE_SYSCALLS,
  createAmuxTrackedCheckoutOpenTraceObserver } from
  "../lib/amux/ideaTrackedCheckoutOpenTrace.mjs";

const directory = "/tmp/amux-v19-checkout-Ab12c3";
const files = ["src/a.ts", "src/b.ts"];
const line = (file) =>
  `123 openat(AT_FDCWD<${directory}>, "${file}", O_RDONLY) = 3<${directory}/${file}>\n`;
const make = () => createAmuxTrackedCheckoutOpenTraceObserver({ directory,
  files });

test("open trace records every successful checkout file open without raw lines", () => {
  const observer = make();
  const bytes = Buffer.from(line("src/b.ts") + line("src/a.ts") +
    line("src/a.ts"), "utf8");
  for (let offset = 0; offset < bytes.length; offset += 2)
    observer.observeChunk(bytes.subarray(offset, offset + 2));
  assert.deepEqual(observer.finish({ traceComplete: true }), {
    kind: "complete", files: ["src/a.ts", "src/b.ts"],
  });
});

test("open trace ignores failed opens and non-checkout files", () => {
  const observer = make();
  observer.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD<${directory}>, "missing.ts", O_RDONLY) = -1 ENOENT\n` +
    `123 openat(AT_FDCWD, "${directory}/missing.ts", O_RDONLY) = -1 ENOENT\n` +
    `123 openat(AT_FDCWD</usr>, "lib.so", O_RDONLY) = 3</usr/lib.so>\n` +
    `123 openat(AT_FDCWD<${directory}>, "/usr/lib.so", O_RDONLY) = 3</usr/lib.so>\n`));
  assert.deepEqual(observer.finish({ traceComplete: true }), {
    kind: "complete", files: [],
  });
});

test("open trace accepts successful open and openat2 file descriptors", () => {
  const observer = make();
  observer.observeChunk(Buffer.from(
    `123 open("${directory}/src/a.ts", O_RDONLY) = 3<${directory}/src/a.ts>\n` +
    `124 openat2(AT_FDCWD<${directory}>, "src/b.ts", ` +
    `{flags=O_RDONLY}, 24) = 4<${directory}/src/b.ts>\n`));
  assert.deepEqual(observer.finish({ traceComplete: true }), {
    kind: "complete", files: ["src/a.ts", "src/b.ts"],
  });
});

test("trace scope includes handle opens, compat opens and io_uring", () => {
  assert.match(AMUX_V19_OPEN_TRACE_SYSCALLS, /%file/);
  assert.match(AMUX_V19_OPEN_TRACE_SYSCALLS, /io_uring_enter/);
  const observer = make();
  observer.observeChunk(Buffer.from(
    `123 open64("${directory}/src/a.ts", O_RDONLY) = 3<${directory}/src/a.ts>\n` +
    `124 openat64(AT_FDCWD<${directory}>, "src/b.ts", O_RDONLY) = ` +
    `4<${directory}/src/b.ts>\n`));
  assert.deepEqual(observer.finish({ traceComplete: true }), {
    kind: "complete", files: ["src/a.ts", "src/b.ts"],
  });
  for (const call of ["open_by_handle_at", "io_uring_setup",
    "io_uring_enter", "io_uring_register"]) {
    const bypass = make();
    bypass.observeChunk(Buffer.from(`125 ${call}(...) = -1 EPERM\n`));
    assert.deepEqual(bypass.finish({ traceComplete: true }),
      { kind: "unverified" });
  }
});

test("directory traversals and metadata-only opens do not count as reads", () => {
  const observer = make();
  observer.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD, "${directory}", O_RDONLY|O_DIRECTORY) = ` +
    `3<${directory}>\n` +
    `123 openat(3<${directory}>, "src", O_RDONLY|O_DIRECTORY) = ` +
    `4<${directory}/src>\n` +
    `123 openat(4<${directory}/src>, "a.ts", O_PATH) = ` +
    `5<${directory}/src/a.ts>\n` +
    `123 openat(AT_FDCWD, "${directory}", O_PATH) = 6<${directory}>\n`));
  assert.deepEqual(observer.finish({ traceComplete: true }), {
    kind: "complete", files: [],
  });
  const writable = make();
  writable.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD, "${directory}/src/a.ts", O_WRONLY) = ` +
    `3<${directory}/src/a.ts>\n`));
  assert.deepEqual(writable.finish({ traceComplete: true }),
    { kind: "unverified" });
});

test("open trace refuses an extra file, unparseable checkout line or partial stream", () => {
  for (const input of [
    line("secret.txt"),
    `123 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY <unfinished ...>\n`,
    `123 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY) = 3</usr/elsewhere>\n`,
    `123 openat(AT_FDCWD, "relative", O_RDONLY) = 3\n`,
  ]) {
    const observer = make();
    observer.observeChunk(Buffer.from(input));
    assert.deepEqual(observer.finish({ traceComplete: true }), {
      kind: "unverified" });
  }
  const partial = make();
  partial.observeChunk(Buffer.from(line("src/a.ts")));
  assert.deepEqual(partial.finish({ traceComplete: false }), {
    kind: "unverified" });
  assert.deepEqual(partial.finish({ traceComplete: true }), {
    kind: "unverified" });
});

test("open trace refuses invalid UTF-8 and unsupported checkout shapes", () => {
  const observer = make();
  observer.observeChunk(Buffer.from([0xff]));
  assert.deepEqual(observer.finish({ traceComplete: true }), {
    kind: "unverified" });
  for (const badFiles of [["../escape"], ["src\\a.ts"], ["src/a.ts", "src/a.ts"]])
    assert.throws(() => createAmuxTrackedCheckoutOpenTraceObserver({
      directory, files: badFiles }));
});
