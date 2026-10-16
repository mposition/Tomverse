import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { join } from "node:path";
import test from "node:test";

import {
  AMUX_CONTRACT_PATHS,
  AMUX_EXECUTION_GRADE_CODE_LATCH,
  classifyAmuxExecutionPath,
  deriveAmuxExecutionGrade,
  normalizeAmuxExecutionPath,
} from "../lib/amux/executionGradeCore.ts";

const task = (overrides = {}) => ({
  taskRole: "implement",
  expectedPaths: ["components/chat/OrdinaryPanel.tsx"],
  proposedGrade: "advanced",
  ...overrides,
});

test("S1 ships the code latch off", () => {
  assert.equal(AMUX_EXECUTION_GRADE_CODE_LATCH, false);
});

test("hard frontier conditions precede the intake proposal", () => {
  assert.equal(deriveAmuxExecutionGrade(task({ taskRole: "design", proposedGrade: "routine" })), "frontier");
  for (const expectedPaths of [null, undefined, [], Array(41).fill("lib/ordinary.ts")]) {
    assert.equal(deriveAmuxExecutionGrade(task({ expectedPaths, proposedGrade: "routine" })), "frontier");
  }
  assert.equal(deriveAmuxExecutionGrade(task({ expectedPaths: ["lib/ordinary.ts", "../escape"] })), "frontier");
  assert.equal(deriveAmuxExecutionGrade(task({ expectedPaths: Array(1), proposedGrade: "routine" })), "frontier");
  assert.equal(deriveAmuxExecutionGrade(task({ expectedPaths: ["LiB/AmUx/grade.ts"] })), "frontier");
});

test("frontier proposal wins after all paths pass validation", () => {
  assert.equal(deriveAmuxExecutionGrade(task({ proposedGrade: "frontier" })), "frontier");
});

test("routine proposal can lower a small permitted role, including implementation", () => {
  for (const taskRole of ["implement", "test", "investigate", "verify"]) {
    assert.equal(deriveAmuxExecutionGrade(task({ taskRole, proposedGrade: "routine" })), "routine");
    assert.equal(deriveAmuxExecutionGrade(task({
      taskRole,
      expectedPaths: ["lib/ordinary.ts", "components/ordinary.tsx"],
      proposedGrade: "routine",
    })), "routine");
  }
});

test("remaining valid paths and roles use advanced", () => {
  assert.equal(deriveAmuxExecutionGrade(task()), "advanced");
  assert.equal(deriveAmuxExecutionGrade(task({ proposedGrade: "routine", expectedPaths: [
    "lib/ordinary.ts", "components/ordinary.tsx", "tests/ordinary.test.mjs",
  ] })), "advanced");
  for (const taskRole of ["operate", "review", "unrecognised"]) {
    assert.equal(deriveAmuxExecutionGrade(task({ taskRole, proposedGrade: "routine" })), "advanced");
  }
});

test("one leading dot-slash is allowed, but every invalid repository path is refused", () => {
  assert.equal(normalizeAmuxExecutionPath("./lib/Ordinary.ts"), "lib/Ordinary.ts");
  assert.equal(normalizeAmuxExecutionPath("docs/a:b.md"), "docs/a:b.md");
  assert.equal(classifyAmuxExecutionPath("docs/a:b.md"), "ordinary");
  for (const path of [
    "", "./", "././lib/file.ts", ".", "..", "lib/./file.ts", "lib/../file.ts",
    "lib//file.ts", "lib/file.ts/", "/lib/file.ts", "C:/lib/file.ts", "C:lib/file.ts",
    "lib/D:/file.ts", "lib\\file.ts", "lib/file\u0000.ts", "lib/file\u001f.ts",
    "lib/file\u007f.ts", "lib/file\u0085.ts", "lib/amux\u200b/x.ts", "lib/\u202efoo.ts", 42, null,
  ]) {
    assert.equal(normalizeAmuxExecutionPath(path), null, JSON.stringify(path));
    assert.equal(classifyAmuxExecutionPath(path), "invalid", JSON.stringify(path));
  }
});

test("contract matching ignores case and preserves directory versus filename prefix semantics", () => {
  assert.equal(classifyAmuxExecutionPath("./LIB/AMUX/Execution.ts"), "contract");
  assert.equal(classifyAmuxExecutionPath("LIB/CREDITLedger.ts"), "contract");
  assert.equal(classifyAmuxExecutionPath("COMPONENTS/SETTINGS/panel.tsx"), "contract");
  assert.equal(classifyAmuxExecutionPath("components/settings-extra/panel.tsx"), "ordinary");
  assert.equal(classifyAmuxExecutionPath("app/api/BILLING/checkout-flow/route.ts"), "ordinary");
});

test("every approved contract prefix still names files in the tracked tree", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\0").filter(Boolean);
  assert.equal(new Set(AMUX_CONTRACT_PATHS).size, AMUX_CONTRACT_PATHS.length);
  for (const entry of AMUX_CONTRACT_PATHS) {
    const isPrefix = entry.endsWith("/") || posix.extname(entry) === "";
    assert.ok(
      isPrefix ? tracked.some((path) => path.startsWith(entry)) : tracked.includes(entry),
      `contract path has no tracked file: ${entry}`,
    );
  }
});

test("the contract-path table matches the approved v52 list", () => {
  const policy = readFileSync(new URL("../docs/policy/development-agent-orchestration.md", import.meta.url), "utf8");
  const section = /\n목록:\r?\n([\s\S]*?)\r?\n넣지 않은 것과 이유:/.exec(policy);
  assert.ok(section, "v52 contract-path list must be present");
  const listed = [...new Set([...section[1].matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((path) => path !== "lib/emailTypography.ts"))]; // Covered by lib/email, not listed separately.
  assert.deepEqual([...AMUX_CONTRACT_PATHS].sort(), listed.sort());
});

test("distribution report reads proposals and prints counts without their paths", () => {
  const inputFile = join(tmpdir(), `amux-grades-${randomUUID()}.json`);
  writeFileSync(inputFile, JSON.stringify([
    task({ proposedGrade: "routine", expectedPaths: ["private-path-marker.ts"] }),
    task({ proposedGrade: "routine", expectedPaths: ["lib/amux/private-path-marker.ts"] }),
    task({ proposedGrade: "advanced" }),
  ]), { flag: "wx" });
  try {
    const run = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/report-amux-execution-grades.mjs", "--input", inputFile,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      total: 3,
      proposed: { routine: 2, advanced: 1, frontier: 0, unknown: 0 },
      derived: { routine: 1, advanced: 1, frontier: 1 },
      transitions: { "routine->routine": 1, "routine->frontier": 1, "advanced->advanced": 1 },
    });
    assert.equal(run.stdout.includes("private-path-marker"), false);
    writeFileSync(inputFile, "{private-path-marker");
    const invalid = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/report-amux-execution-grades.mjs", "--input", inputFile,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stderr.includes("private-path-marker"), false);
  } finally {
    unlinkSync(inputFile);
  }
});
