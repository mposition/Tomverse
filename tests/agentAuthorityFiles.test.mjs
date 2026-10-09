import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENTS_NAMED_CONTRACT_CONSTANTS,
  CONTROL_PLANE_PATTERNS,
  CONVENTION_VERSIONS,
  KNOWN_TOP_LEVEL_DIRECTORIES,
  RESERVED_DECISION_CONSTANTS,
  classifyPath,
  compileManifestPattern,
  isCanonicalRepoPath,
  pathCarriesControlPlaneName,
  topLevelDirectory,
} from "../lib/agentAuthorityFiles.ts";

const repoRoot = new URL("..", import.meta.url);
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

test("the tree is large enough for the sweeps to mean something", () => {
  assert.ok(trackedFiles.length > 1000, `only ${trackedFiles.length} tracked files`);
});

test("every tracked path carrying an agent or AMUX name is control-plane", () => {
  const missed = trackedFiles.filter(
    (path) => pathCarriesControlPlaneName(path) && classifyPath(path) !== "control-plane",
  );
  assert.deepEqual(
    missed,
    [],
    "classify these in lib/agentAuthorityFiles.ts before merging -- the safety net found them",
  );
});

test("the known top-level directories are exactly the tree's", () => {
  const actual = [
    ...new Set(trackedFiles.map(topLevelDirectory).filter((top) => top !== null)),
  ].sort();
  assert.deepEqual(actual, [...KNOWN_TOP_LEVEL_DIRECTORIES].sort());
});

const sourceTexts = trackedFiles
  .filter((path) => /\.(?:ts|tsx|mjs|js)$/.test(path) && !path.startsWith("tests/"))
  .map((path) => [path, readFileSync(new URL(path, repoRoot), "utf8")]);

const definitionsOf = (name) => {
  const definition = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`);
  return sourceTexts.filter(([, text]) => definition.test(text)).map(([path]) => path);
};

test("every reserved decision constant is defined exactly where listed, in control-plane files", () => {
  for (const { name, definedIn } of RESERVED_DECISION_CONSTANTS) {
    assert.deepEqual(definitionsOf(name).sort(), [...definedIn].sort(), name);
    for (const path of definedIn) {
      assert.equal(classifyPath(path), "control-plane", `${name} is defined in ${path}`);
    }
  }
});

test("every constant AGENTS.md names is either a reserved decision or a named contract", () => {
  const agents = readFileSync(new URL("AGENTS.md", repoRoot), "utf8");
  const named = [...new Set([...agents.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]))];
  const definedInCode = named.filter((name) => definitionsOf(name).length > 0).sort();
  const categorised = [
    ...RESERVED_DECISION_CONSTANTS.map(({ name }) => name),
    ...AGENTS_NAMED_CONTRACT_CONSTANTS,
  ].sort();
  assert.deepEqual(
    definedInCode,
    categorised,
    "decide whether each new constant is a value reserved for a person or a contract, and list it",
  );
});

test("the recorded convention versions are the installed ones", () => {
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", repoRoot), "utf8"));
  for (const [name, version] of Object.entries(CONVENTION_VERSIONS)) {
    assert.equal(
      lock.packages[`node_modules/${name}`]?.version,
      version,
      `${name} changed: re-check the conventions the push policy relies on, then update CONVENTION_VERSIONS`,
    );
  }
});

test("classification of representative paths", () => {
  const cases = [
    ["lib/chatInput.ts", "product"],
    ["components/chat/ChatInput.tsx", "product"],
    ["locales/ko.ts", "product"],
    ["tests/chatInput.test.mjs", "product"],
    ["bin/prompt-refiner-vnext-one-shot-runner-0.1.0-candidate.3.json", "control-plane"],
    ["docs/ops/amux/staging-checklist.md", "control-plane"],
    ["vendor/amux/crates/amux-server/src/main.rs", "control-plane"],
    ["vendor/other/file.rs", "unclassified"],
    ["docs/policy/engineering-agent.md", "control-plane"],
    ["lib/amux/guard.ts", "control-plane"],
    ["lib/agentPushPolicy.ts", "control-plane"],
    ["lib/agentPushPolicy/extra.ts", "control-plane"],
    ["lib/engineeringAgentCore.ts", "control-plane"],
    ["lib/modelPricing.ts", "control-plane"],
    ["lib/adminAuthCore.ts", "control-plane"],
    ["app/api/internal/amux/claim/route.ts", "control-plane"],
    ["app/api/admin/models/route.ts", "control-plane"],
    ["app/(site)/(application)/admin/audit/page.tsx", "control-plane"],
    ["tests/integration/amux-orchestration.db.test.ts", "control-plane"],
    ["tests/server-contract/admin-amux-card-read-route.test.ts", "control-plane"],
    ["prisma/schema.prisma", "control-plane"],
    [".github/workflows/ci.yml", "control-plane"],
    [".gitattributes", "control-plane"],
    [".husky/pre-commit", "control-plane"],
    ["package.json", "control-plane"],
    ["README.md", "control-plane"],
    ["public/favicon.ico", "unclassified"],
    ["newdir/file.ts", "unclassified"],
  ];
  for (const [path, expected] of cases) assert.equal(classifyPath(path), expected, path);
});

test("paths Git would never store are unclassified, never product", () => {
  for (const path of [
    "",
    "/lib/x.ts",
    "lib\\x.ts",
    "lib/../scripts/x.mjs",
    "lib/./x.ts",
    "lib//x.ts",
    "lib/.git/config",
    "lib/.GIT/config",
    "lib/x\u0000.ts",
    "lib/x\n.ts",
  ]) {
    assert.equal(isCanonicalRepoPath(path), false, JSON.stringify(path));
    assert.equal(classifyPath(path), "unclassified", JSON.stringify(path));
  }
});

test("the pattern compiler keeps * within a segment and ** across them", () => {
  const segment = compileManifestPattern("tests/**/*-amux-*");
  assert.equal(segment.test("tests/a/b/admin-amux-x.ts"), true);
  assert.equal(segment.test("tests/admin-amux-x.ts"), true);
  assert.equal(segment.test("tests/a/admin-am/ux-x.ts"), false);
  const prefix = compileManifestPattern("lib/agent*");
  assert.equal(prefix.test("lib/agentX.ts"), true);
  assert.equal(prefix.test("lib/agents/deep/x.ts"), true);
  assert.equal(prefix.test("lib/xagent.ts"), false);
  const dir = compileManifestPattern("prisma/**");
  assert.equal(dir.test("prisma/schema.prisma"), true);
  assert.equal(dir.test("prismatic/x.ts"), false);
  for (const pattern of CONTROL_PLANE_PATTERNS) compileManifestPattern(pattern);
});
