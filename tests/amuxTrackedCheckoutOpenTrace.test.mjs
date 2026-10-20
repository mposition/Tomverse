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
    bypass.observeChunk(Buffer.from(`125 ${call}(...) = 3\n`));
    assert.deepEqual(bypass.finish({ traceComplete: true }),
      { kind: "unverified" });
    const denied = make();
    denied.observeChunk(Buffer.from(`125 ${call}(...) = -1 EPERM\n`));
    assert.deepEqual(denied.finish({ traceComplete: true }),
      { kind: "complete", files: [] });
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

test("a failed result counts only at the end of the line, never inside a path", () => {
  // Review r-20261018-135342-5151e2: a path containing ") = -1 " must not make a
  // successful but undecoded open look failed.
  const crafted = make();
  crafted.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD<${directory}>, "x) = -1 ENOENT (y)", O_RDONLY) = 3\n`));
  assert.deepEqual(crafted.finish({ traceComplete: true }), { kind: "unverified" });
  // The real strace shape with a description still counts as a failed open.
  const described = make();
  described.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD<${directory}>, "missing.ts", O_RDONLY) = -1 ENOENT (No such file or directory)\n`));
  assert.deepEqual(described.finish({ traceComplete: true }), { kind: "complete", files: [] });
});

test("only a refused io_uring or handle open leaves the manifest complete", () => {
  // The v19 seccomp filter answers ENOSYS; a kernel with io_uring disabled
  // answers EPERM. Success, another errno or a refusal text inside the
  // arguments are all unverified.
  for (const call of ["io_uring_setup", "io_uring_enter", "io_uring_register", "open_by_handle_at"]) {
    for (const result of ["-1 ENOSYS (Function not implemented)", "-1 EPERM (Operation not permitted)", "-1 ENOSYS"]) {
      const refused = make();
      refused.observeChunk(Buffer.from(`125 ${call}(16, {}) = ${result}\n`));
      assert.deepEqual(refused.finish({ traceComplete: true }), { kind: "complete", files: [] }, `${call} ${result}`);
    }
    for (const line of [`125 ${call}(16, {}) = 7\n`, `125 ${call}(16, {}) = -1 EFAULT (Bad address)\n`,
      `125 ${call}("x) = -1 ENOSYS (y)", {}) = 7\n`, `125 ${call}(16, {}) = ?\n`]) {
      const observer = createAmuxTrackedCheckoutOpenTraceObserver({ directory, files, diagnostic: true });
      observer.observeChunk(Buffer.from(line));
      assert.deepEqual(observer.finish({ traceComplete: true }),
        { kind: "unverified", reason: `unobservable_${call}` }, line);
    }
  }
});

test("diagnostic reasons are fixed codes and appear only when asked for", () => {
  const cases = [
    [`123 openat(AT_FDCWD<${directory}>, "src/c.ts", O_RDONLY) = 3<${directory}/src/c.ts>\n`, "unlisted_open"],
    [`123 openat(AT_FDCWD<${directory}>, "src/a.ts", O_WRONLY) = 3<${directory}/src/a.ts>\n`, "non_read_open"],
    [`123 openat(AT_FDCWD<${directory}>, "../x", O_RDONLY) = 3</tmp/x>\n`, "escaped_checkout"],
    [`123 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY) = 3\n`, "undecoded_open"],
  ];
  for (const [text, reason] of cases) {
    const quiet = make();
    quiet.observeChunk(Buffer.from(text));
    assert.deepEqual(quiet.finish({ traceComplete: true }), { kind: "unverified" });
    const loud = createAmuxTrackedCheckoutOpenTraceObserver({ directory, files, diagnostic: true });
    loud.observeChunk(Buffer.from(text));
    assert.deepEqual(loud.finish({ traceComplete: true }), { kind: "unverified", reason });
  }
  const incomplete = createAmuxTrackedCheckoutOpenTraceObserver({ directory, files, diagnostic: true });
  assert.deepEqual(incomplete.finish({ traceComplete: false }), { kind: "unverified", reason: "trace_incomplete" });
  assert.deepEqual(incomplete.finish({ traceComplete: true }), { kind: "unverified", reason: "duplicate_finish" });
});

test("a device annotation outside the checkout is decoded; a device inside is refused", () => {
  // Measured on the v19 runner: Node opens /dev/null relative to the checkout.
  const outside = createAmuxTrackedCheckoutOpenTraceObserver({ directory, files, diagnostic: true });
  outside.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD<${directory}>, "/dev/null", O_RDONLY|O_CLOEXEC) = 17</dev/null<char 1:3>>\n` +
    line("src/a.ts")));
  assert.deepEqual(outside.finish({ traceComplete: true }), { kind: "complete", files: ["src/a.ts"] });
  const inside = createAmuxTrackedCheckoutOpenTraceObserver({ directory, files, diagnostic: true });
  inside.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY) = 4<${directory}/src/a.ts<block 8:1>>\n`));
  assert.deepEqual(inside.finish({ traceComplete: true }), { kind: "unverified", reason: "device_open" });
  // Any other annotation shape is not decoded and stays fail-closed.
  const odd = createAmuxTrackedCheckoutOpenTraceObserver({ directory, files, diagnostic: true });
  odd.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY) = 4<${directory}/src/a.ts<pipe:[1]>>\n`));
  assert.deepEqual(odd.finish({ traceComplete: true }), { kind: "unverified", reason: "undecoded_open" });
});

test("a call strace splits across threads is paired by PID and judged whole", () => {
  const run = (text) => {
    const observer = createAmuxTrackedCheckoutOpenTraceObserver({ directory, files, diagnostic: true });
    observer.observeChunk(Buffer.from(text));
    return observer.finish({ traceComplete: true });
  };
  // Measured shape from the v19 runner, two threads interleaved.
  assert.deepEqual(run(
    `11 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY|O_CLOEXEC <unfinished ...>\n` +
    `12 openat(AT_FDCWD<${directory}>, "src/b.ts", O_RDONLY|O_CLOEXEC <unfinished ...>\n` +
    `13 statx(AT_FDCWD<${directory}>, "src/a.ts", AT_STATX_SYNC_AS_STAT <unfinished ...>\n` +
    `12 <... openat resumed>)           = 22<${directory}/src/b.ts>\n` +
    `13 <... statx resumed>, {stx_mask=STATX_ALL}) = 0\n` +
    `11 <... openat resumed>)           = 21<${directory}/src/a.ts>\n`),
  { kind: "complete", files: ["src/a.ts", "src/b.ts"] });
  // A split open of an unlisted file is still refused.
  assert.deepEqual(run(
    `11 openat(AT_FDCWD<${directory}>, "src/c.ts", O_RDONLY <unfinished ...>\n` +
    `11 <... openat resumed>) = 3<${directory}/src/c.ts>\n`),
  { kind: "unverified", reason: "unlisted_open" });
  // A split io_uring setup counts only when the kernel refused it.
  assert.deepEqual(run(`11 io_uring_setup(256, 0x7ffd <unfinished ...>\n` +
    `11 <... io_uring_setup resumed>) = -1 ENOSYS (Function not implemented)\n`),
  { kind: "complete", files: [] });
  assert.deepEqual(run(`11 io_uring_setup(256, 0x7ffd <unfinished ...>\n` +
    `11 <... io_uring_setup resumed>) = 5<anon_inode:[io_uring]>\n`),
  { kind: "unverified", reason: "unobservable_io_uring_setup" });
});

test("an unpaired resume or a split open that never resumed is never certified", () => {
  const run = (text) => {
    const observer = createAmuxTrackedCheckoutOpenTraceObserver({ directory, files, diagnostic: true });
    observer.observeChunk(Buffer.from(text));
    return observer.finish({ traceComplete: true });
  };
  assert.deepEqual(run(`11 <... openat resumed>) = 3<${directory}/src/a.ts>\n`),
    { kind: "unverified", reason: "unpaired_resume" });
  assert.deepEqual(run(`11 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY <unfinished ...>\n` +
    `11 <... openat2 resumed>) = 3<${directory}/src/a.ts>\n`),
  { kind: "unverified", reason: "unpaired_resume" });
  assert.deepEqual(run(`11 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY <unfinished ...>\n` +
    `11 openat(AT_FDCWD<${directory}>, "src/b.ts", O_RDONLY <unfinished ...>\n`),
  { kind: "unverified", reason: "unpaired_resume" });
  assert.deepEqual(run(`11 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY <unfinished ...>\n`),
    { kind: "unverified", reason: "unfinished_open" });
  // A killed thread's open reports `= ?`, which is not a decoded result.
  assert.deepEqual(run(`11 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY <unfinished ...>\n` +
    `11 <... openat resumed>) = ?\n`), { kind: "unverified", reason: "undecoded_open" });
});

test("detail mode names refused opens by relative path and flags, and changes no verdict", () => {
  const detailed = () => createAmuxTrackedCheckoutOpenTraceObserver({
    directory, files, diagnostic: true, detail: true });
  const text =
    `123 openat(AT_FDCWD<${directory}>, "CLAUDE.md", O_RDONLY|O_CLOEXEC) = 3<${directory}/CLAUDE.md>\n` +
    line("src/a.ts") +
    `123 openat(AT_FDCWD<${directory}>, ".git/config", O_RDONLY|O_NOFOLLOW) = 4<${directory}/.git/config>\n` +
    `123 openat(AT_FDCWD<${directory}>, "src/a.ts", O_WRONLY|O_TRUNC) = 5<${directory}/src/a.ts>\n` +
    `123 openat(AT_FDCWD<${directory}>, "/home/runner/.claude/x", O_RDONLY) = 6</home/runner/.claude/x>\n` +
    `123 openat(AT_FDCWD<${directory}>, "../x", O_RDONLY|O_CLOEXEC) = 3</tmp/x>\n` +
    `123 openat(AT_FDCWD<${directory}>, "src/a.ts", O_RDONLY) = 4<${directory}/src/a.ts<block 8:1>>\n`;
  const quiet = make();
  quiet.observeChunk(Buffer.from(text));
  assert.deepEqual(quiet.finish({ traceComplete: true }), { kind: "unverified" });
  const plain = createAmuxTrackedCheckoutOpenTraceObserver({
    directory, files, diagnostic: true });
  plain.observeChunk(Buffer.from(text));
  const verdict = plain.finish({ traceComplete: true });
  assert.deepEqual(verdict, { kind: "unverified", reason: "unlisted_open" });
  const loud = detailed();
  const bytes = Buffer.from(text, "utf8");
  for (let offset = 0; offset < bytes.length; offset += 7)
    loud.observeChunk(bytes.subarray(offset, offset + 7));
  const result = loud.finish({ traceComplete: true });
  assert.equal(result.kind, verdict.kind);
  assert.equal(result.reason, verdict.reason, "the first refusal stays the reason");
  assert.deepEqual(result.detail, [
    { code: "unlisted_open", path: "CLAUDE.md", flags: ["O_RDONLY", "O_CLOEXEC"] },
    { code: "unlisted_open", path: ".git/config", flags: ["O_RDONLY", "O_NOFOLLOW"] },
    { code: "non_read_open", path: "src/a.ts", flags: ["O_WRONLY", "O_TRUNC"] },
    { code: "escaped_checkout", path: "<outside>", flags: ["O_RDONLY", "O_CLOEXEC"] },
    { code: "device_open", path: "src/a.ts", flags: ["O_RDONLY"] },
  ]);
  assert.equal(JSON.stringify(result).includes("/home/runner"), false,
    "an absolute path outside the checkout is never recorded");
  assert.equal(JSON.stringify(result).includes(directory), false);
});

test("detail mode caps entries, cuts long paths and records nothing without a refusal", () => {
  const clean = createAmuxTrackedCheckoutOpenTraceObserver({
    directory, files, diagnostic: true, detail: true });
  clean.observeChunk(Buffer.from(line("src/a.ts")));
  assert.deepEqual(clean.finish({ traceComplete: true }),
    { kind: "complete", files: ["src/a.ts"] });
  const many = createAmuxTrackedCheckoutOpenTraceObserver({
    directory, files, diagnostic: true, detail: true });
  let text = "";
  for (let index = 0; index < 40; index += 1)
    text += `123 openat(AT_FDCWD<${directory}>, "x${index}", O_RDONLY) = 3<${directory}/x${index}>\n`;
  const longName = `${"d/".repeat(150)}é.ts`;
  text += `123 openat(AT_FDCWD<${directory}>, "${longName}", O_RDONLY) = 3<${directory}/${longName}>\n`;
  many.observeChunk(Buffer.from(text));
  const result = many.finish({ traceComplete: true });
  assert.equal(result.detail.length, 20);
  assert.equal(result.detail[19].path, "x19");
  const long = createAmuxTrackedCheckoutOpenTraceObserver({
    directory, files, diagnostic: true, detail: true });
  long.observeChunk(Buffer.from(
    `123 openat(AT_FDCWD<${directory}>, "${longName}", O_RDONLY) = 3<${directory}/${longName}>\n`));
  const [entry] = long.finish({ traceComplete: true }).detail;
  assert.equal(entry.path.length, 200);
  assert.match(entry.path, /^[\x20-\x7e]+$/);
  // Detail is opt-in: the diagnostic result alone never carries it.
  const off = createAmuxTrackedCheckoutOpenTraceObserver({
    directory, files, diagnostic: true });
  off.observeChunk(Buffer.from(text));
  assert.deepEqual(off.finish({ traceComplete: true }),
    { kind: "unverified", reason: "unlisted_open" });
});
