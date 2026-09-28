import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GITLEAKS_RANGE_BASE,
  buildGitleaksFinalSummary,
  digestGitleaksScanOutput,
  runPinnedGitleaksRange,
  verifyPinnedGitleaksBinary,
} from "../scripts/check-gitleaks-exact-range.mjs";

const makeFakeBinary = () => {
  const directory = mkdtempSync(join(tmpdir(), "tomverse-gitleaks-guard-"));
  const path = join(directory, "gitleaks.exe");
  const bytes = Buffer.from("not the official executable\n", "utf8");
  writeFileSync(path, bytes);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const result = (overrides = {}) => ({
  status: 0,
  signal: null,
  error: undefined,
  stdout: "",
  stderr: "",
  ...overrides,
});

test("a fake binary that prints the pinned version still fails its executable hash", () => {
  const fake = makeFakeBinary();
  let spawnCalls = 0;

  assert.throws(
    () =>
      verifyPinnedGitleaksBinary({
        gitleaksBin: fake.path,
        spawn: () => {
          spawnCalls += 1;
          return result({ stdout: "8.24.3\n" });
        },
      }),
    /executable SHA-256 mismatch/u
  );
  assert.equal(spawnCalls, 0, "the hash must fail before trusting version output");
});

test("a hash-matched test binary still fails when its version is not exact", () => {
  const fake = makeFakeBinary();

  assert.throws(
    () =>
      verifyPinnedGitleaksBinary({
        gitleaksBin: fake.path,
        expectedSha256: fake.sha256,
        spawn: () => result({ stdout: "v8.24.3\n" }),
      }),
    /Gitleaks 8\.24\.3 required, got v8\.24\.3/u
  );
});

test("the final summary is one bounded line that represents every scan output byte", () => {
  const stdout = `${"stdout detail ".repeat(200)}\n`;
  const stderr = `${"stderr detail ".repeat(200)}\n`;
  const summary = buildGitleaksFinalSummary({
    resolvedPath: `C:\\${"very-long-directory\\".repeat(20)}gitleaks.exe`,
    version: "8.24.3",
    executableSha256: "e".repeat(64),
    range: `${GITLEAKS_RANGE_BASE}^..${"a".repeat(40)}`,
    status: 0,
    stdout,
    stderr,
  });

  assert.ok(summary.length <= 400, `summary was ${summary.length} characters`);
  assert.doesNotMatch(summary, /\r|\n/u);
  assert.match(summary, /^gitleaks\.final pathSha256=[0-9a-f]{64} /u);
  assert.match(summary, / version=8\.24\.3 /u);
  assert.match(summary, / exeSha256=e{64} /u);
  assert.match(summary, new RegExp(` range=${GITLEAKS_RANGE_BASE}\\^\\.\\.${"a".repeat(40)} `, "u"));
  assert.match(summary, / exit=0 /u);
  assert.match(summary, new RegExp(` outSha256=${digestGitleaksScanOutput({ stdout, stderr })} `, "u"));
  assert.match(summary, new RegExp(` stdoutBytes=${Buffer.byteLength(stdout, "utf8")} `, "u"));
  assert.match(summary, new RegExp(` stderrBytes=${Buffer.byteLength(stderr, "utf8")}$`, "u"));
  assert.doesNotMatch(summary, / path=/u, "an overlong resolved path is represented only by its stable hash");
});

test("the output digest binds raw bytes, stream boundaries, and exact raw lengths", () => {
  const stdout80 = Buffer.from([0x80]);
  const stdout81 = Buffer.from([0x81]);
  const stderr80 = Buffer.from([0x80]);
  const empty = Buffer.alloc(0);
  const facts = {
    resolvedPath: "C:\\external\\gitleaks.exe",
    version: "8.24.3",
    executableSha256: "e".repeat(64),
    range: `${GITLEAKS_RANGE_BASE}^..${"a".repeat(40)}`,
    status: 0,
  };

  assert.notEqual(
    digestGitleaksScanOutput({ stdout: stdout80, stderr: empty }),
    digestGitleaksScanOutput({ stdout: stdout81, stderr: empty }),
    "distinct invalid UTF-8 bytes must not collapse through text decoding"
  );
  assert.notEqual(
    digestGitleaksScanOutput({ stdout: stdout80, stderr: empty }),
    digestGitleaksScanOutput({ stdout: empty, stderr: stderr80 }),
    "the domain-separated stdout/stderr boundary is significant"
  );
  assert.notEqual(
    digestGitleaksScanOutput({ stdout: Buffer.from([0x61]), stderr: Buffer.from([0x62]) }),
    digestGitleaksScanOutput({ stdout: Buffer.from([0x61, 0x62]), stderr: empty }),
    "length framing prevents concatenation ambiguity"
  );

  const summary = buildGitleaksFinalSummary({ ...facts, stdout: stdout80, stderr: stderr80 });
  assert.match(summary, / stdoutBytes=1 /u);
  assert.match(summary, / stderrBytes=1(?: |$)/u);
  assert.match(summary, new RegExp(` outSha256=${digestGitleaksScanOutput({ stdout: stdout80, stderr: stderr80 })} `, "u"));
});

test("the verified binary scans only the pinned first-parent range and records evidence", () => {
  const fake = makeFakeBinary();
  const reviewedHead = "a".repeat(40);
  const calls = [];
  let output = "";
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "version") return result({ stdout: "8.24.3\n" });
    return result({ stdout: Buffer.from("scan complete\n"), stderr: Buffer.from("no findings\n") });
  };

  const scan = runPinnedGitleaksRange({
    gitleaksBin: fake.path,
    reviewedHead,
    expectedSha256: fake.sha256,
    spawn,
    write: (value) => {
      output += value;
    },
  });

  const expectedRange = `${GITLEAKS_RANGE_BASE}^..${reviewedHead}`;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["version"]);
  assert.deepEqual(calls[1].args, [
    "detect",
    "--source=.",
    "--no-banner",
    "--redact",
    "--gitleaks-ignore-path=.gitleaksignore",
    "--exit-code=1",
    `--log-opts=--no-merges --first-parent ${expectedRange}`,
  ]);
  assert.equal(scan.range, expectedRange);
  assert.match(output, new RegExp(`gitleaks\\.resolvedPath=${fake.path.replaceAll("\\", "\\\\")}`, "u"));
  assert.match(output, /gitleaks\.version=8\.24\.3/u);
  assert.match(output, new RegExp(`gitleaks\\.executableSha256=${fake.sha256}`, "u"));
  assert.match(output, new RegExp(`gitleaks\\.range=${expectedRange.replace("^", "\\^")}`, "u"));
  assert.match(output, /scan complete/u);
  assert.match(output, /no findings/u);
  assert.ok(scan.summary.length <= 400);
  assert.equal(output.trim().split(/\r?\n/u).at(-1), scan.summary, "the integrity summary is the final output line");
  assert.match(scan.summary, / exit=0 /u);
  assert.match(scan.summary, new RegExp(` outSha256=${digestGitleaksScanOutput({ stdout: "scan complete\n", stderr: "no findings\n" })} `, "u"));
});
