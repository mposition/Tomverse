import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import {
  PROMPT_REFINER_SHADOW_PACKAGE_LOCK_MAX_BYTES,
  PROMPT_REFINER_SHADOW_PACKAGE_LOCK_PATH,
  PROMPT_REFINER_SHADOW_SOURCE_PATHS,
} from "../lib/promptRefinerShadowSource.ts";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "prompt-refiner-shadow-cli-"));
const checkout = join(temporary, "checkout");
const dependencyLink = join(checkout, "node_modules");
let dependenciesLinked = false;

after(() => {
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("prompt-refiner-shadow-cli-"));
  if (dependenciesLinked) {
    assert.equal(dirname(dirname(resolve(dependencyLink))), target);
    assert.ok(lstatSync(dependencyLink).isSymbolicLink());
    unlinkSync(dependencyLink);
  }
  rmSync(target, { recursive: true });
});

const cleanEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GIT_|.*API_KEY$|ANTHROPIC_AUTH_TOKEN$)/i.test(key)
    )
  ),
  GIT_ATTR_NOSYSTEM: "1",
};

mkdirSync(checkout);
const emptyHooks = join(temporary, "empty-hooks-and-template");
const emptyAttributes = join(temporary, "empty-attributes");
mkdirSync(emptyHooks);
writeFileSync(emptyAttributes, "");
const git = (args) =>
  execFileSync("git", args, {
    cwd: checkout,
    env: cleanEnvironment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
git(["init", "--quiet", `--template=${emptyHooks}`]);
for (const [key, value] of Object.entries({
  "core.autocrlf": "false",
  "core.eol": "lf",
  "core.attributesFile": emptyAttributes,
  "core.hooksPath": emptyHooks,
  "commit.gpgsign": "false",
  "user.name": "Offline Prompt Refiner Fixture",
  "user.email": "prompt-refiner-fixture@example.invalid",
})) {
  git(["config", "--local", key, value]);
}
for (const path of PROMPT_REFINER_SHADOW_SOURCE_PATHS) {
  const destination = join(checkout, path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, path), destination);
}
git(["add", "--", ...PROMPT_REFINER_SHADOW_SOURCE_PATHS]);
git(["commit", "--quiet", "--no-gpg-sign", "-m", "Synthetic offline shadow source"]);
const sourceRef = git(["rev-parse", "HEAD"]).trim();
symlinkSync(
  realpathSync(join(root, "node_modules")),
  dependencyLink,
  process.platform === "win32" ? "junction" : "dir"
);
dependenciesLinked = true;

const trap = join(temporary, "no-network.mjs");
writeFileSync(
  trap,
  `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw new Error('PROMPT_REFINER_SHADOW_NETWORK_FORBIDDEN');};
globalThis.fetch=blocked;http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;net.connect=blocked;net.createConnection=blocked;net.Socket.prototype.connect=blocked;tls.connect=blocked;dgram.createSocket=blocked;syncBuiltinESMExports();`
);

const run = (args, overrides = {}, cwd = checkout) =>
  spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      pathToFileURL(trap).href,
      "scripts/prompt-refiner-shadow-harness.mjs",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...cleanEnvironment,
        OPENAI_API_KEY: "test-only-never-read",
        ANTHROPIC_API_KEY: "test-only-never-read",
        ...overrides,
      },
    }
  );

test("CLI completes the fixed corpus under an active network trap", () => {
  const journal = join(temporary, "complete.jsonl");
  const result = run([`--journal=${journal}`, `--source-ref=${sourceRef}`]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "completed");
  assert.equal(report.processedCases, 16);
  assert.equal(report.structuralBoundaryViolations, 0);
  assert.equal(report.behavioralOutcomeMatches, 16);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.costMicroUsd, 0);
  assert.equal(report.source.sourceRef, sourceRef);
  assert.match(report.source.identityDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.sourceIdentityDigest, report.source.identityDigest);
  assert.doesNotMatch(result.stdout + result.stderr, /test-only-never-read/);
  assert.doesNotMatch(result.stdout, /sourceText|fixtureOutput|refinedPrompt/);
});

test("CLI controlled stop requires explicit resume", () => {
  const journal = join(temporary, "resume.jsonl");
  const first = run([
    `--journal=${journal}`,
    `--source-ref=${sourceRef}`,
    "--max-cases=3",
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, "stopped");
  assert.equal(JSON.parse(first.stdout).processedCases, 3);

  const withoutResume = run([`--journal=${journal}`, `--source-ref=${sourceRef}`]);
  assert.equal(withoutResume.status, 1);
  assert.match(withoutResume.stderr, /existing_journal_requires_resume/);

  const resumed = run([
    `--journal=${journal}`,
    `--source-ref=${sourceRef}`,
    "--resume",
  ]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "completed");
});

test("CLI has no live, plugin, corpus override or credential mode", () => {
  for (const args of [
    [],
    ["--live"],
    ["--provider=openai"],
    ["--plugin=untrusted.mjs"],
    ["--corpus=untrusted.json"],
    ["--adapter=untrusted.mjs"],
    ["--help", "--resume"],
    [`--journal=${join(temporary, "bad-ref.jsonl")}`, "--source-ref=HEAD"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-never-read/);
  }
  assert.equal(run(["--help"]).status, 0);
});

test("CLI accepts only unsigned ASCII decimal max-cases", () => {
  for (const [index, value] of ["0x10", "1e1", "+16", " 16", "16 "].entries()) {
    const result = run([
      `--journal=${join(temporary, `invalid-max-cases-${index}.jsonl`)}`,
      `--source-ref=${sourceRef}`,
      `--max-cases=${value}`,
    ]);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /max_cases_ascii_decimal_required/);
  }
});

test("CLI refuses exact-byte source drift including EOL-only drift", () => {
  const path = join(checkout, PROMPT_REFINER_SHADOW_SOURCE_PATHS[0]);
  const original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, `${original}\n`);
    const drift = run([
      `--journal=${join(temporary, "drift.jsonl")}`,
      `--source-ref=${sourceRef}`,
    ]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /runtime_source_drift/);
  } finally {
    writeFileSync(path, original);
  }
});

test("a normal core.autocrlf=true checkout preserves every pinned source byte", () => {
  const clone = join(temporary, "autocrlf-checkout");
  execFileSync(
    "git",
    [
      "-c",
      "core.autocrlf=true",
      "clone",
      "--quiet",
      "--no-local",
      checkout,
      clone,
    ],
    {
      cwd: temporary,
      env: cleanEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const cloneDependencies = join(clone, "node_modules");
  symlinkSync(
    realpathSync(join(root, "node_modules")),
    cloneDependencies,
    process.platform === "win32" ? "junction" : "dir"
  );
  try {
    for (const path of PROMPT_REFINER_SHADOW_SOURCE_PATHS) {
      assert.equal(readFileSync(join(clone, path), "utf8"), git(["show", `${sourceRef}:${path}`]));
    }
    const result = run(
      [
        `--journal=${join(temporary, "autocrlf.jsonl")}`,
        `--source-ref=${sourceRef}`,
      ],
      {},
      clone
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "completed");
  } finally {
    assert.ok(lstatSync(cloneDependencies).isSymbolicLink());
    unlinkSync(cloneDependencies);
  }
});

test("package-lock has a bounded dedicated cap and just-over-limit fails clearly", () => {
  const currentLockSize = lstatSync(
    join(root, PROMPT_REFINER_SHADOW_PACKAGE_LOCK_PATH)
  ).size;
  assert.ok(currentLockSize > 0);
  assert.ok(currentLockSize <= PROMPT_REFINER_SHADOW_PACKAGE_LOCK_MAX_BYTES);

  const clone = join(temporary, "package-lock-cap-checkout");
  execFileSync("git", ["clone", "--quiet", "--no-local", checkout, clone], {
    cwd: temporary,
    env: cleanEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cloneDependencies = join(clone, "node_modules");
  symlinkSync(
    realpathSync(join(root, "node_modules")),
    cloneDependencies,
    process.platform === "win32" ? "junction" : "dir"
  );
  const cloneGit = (args) =>
    execFileSync("git", args, {
      cwd: clone,
      env: cleanEnvironment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    cloneGit(["config", "--local", "user.name", "Offline Size Fixture"]);
    cloneGit(["config", "--local", "user.email", "size-fixture@example.invalid"]);
    const lockPath = join(clone, PROMPT_REFINER_SHADOW_PACKAGE_LOCK_PATH);
    const original = readFileSync(lockPath);
    const atLimit = Buffer.concat([
      original,
      Buffer.alloc(PROMPT_REFINER_SHADOW_PACKAGE_LOCK_MAX_BYTES - original.length, 0x20),
    ]);
    assert.equal(atLimit.length, PROMPT_REFINER_SHADOW_PACKAGE_LOCK_MAX_BYTES);
    writeFileSync(lockPath, atLimit);
    cloneGit(["add", "--", PROMPT_REFINER_SHADOW_PACKAGE_LOCK_PATH]);
    cloneGit(["commit", "--quiet", "--no-gpg-sign", "-m", "Package lock at exact cap"]);
    const atLimitRef = cloneGit(["rev-parse", "HEAD"]).trim();
    const accepted = run(
      [
        `--journal=${join(temporary, "package-lock-at-limit.jsonl")}`,
        `--source-ref=${atLimitRef}`,
      ],
      {},
      clone
    );
    assert.equal(accepted.status, 0, accepted.stderr);

    writeFileSync(lockPath, Buffer.concat([atLimit, Buffer.from(" ")]));
    const currentTooLarge = run(
      [
        `--journal=${join(temporary, "package-lock-current-too-large.jsonl")}`,
        `--source-ref=${atLimitRef}`,
      ],
      {},
      clone
    );
    assert.equal(currentTooLarge.status, 1);
    assert.match(currentTooLarge.stderr, /source_file_byte_limit/);

    cloneGit(["add", "--", PROMPT_REFINER_SHADOW_PACKAGE_LOCK_PATH]);
    cloneGit(["commit", "--quiet", "--no-gpg-sign", "-m", "Package lock one byte over cap"]);
    const overLimitRef = cloneGit(["rev-parse", "HEAD"]).trim();
    const anchoredTooLarge = run(
      [
        `--journal=${join(temporary, "package-lock-anchored-too-large.jsonl")}`,
        `--source-ref=${overLimitRef}`,
      ],
      {},
      clone
    );
    assert.equal(anchoredTooLarge.status, 1);
    assert.match(anchoredTooLarge.stderr, /source_file_byte_limit/);
  } finally {
    assert.ok(lstatSync(cloneDependencies).isSymbolicLink());
    unlinkSync(cloneDependencies);
  }
});

test("LF attributes cover only the pinned root source paths", () => {
  const attributeLines = new Set(
    readFileSync(join(checkout, ".gitattributes"), "utf8").split(/\r?\n/)
  );
  for (const path of [".gitattributes", "package.json", "package-lock.json", "tsconfig.json"]) {
    assert.ok(attributeLines.has(`/${path} text eol=lf`));
  }

  const sourceAttributes = new Set(
    git([
      "check-attr",
      "text",
      "eol",
      "--",
      ...PROMPT_REFINER_SHADOW_SOURCE_PATHS,
    ]).trimEnd().split(/\r?\n/)
  );
  for (const path of PROMPT_REFINER_SHADOW_SOURCE_PATHS) {
    assert.ok(sourceAttributes.has(`${path}: text: set`));
    assert.ok(sourceAttributes.has(`${path}: eol: lf`));
  }

  const nested = [
    "apps/mobile/package.json",
    "packages/chat-core/package.json",
    "packages/ui-tokens/package.json",
    "apps/mobile/tsconfig.json",
    "packages/chat-core/tsconfig.json",
  ];
  const nestedAttributes = new Set(
    git(["check-attr", "text", "eol", "--", ...nested]).trimEnd().split(/\r?\n/)
  );
  for (const path of nested) {
    assert.ok(nestedAttributes.has(`${path}: text: unspecified`));
    assert.ok(nestedAttributes.has(`${path}: eol: unspecified`));
  }
});

test("a Git replacement cannot attribute source B bytes to pinned source A", () => {
  const clone = join(temporary, "replace-object-checkout");
  execFileSync(
    "git",
    ["clone", "--quiet", "--no-local", checkout, clone],
    {
      cwd: temporary,
      env: cleanEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const cloneDependencies = join(clone, "node_modules");
  symlinkSync(
    realpathSync(join(root, "node_modules")),
    cloneDependencies,
    process.platform === "win32" ? "junction" : "dir"
  );
  const cloneGit = (args) =>
    execFileSync("git", args, {
      cwd: clone,
      env: cleanEnvironment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    cloneGit(["config", "--local", "user.name", "Offline Replace Fixture"]);
    cloneGit(["config", "--local", "user.email", "replace-fixture@example.invalid"]);
    const sourceA = cloneGit(["rev-parse", "HEAD"]).trim();
    assert.equal(sourceA, sourceRef);
    const path = join(clone, "tsconfig.json");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
    cloneGit(["add", "--", "tsconfig.json"]);
    cloneGit(["commit", "--quiet", "--no-gpg-sign", "-m", "Synthetic source B"]);
    const sourceB = cloneGit(["rev-parse", "HEAD"]).trim();
    assert.notEqual(sourceB, sourceA);
    cloneGit(["replace", sourceA, sourceB]);

    const result = run(
      [
        `--journal=${join(temporary, "replace-object.jsonl")}`,
        `--source-ref=${sourceA}`,
      ],
      { GIT_NO_REPLACE_OBJECTS: "0" },
      clone
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /runtime_source_drift/);
  } finally {
    assert.ok(lstatSync(cloneDependencies).isSymbolicLink());
    unlinkSync(cloneDependencies);
  }
});

test("a source A partial journal cannot resume under exact source B", () => {
  const journal = join(temporary, "source-bound-resume.jsonl");
  const first = run([
    `--journal=${journal}`,
    `--source-ref=${sourceRef}`,
    "--max-cases=2",
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, "stopped");
  const journalBefore = readFileSync(journal, "utf8");
  const witnessBefore = readFileSync(`${journal}.witness.jsonl`, "utf8");

  const path = join(checkout, "tsconfig.json");
  const original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, `${original}\n`);
    git(["add", "--", "tsconfig.json"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "Synthetic source B"]);
    const sourceB = git(["rev-parse", "HEAD"]).trim();
    assert.notEqual(sourceB, sourceRef);
    const resumed = run([
      `--journal=${journal}`,
      `--source-ref=${sourceB}`,
      "--resume",
    ]);
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /journal_identity|witness_identity/);
    assert.equal(readFileSync(journal, "utf8"), journalBefore);
    assert.equal(readFileSync(`${journal}.witness.jsonl`, "utf8"), witnessBefore);
  } finally {
    writeFileSync(path, original);
  }
});

test("a promisor checkout with a missing source blob fails without lazy fetch", () => {
  const corpusPath = PROMPT_REFINER_SHADOW_SOURCE_PATHS.find((path) =>
    path.endsWith("corpus-v1.json")
  );
  assert.ok(corpusPath);
  const objectId = git(["rev-parse", `${sourceRef}:${corpusPath}`]).trim();
  const gitDirectory = resolve(checkout, git(["rev-parse", "--git-dir"]).trim());
  const objectPath = join(gitDirectory, "objects", objectId.slice(0, 2), objectId.slice(2));
  const savedObjectPath = `${objectPath}.saved-for-no-lazy-fetch-test`;
  renameSync(objectPath, savedObjectPath);
  try {
    git(["config", "--local", "remote.origin.url", "https://127.0.0.1:1/no-fetch.git"]);
    git(["config", "--local", "remote.origin.promisor", "true"]);
    git(["config", "--local", "remote.origin.partialclonefilter", "blob:none"]);
    const result = run([
      `--journal=${join(temporary, "missing-promisor-blob.jsonl")}`,
      `--source-ref=${sourceRef}`,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source_object_missing_no_lazy_fetch/);
  } finally {
    renameSync(savedObjectPath, objectPath);
    git(["config", "--local", "--remove-section", "remote.origin"]);
  }
});
