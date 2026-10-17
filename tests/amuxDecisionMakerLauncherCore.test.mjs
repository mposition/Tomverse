// The AMUX Decision Maker launcher's deterministic core, stage S2-3a
// (docs/policy/amux-decision-maker.md policy version 2, §5 and §5a).
//
// The first block reads §5a's own text and compares it with the launcher's
// constants: changing the policy without the launcher, or the launcher without
// the policy, fails here. The rest fixes the plan, the command check (every
// refused flag of §5a mixed in is refused), the execution digest, the output
// schema against §6's schema, the transmission-intent gate and the result
// classification.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amuxCanonicalJson } from "../lib/amux/boardImportCore.ts";
import { dmPayloadDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import { dmOutputSchema, validateDmOutput } from "../lib/amux/decisionMakerCore.ts";
import {
  DM_ARGV_OUTPUT_FILE,
  DM_ARGV_REQUEST_DIRECTORY,
  DM_ARGV_SCHEMA_FILE,
  DM_ARGV_SCHEMA_JSON,
  DM_CLAUDE_REFUSED_ARGV,
  DM_CODEX_REFUSED_ARGV,
  DM_LAUNCHER_POLICY_VERSION,
  DM_LAUNCHER_SPECS,
  DM_LAUNCH_OUTPUT_MAX_BYTES,
  DM_LAUNCH_REFUSALS,
  DM_LAUNCH_UNAVAILABLE_REASONS,
  DM_OUTPUT_SCHEMA_JSON,
  DM_OUTPUT_SCHEMA_PATH,
  DM_OUTPUT_SCHEMA_SHA256,
  DM_RECORDED_EXECUTION_DIGESTS,
  dmAppResultKindFor,
  dmClassifyProcess,
  dmCommandRefusals,
  dmExecutionDigest,
  dmExecutionDigestCanonical,
  dmExecutionDigestInput,
  dmExecutionPlan,
  dmFixedEnvironment,
  dmForbiddenArgv,
  dmStateTargets,
  dmTransmitIntentRefusal,
  dmUnwrappedOutput,
} from "../lib/amux/decisionMakerLauncherCore.ts";
import { DM_INSTANCE_SCOPES } from "../lib/amux/decisionMakerSwitchCore.ts";

const OPENAI = "decision-maker-openai";
const ANTHROPIC = "decision-maker-anthropic";

// ---------------------------------------------------------------------------
// §5a, read from the policy
// ---------------------------------------------------------------------------

const policy = readFileSync(new URL("../docs/policy/amux-decision-maker.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const section5a = policy.slice(policy.indexOf("\n## 5a."), policy.indexOf("\n## 6."));
const without = (record, key) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
const spans = (text) => [...text.matchAll(/`([^`]*)`/g)].map((match) => match[1]);
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `policy text has ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `policy text has ${end} after ${start}`);
  return text.slice(from + start.length, to);
};

test("§5a is policy version 2, the version this launcher implements", () => {
  assert.match(policy, /정책 버전: 2\n/);
  assert.equal(DM_LAUNCHER_POLICY_VERSION, 2);
});

test("§5a fixed argv: each CLI's argv is the policy's tokens, in order", () => {
  const block = between(section5a, "```text\n", "\n```");
  const placeholders = [DM_ARGV_REQUEST_DIRECTORY, DM_ARGV_OUTPUT_FILE, DM_ARGV_SCHEMA_FILE, DM_ARGV_SCHEMA_JSON];
  let sealed = block;
  placeholders.forEach((placeholder, index) => {
    assert.ok(sealed.includes(placeholder), `the block names ${placeholder}`);
    sealed = sealed.split(placeholder).join(`\u0001${index}\u0001`);
  });
  const tokens = sealed
    .split(/\s+/)
    .filter((token) => token !== "")
    .map((token) => (token === '""' ? "" : token.replace(/\u0001(\d)\u0001/g, (_, index) => placeholders[Number(index)])));
  const claudeAt = tokens.indexOf("claude");
  assert.equal(tokens[0], "codex");
  assert.ok(claudeAt > 0);
  assert.deepEqual(tokens.slice(0, claudeAt), ["codex", ...DM_LAUNCHER_SPECS[OPENAI].argv]);
  assert.deepEqual(tokens.slice(claudeAt), ["claude", ...DM_LAUNCHER_SPECS[ANTHROPIC].argv]);
  // The question goes on stdin only: codex reads `-`, claude's `-p` has no prompt argument.
  assert.equal(DM_LAUNCHER_SPECS[OPENAI].argv.at(-1), "-");
});

test("§5a executables: instance, CLI version and sha256 are the policy table's", () => {
  const rows = [...section5a.matchAll(/^\| `(decision-maker-[a-z]+)` \| [^|]+ \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map(
    (match) => ({ instance: match[1], cliVersion: match[2], executableSha256: match[3] }),
  );
  assert.deepEqual(
    rows,
    DM_INSTANCE_SCOPES.map((instance) => ({
      instance,
      cliVersion: DM_LAUNCHER_SPECS[instance].cliVersion,
      executableSha256: DM_LAUNCHER_SPECS[instance].executableSha256,
    })),
  );
});

test("§5a fixed environment: the four variables, HOME the S0 account's home", () => {
  const line = section5a.split("\n").find((entry) => entry.startsWith("**고정 환경.**"));
  assert.deepEqual(spans(line), ["HOME=<그 공급사 계정의 홈>", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"]);
  assert.deepEqual(
    dmFixedEnvironment(OPENAI).map(([name, value]) => `${name}=${value}`),
    ["HOME=/home/amux-dm-openai", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"],
  );
  assert.equal(dmFixedEnvironment(ANTHROPIC)[0][1], "/home/amux-dm-anthropic");
  // The homes S0 created (useradd --home-dir "/home/$u").
  const isolation = readFileSync(
    new URL(
      "../docs/ops/amux/decision-maker-s0-records/2026-10-13__a3f51403afccf147442f7c2ca7eeb4ccf97b8068.md",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(isolation, /useradd --system --create-home --home-dir "\/home\/\$u"/);
  assert.match(isolation, /\/home\/amux-dm-openai\/\.local\/bin\/codex/);
  assert.match(isolation, /\/home\/amux-dm-anthropic\/\.local\/bin\/claude/);
});

test("§5a state deletion: the delete and keep lists are the policy's", () => {
  const targets = spans(between(section5a, "대상은 ", "다.\n"));
  assert.deepEqual(targets, ["~/.codex/", "~/.claude/", "~/.claude.json", "~/.cache/claude/", "~/.local/state/claude/"]);
  assert.deepEqual([...DM_LAUNCHER_SPECS[OPENAI].stateDelete], targets.slice(0, 1));
  assert.deepEqual([...DM_LAUNCHER_SPECS[ANTHROPIC].stateDelete], targets.slice(1));
  const keep = spans(between(section5a, "**남김 목록은 인증 파일뿐이다.**", "CLI가"));
  assert.deepEqual(keep, ["~/.codex/auth.json", "~/.claude/.credentials.json"]);
  assert.deepEqual([...DM_LAUNCHER_SPECS[OPENAI].stateKeep], keep.slice(0, 1));
  assert.deepEqual([...DM_LAUNCHER_SPECS[ANTHROPIC].stateKeep], keep.slice(1));
  assert.deepEqual(dmStateTargets(OPENAI), [{ kind: "directory_keeping", path: ".codex", keep: ["auth.json"] }]);
  assert.deepEqual(dmStateTargets(ANTHROPIC), [
    { kind: "directory_keeping", path: ".claude", keep: [".credentials.json"] },
    { kind: "whole", path: ".claude.json" },
    { kind: "whole", path: ".cache/claude" },
    { kind: "whole", path: ".local/state/claude" },
  ]);
});

test("§5a refused argv: the launcher's lists are the policy's, entry for entry", () => {
  const paragraph = between(section5a, "**거부 argv.**", "**고정 환경.**");
  const codex = spans(between(paragraph, "codex:", "claude:"));
  const claude = spans(paragraph.slice(paragraph.indexOf("claude:")));
  assert.deepEqual(codex, [...DM_CODEX_REFUSED_ARGV]);
  // `""` is the one value `--tools` may have, named in "`""` 밖의 `--tools`".
  assert.ok(paragraph.includes('`""` 밖의 `--tools`'));
  assert.deepEqual(
    claude.filter((entry) => entry !== '""'),
    [...DM_CLAUDE_REFUSED_ARGV],
  );
});

// ---------------------------------------------------------------------------
// The plan and the command check
// ---------------------------------------------------------------------------

const codexPaths = {
  requestDirectory: "/var/lib/amux-dm/requests/r1",
  temporaryDirectory: "/var/lib/amux-dm/scratch/codex/r1",
  outputFile: "/var/lib/amux-dm/scratch/codex/r1/last-message.json",
};
const claudePaths = {
  requestDirectory: "/var/lib/amux-dm/requests/r2",
  temporaryDirectory: "/var/lib/amux-dm/scratch/claude/r2",
  outputFile: null,
};

const planFor = (instance, paths) => {
  const planned = dmExecutionPlan(instance, paths);
  assert.equal(planned.ok, true);
  return planned.plan;
};
const commandOf = (plan, overrides = {}) => ({
  executable: plan.executable,
  argv: plan.argv,
  environment: plan.environment,
  ...overrides,
});

test("the plan is §5a's argv with the schema and the request's two paths, and nothing else", () => {
  const codex = planFor(OPENAI, codexPaths);
  assert.equal(codex.executable, "/opt/tomverse-amux-dm/codex-cli-0.162.1/codex");
  assert.equal(codex.argv[0], codex.executable);
  assert.deepEqual(
    codex.argv.slice(1),
    DM_LAUNCHER_SPECS[OPENAI].argv.map((token) =>
      ({
        [DM_ARGV_SCHEMA_FILE]: DM_OUTPUT_SCHEMA_PATH,
        [DM_ARGV_OUTPUT_FILE]: codexPaths.outputFile,
        [DM_ARGV_REQUEST_DIRECTORY]: codexPaths.requestDirectory,
      })[token] ?? token,
    ),
  );
  assert.equal(codex.workingDirectory, codexPaths.requestDirectory);
  const claude = planFor(ANTHROPIC, claudePaths);
  assert.equal(claude.argv[claude.argv.indexOf("--json-schema") + 1], DM_OUTPUT_SCHEMA_JSON);
  assert.equal(claude.workingDirectory, claudePaths.requestDirectory);
  assert.ok(!claude.argv.some((token) => token.includes(claudePaths.temporaryDirectory)));
  assert.deepEqual(dmCommandRefusals(codex, commandOf(codex)), []);
  assert.deepEqual(dmCommandRefusals(claude, commandOf(claude)), []);
  assert.deepEqual(dmForbiddenArgv("codex", codex.argv), []);
  assert.deepEqual(dmForbiddenArgv("claude", claude.argv), []);
});

test("the plan refuses an unknown instance and any path that is not one clean absolute path", () => {
  assert.deepEqual(dmExecutionPlan("decision-maker-gemini", codexPaths), { ok: false, refusal: "instance_unknown" });
  const invalid = (instance, paths) => assert.deepEqual(dmExecutionPlan(instance, paths), { ok: false, refusal: "request_paths_invalid" }, JSON.stringify(paths));
  for (const bad of ["relative/r1", "/var/lib/../r1", "/var/./r1", "/var//r1", "/var/r1/", "/", "/var/r\n1", "/var/r\u00001", "", null, 7]) {
    invalid(OPENAI, { ...codexPaths, requestDirectory: bad });
    invalid(OPENAI, { ...codexPaths, temporaryDirectory: bad });
  }
  // -o lives directly in the vendor account's temporary directory.
  invalid(OPENAI, { ...codexPaths, outputFile: "/var/lib/amux-dm/requests/r1/out.json" });
  invalid(OPENAI, { ...codexPaths, outputFile: "/var/lib/amux-dm/scratch/codex/r1/sub/out.json" });
  invalid(OPENAI, { ...codexPaths, outputFile: null });
  invalid(ANTHROPIC, { ...claudePaths, outputFile: "/var/lib/amux-dm/scratch/claude/r2/out.json" });
  // The two directories are disjoint.
  invalid(OPENAI, { ...codexPaths, temporaryDirectory: "/var/lib/amux-dm/requests/r1/tmp", outputFile: "/var/lib/amux-dm/requests/r1/tmp/o" });
  invalid(ANTHROPIC, { ...claudePaths, temporaryDirectory: claudePaths.requestDirectory });
  // Both directories are deleted whole: neither may be or hold the home, the executable or the schema.
  for (const directory of ["/home/amux-dm-openai", "/home", "/opt/tomverse-amux-dm", "/opt"]) {
    invalid(OPENAI, { ...codexPaths, requestDirectory: directory });
    invalid(OPENAI, { ...codexPaths, temporaryDirectory: directory, outputFile: `${directory}/o.json` });
  }
  invalid(ANTHROPIC, { ...claudePaths, temporaryDirectory: "/home/amux-dm-anthropic" });
  // The account's own temporary directory may live inside its home.
  assert.equal(
    dmExecutionPlan(OPENAI, { ...codexPaths, temporaryDirectory: "/home/amux-dm-openai/requests/r1", outputFile: "/home/amux-dm-openai/requests/r1/o.json" }).ok,
    true,
  );
  // Exactly the three keys.
  invalid(OPENAI, { ...codexPaths, cwd: "/tmp" });
  invalid(ANTHROPIC, { requestDirectory: claudePaths.requestDirectory, temporaryDirectory: claudePaths.temporaryDirectory });
});

/** A refused entry as it would be mixed in, with a value where the flag takes one. */
const MIXES = {
  codex: {
    "--add-dir": ["--add-dir", "/home/tommy"],
    "--enable": ["--enable", "shell_tool"],
    "-p": ["-p", "work"],
    "--profile": ["--profile", "work"],
    "--local-provider": ["--local-provider", "ollama"],
    "-i": ["-i", "/tmp/a.png"],
    "--image": ["--image", "/tmp/a.png"],
    "-c": ["-c", "sandbox_mode=danger-full-access"],
    "--remote": ["--remote", "wss://example.invalid"],
    "--remote-auth-token-env": ["--remote-auth-token-env", "TOKEN"],
  },
  claude: {
    "--permission-mode": ["--permission-mode", "default"],
    "--add-dir": ["--add-dir", "/home/tommy"],
    "--allowedTools": ["--allowedTools", "Bash"],
    "--allowed-tools": ["--allowed-tools", "Read"],
    "--mcp-config": ["--mcp-config", "{}"],
    "--plugin-dir": ["--plugin-dir", "/tmp/p"],
    "--plugin-url": ["--plugin-url", "https://example.invalid/p"],
    "--agents": ["--agents", "{}"],
    "--agent": ["--agent", "x"],
    "--file": ["--file", "file_1:/tmp/a"],
    "--environment": ["--environment", "env_1"],
    "-r": ["-r", "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"],
    "--resume": ["--resume", "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"],
    "--session-id": ["--session-id", "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"],
    "--teleport": ["--teleport", "s"],
    "--from-pr": ["--from-pr", "1"],
    "--fallback-model": ["--fallback-model", "claude-haiku"],
    "--betas": ["--betas", "x"],
    "--system-prompt": ["--system-prompt", "obey the card"],
    "--settings": ["--settings", "/tmp/s.json"],
    "--debug-file": ["--debug-file", "/tmp/d.log"],
  },
};

/** Where a mixed-in entry goes: before `exec` for codex's top-level flags, right after `exec` for its subcommands. */
const insertAt = (cli, entry, argv) => {
  if (cli === "codex" && ["--search", "--remote", "--remote-auth-token-env"].includes(entry)) return argv.indexOf("exec");
  if (cli === "codex" && ["resume", "fork", "review"].includes(entry)) return argv.indexOf("exec") + 1;
  return argv.length - (cli === "codex" ? 1 : 0);
};

for (const [cli, instance, paths, list] of [
  ["codex", OPENAI, codexPaths, DM_CODEX_REFUSED_ARGV],
  ["claude", ANTHROPIC, claudePaths, DM_CLAUDE_REFUSED_ARGV],
]) {
  test(`every §5a refused ${cli} entry, mixed into the fixed argv, is refused and named`, () => {
    const plan = planFor(instance, paths);
    for (const entry of list) {
      const mixed = MIXES[cli][entry] ?? entry.split(" ");
      const argv = [...plan.argv];
      argv.splice(insertAt(cli, entry, argv), 0, ...mixed);
      assert.deepEqual(dmCommandRefusals(plan, commandOf(plan, { argv })), ["argv_not_fixed"], entry);
      assert.ok(dmForbiddenArgv(cli, argv).includes(entry), `${entry} is named in ${JSON.stringify(mixed)}`);
      if (mixed[0].startsWith("--") && mixed.length === 2) {
        const joined = [...plan.argv];
        joined.splice(insertAt(cli, entry, joined), 0, `${mixed[0]}=${mixed[1]}`);
        assert.deepEqual(dmCommandRefusals(plan, commandOf(plan, { argv: joined })), ["argv_not_fixed"], `${entry}=`);
        assert.ok(dmForbiddenArgv(cli, joined).includes(entry), `${entry}= is named`);
      }
    }
  });
}

test("codex: the sandbox value and claude's --tools value are refused when changed in place", () => {
  const codex = planFor(OPENAI, codexPaths);
  for (const value of ["workspace-write", "danger-full-access"]) {
    const argv = codex.argv.map((token, index) => (index === codex.argv.indexOf("read-only") ? value : token));
    assert.deepEqual(dmCommandRefusals(codex, commandOf(codex, { argv })), ["argv_not_fixed"]);
    assert.deepEqual(dmForbiddenArgv("codex", argv), [`-s ${value}`]);
  }
  const claude = planFor(ANTHROPIC, claudePaths);
  for (const value of ["Bash", "default", "Read,Write"]) {
    const argv = claude.argv.map((token, index) => (index === claude.argv.indexOf("--tools") + 1 ? value : token));
    assert.deepEqual(dmCommandRefusals(claude, commandOf(claude, { argv })), ["argv_not_fixed"]);
    assert.deepEqual(dmForbiddenArgv("claude", argv), ["--tools"]);
  }
  for (const value of ["default", "acceptEdits", "bypassPermissions", "plan"]) {
    assert.deepEqual(dmForbiddenArgv("claude", [...claude.argv, "--permission-mode", value]), ["--permission-mode"]);
  }
});

test("any other difference in the argv is refused: order, a dropped or doubled token, another model or path", () => {
  const plan = planFor(OPENAI, codexPaths);
  const variants = [
    plan.argv.slice(0, -1),
    [...plan.argv, "-"],
    plan.argv.map((token) => (token === "gpt-6-astra" ? "gpt-6-sol" : token)),
    plan.argv.map((token) => (token === DM_OUTPUT_SCHEMA_PATH ? "/home/amux-dm-openai/schema.json" : token)),
    plan.argv.map((token) => (token === codexPaths.requestDirectory ? "/home/tommy/Tomverse" : token)),
    [plan.argv[0], ...plan.argv.slice(1).reverse()],
    plan.argv.filter((token) => token !== "--ephemeral"),
    plan.argv.map((token) => (token === "--ignore-user-config" ? "--ignore-user-config " : token)),
  ];
  for (const argv of variants) assert.deepEqual(dmCommandRefusals(plan, commandOf(plan, { argv })), ["argv_not_fixed"]);
  const claude = planFor(ANTHROPIC, claudePaths);
  const schemaAt = claude.argv.indexOf("--json-schema") + 1;
  const loosened = claude.argv.map((token, index) => (index === schemaAt ? token.replace('"additionalProperties":false,', "") : token));
  assert.deepEqual(dmCommandRefusals(claude, commandOf(claude, { argv: loosened })), ["argv_not_fixed"]);
});

test("the executable is the root-owned copy, never the account's own", () => {
  const plan = planFor(OPENAI, codexPaths);
  for (const executable of ["/home/amux-dm-openai/.local/bin/codex", "codex", "/usr/bin/codex"]) {
    assert.deepEqual(dmCommandRefusals(plan, commandOf(plan, { executable })), ["executable_not_fixed"]);
  }
});

test("§5a: an environment other than the four fixed values is refused", () => {
  const plan = planFor(ANTHROPIC, claudePaths);
  const fixed = plan.environment;
  const variants = [
    [...fixed, ["LD_PRELOAD", "/tmp/x.so"]],
    [...fixed, ["HTTPS_PROXY", "http://127.0.0.1:9"]],
    [...fixed, ["NO_PROXY", ""]],
    [...fixed, ["CLAUDE_CONFIG_DIR", "/tmp/c"]],
    [...fixed, ["CODEX_HOME", "/tmp/c"]],
    [...fixed, ["ANTHROPIC_BASE_URL", "https://example.invalid"]],
    [...fixed, ["NODE_OPTIONS", "--require /tmp/x.js"]],
    fixed.filter(([name]) => name !== "LC_ALL"),
    fixed.map(([name, value]) => [name, name === "HOME" ? "/home/tommy" : value]),
    fixed.map(([name, value]) => [name, name === "PATH" ? "/usr/local/bin:/usr/bin:/bin" : value]),
    fixed.map(([name, value]) => [name, name === "LANG" ? "en_US.UTF-8" : value]),
    [...fixed.slice(0, 3), ["HOME", "/home/amux-dm-anthropic"]],
    [],
  ];
  for (const environment of variants) {
    assert.deepEqual(dmCommandRefusals(plan, commandOf(plan, { environment })), ["environment_not_fixed"], JSON.stringify(environment));
  }
  // Order does not matter; the set does.
  assert.deepEqual(dmCommandRefusals(plan, commandOf(plan, { environment: [...fixed].reverse() })), []);
  // The account's home belongs to its own instance.
  const openai = planFor(OPENAI, codexPaths);
  assert.deepEqual(dmCommandRefusals(openai, commandOf(openai, { environment: plan.environment })), ["environment_not_fixed"]);
});

// ---------------------------------------------------------------------------
// The execution digest
// ---------------------------------------------------------------------------

test("§5a execution digest: the recorded values are fixed here, and the code computes them", () => {
  assert.deepEqual(DM_RECORDED_EXECUTION_DIGESTS, {
    "decision-maker-openai": "298a51e122f436d683baebd465179f8c8ffc216fadbb5b9223f8c4212ea4a82a",
    "decision-maker-anthropic": "9c96b86efbac49a52903b4edcc1f4cc253a36b4678a9394a20ea01d91a3744f4",
  });
  for (const instance of DM_INSTANCE_SCOPES) {
    assert.equal(dmExecutionDigest(instance), DM_RECORDED_EXECUTION_DIGESTS[instance], instance);
    // sha256 over amux-json-v1, with no prefix.
    const canonical = amuxCanonicalJson(dmExecutionDigestInput(instance));
    assert.equal(canonical, dmExecutionDigestCanonical(instance));
    assert.equal(createHash("sha256").update(canonical, "utf8").digest("hex"), DM_RECORDED_EXECUTION_DIGESTS[instance]);
  }
});

test("§5a execution digest input: exactly the policy's six values, with the two per-request paths as placeholders", () => {
  const input = dmExecutionDigestInput(OPENAI);
  assert.deepEqual(Object.keys(input).sort(), ["argv", "environment", "executable", "instance", "schemaSha256", "stateDeletion"]);
  assert.deepEqual(input.executable, {
    path: "/opt/tomverse-amux-dm/codex-cli-0.162.1/codex",
    sha256: "628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1",
  });
  assert.equal(input.schemaSha256, DM_OUTPUT_SCHEMA_SHA256);
  assert.ok(input.argv.includes(DM_ARGV_REQUEST_DIRECTORY));
  assert.ok(input.argv.includes(DM_ARGV_OUTPUT_FILE));
  assert.ok(input.argv.includes(DM_OUTPUT_SCHEMA_PATH));
  assert.ok(!input.argv.includes(DM_ARGV_SCHEMA_FILE));
  assert.deepEqual(input.environment, { HOME: "/home/amux-dm-openai", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
  assert.deepEqual(input.stateDeletion, { delete: ["~/.codex/"], keep: ["~/.codex/auth.json"] });
  const claude = dmExecutionDigestInput(ANTHROPIC);
  assert.equal(claude.argv[claude.argv.indexOf("--json-schema") + 1], DM_OUTPUT_SCHEMA_JSON);
  assert.ok(claude.argv.every((token) => token !== DM_ARGV_SCHEMA_JSON));
  // Two instances, two digests.
  assert.notEqual(dmExecutionDigest(OPENAI), dmExecutionDigest(ANTHROPIC));
});

// ---------------------------------------------------------------------------
// §6's schema, as the CLIs get it
// ---------------------------------------------------------------------------

test("the output schema is §6's three kinds under one `output` property, and its sha256 is fixed", () => {
  assert.equal(DM_OUTPUT_SCHEMA_SHA256, "11cfb4a3e73ce61bb036c5da6547f3b13e2ed9259c41427afa56ec1bc00d41b7");
  assert.equal(createHash("sha256").update(DM_OUTPUT_SCHEMA_JSON, "utf8").digest("hex"), DM_OUTPUT_SCHEMA_SHA256);
  const schema = JSON.parse(DM_OUTPUT_SCHEMA_JSON);
  // Compact: the file's bytes are the argv token's bytes.
  assert.equal(JSON.stringify(schema), DM_OUTPUT_SCHEMA_JSON);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["output"]);
  assert.deepEqual(Object.keys(schema.properties), ["output"]);
  const branches = schema.properties.output.anyOf;
  const options = dmOutputSchema.options;
  assert.equal(branches.length, options.length);
  options.forEach((option, index) => {
    const branch = branches[index];
    const keys = Object.keys(option.shape);
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(Object.keys(branch.properties), keys);
    assert.deepEqual(branch.required, keys);
    assert.deepEqual(branch.properties.kind, { type: "string", enum: [option.shape.kind.value] });
    for (const key of keys.filter((name) => name !== "kind")) {
      assert.deepEqual(branch.properties[key], { type: key === "irreversible" ? "boolean" : "string" }, key);
    }
  });
  // Only the keywords strict structured output accepts everywhere.
  const keywords = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key !== "properties") keywords.add(key);
        else Object.values(value).forEach(walk);
        if (key !== "properties") walk(value);
      }
    }
  };
  walk(schema);
  assert.deepEqual([...keywords].sort(), ["additionalProperties", "anyOf", "enum", "required", "type"]);
});

test("unwrapping: the wrapper's value is the §6 output; anything else goes whole to the app's validation", () => {
  const select = { kind: "select", optionId: "b", rationale: "Smaller change.", irreversible: false };
  assert.equal(dmUnwrappedOutput({ output: select }), JSON.stringify(select));
  assert.equal(validateDmOutput(JSON.parse(dmUnwrappedOutput({ output: select })), ["a", "b"]).outcome, "proposal");
  for (const value of [select, { output: select, extra: 1 }, [select], "text", null, { Output: select }]) {
    const raw = dmUnwrappedOutput(value);
    assert.equal(raw, JSON.stringify(value));
    assert.equal(validateDmOutput(JSON.parse(raw), ["a", "b"]).outcome, value === select ? "proposal" : "validation_failure");
  }
});

// ---------------------------------------------------------------------------
// The transmission intent
// ---------------------------------------------------------------------------

const KEY = Buffer.alloc(32, 7);
const PAYLOAD = Buffer.from("A synthetic question.\n", "utf8");
const evidence = (overrides = {}) => ({
  requestId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  instance: OPENAI,
  recorded: true,
  eventId: "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
  inputPayloadDigest: dmPayloadDigest(KEY, PAYLOAD),
  ...overrides,
});

test("§10: the intent recorded for these exact bytes is the only permission to start", () => {
  assert.equal(dmTransmitIntentRefusal(OPENAI, evidence(), KEY, PAYLOAD), null);
  const missing = [
    undefined,
    null,
    true,
    {},
    [],
    evidence({ recorded: false }),
    evidence({ recorded: "true" }),
    evidence({ eventId: "" }),
    evidence({ requestId: "r1" }),
    evidence({ inputPayloadDigest: "ab" }),
    evidence({ inputPayloadDigest: dmPayloadDigest(KEY, PAYLOAD).toUpperCase() }),
    { ...evidence(), extra: 1 },
    without(evidence(), "recorded"),
  ];
  for (const value of missing) assert.equal(dmTransmitIntentRefusal(OPENAI, value, KEY, PAYLOAD), "transmit_intent_missing", JSON.stringify(value));
  // Without the request key nothing can be checked.
  assert.equal(dmTransmitIntentRefusal(OPENAI, evidence(), undefined, PAYLOAD), "transmit_intent_missing");
  assert.equal(dmTransmitIntentRefusal(OPENAI, evidence(), Buffer.alloc(31), PAYLOAD), "transmit_intent_missing");
  // Another instance's intent, other bytes, another key.
  assert.equal(dmTransmitIntentRefusal(ANTHROPIC, evidence(), KEY, PAYLOAD), "transmit_intent_mismatch");
  assert.equal(dmTransmitIntentRefusal(OPENAI, evidence(), KEY, Buffer.from("A synthetic question!\n")), "transmit_intent_mismatch");
  assert.equal(dmTransmitIntentRefusal(OPENAI, evidence(), Buffer.alloc(32, 8), PAYLOAD), "transmit_intent_mismatch");
  assert.equal(dmTransmitIntentRefusal(OPENAI, evidence(), KEY, Buffer.concat([PAYLOAD, Buffer.from("x")])), "transmit_intent_mismatch");
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const lines = (...events) => Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
const ran = (overrides = {}) => ({
  spawned: true,
  timedOut: false,
  exitCode: 0,
  signal: null,
  stdinFailed: false,
  stdout: Buffer.alloc(0),
  stdoutTruncated: false,
  stdoutClosed: true,
  outputFile: null,
  ...overrides,
});
const select = { kind: "select", optionId: "b", rationale: "Smaller change.", irreversible: false };
const file = (value) => ({ state: "read", bytes: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) });
const codexOk = (overrides = {}) =>
  ran({ stdout: lines({ type: "thread.started" }, { type: "turn.completed" }), outputFile: file({ output: select }), ...overrides });

test("§5a codex: the result is the -o file only; exit code 1 or turn.failed is no result", () => {
  assert.deepEqual(dmClassifyProcess("codex", codexOk()), { outcome: "output", raw: JSON.stringify(select) });
  // Two agent messages in the stream (S0 t2) change nothing: the stream is never the result.
  const twoMessages = lines(
    { type: "item.completed", item: { type: "agent_message", text: '{"output":{"kind":"escalate","reason":"x"}}' } },
    { type: "item.completed", item: { type: "agent_message", text: "{}" } },
    { type: "turn.completed" },
  );
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ stdout: twoMessages })), { outcome: "output", raw: JSON.stringify(select) });
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ exitCode: 1 })), { outcome: "unavailable", reason: "exit_code_1" });
  assert.deepEqual(
    dmClassifyProcess("codex", codexOk({ stdout: lines({ type: "turn.started" }, { type: "turn.failed", error: {} }) })),
    { outcome: "unavailable", reason: "turn_failed" },
  );
  assert.deepEqual(
    dmClassifyProcess("codex", codexOk({ exitCode: 1, stdout: lines({ type: "turn.failed" }) })),
    { outcome: "unavailable", reason: "exit_code_1" },
  );
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ stdout: Buffer.from("not json\n") })), { outcome: "unavailable", reason: "event_stream_unreadable" });
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ outputFile: { state: "absent" } })), { outcome: "unavailable", reason: "result_missing" });
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ outputFile: file("  \n") })), { outcome: "unavailable", reason: "result_missing" });
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ outputFile: { state: "unreadable" } })), { outcome: "unavailable", reason: "result_unreadable" });
  assert.deepEqual(
    dmClassifyProcess("codex", codexOk({ outputFile: { state: "read", bytes: Buffer.from([0xff, 0xfe]) } })),
    { outcome: "unavailable", reason: "result_unreadable" },
  );
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ outputFile: { state: "too_large" } })), { outcome: "unavailable", reason: "output_too_large" });
  // A file that is not the wrapper, or not JSON, is the DM's schema violation: the app decides it.
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ outputFile: file("plain text") })), { outcome: "output", raw: "plain text" });
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ outputFile: file(select) })), { outcome: "output", raw: JSON.stringify(select) });
});

const claudeResult = (overrides = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"output":{"kind":"escalate","reason":"not this one"}}',
  structured_output: { output: select },
  ...overrides,
});
const claudeOk = (result = claudeResult(), overrides = {}) => ran({ stdout: Buffer.from(JSON.stringify(result)), ...overrides });

test("§5a claude: the result is structured_output only; exit code 1 or is_error:true is no result", () => {
  assert.deepEqual(dmClassifyProcess("claude", claudeOk()), { outcome: "output", raw: JSON.stringify(select) });
  assert.deepEqual(dmClassifyProcess("claude", claudeOk(claudeResult(), { exitCode: 1 })), { outcome: "unavailable", reason: "exit_code_1" });
  assert.deepEqual(
    dmClassifyProcess("claude", claudeOk(claudeResult({ is_error: true, structured_output: undefined }))),
    { outcome: "unavailable", reason: "is_error" },
  );
  assert.deepEqual(dmClassifyProcess("claude", claudeOk(claudeResult({ is_error: true }))), { outcome: "unavailable", reason: "is_error" });
  assert.deepEqual(
    dmClassifyProcess("claude", claudeOk(without(claudeResult(), "structured_output"))),
    { outcome: "unavailable", reason: "result_missing" },
  );
  assert.deepEqual(dmClassifyProcess("claude", claudeOk(claudeResult({ structured_output: null }))), { outcome: "unavailable", reason: "result_missing" });
  for (const result of [claudeResult({ type: "assistant" }), claudeResult({ is_error: "false" }), [claudeResult()]]) {
    assert.deepEqual(dmClassifyProcess("claude", claudeOk(result)), { outcome: "unavailable", reason: "result_unreadable" });
  }
  assert.deepEqual(dmClassifyProcess("claude", ran({ stdout: Buffer.alloc(0) })), { outcome: "unavailable", reason: "result_unreadable" });
  assert.deepEqual(dmClassifyProcess("claude", ran({ stdout: Buffer.from("{") })), { outcome: "unavailable", reason: "result_unreadable" });
});

test("§5a: a hard-timeout kill is a timeout; every other unclean end is no result", () => {
  for (const cli of ["codex", "claude"]) {
    const ok = cli === "codex" ? codexOk() : claudeOk();
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, timedOut: true, exitCode: null, signal: "SIGKILL" }), { outcome: "timeout" });
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, timedOut: true, exitCode: 0 }), { outcome: "timeout" });
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, spawned: false, exitCode: null }), { outcome: "unavailable", reason: "spawn_failed" });
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, exitCode: null, signal: "SIGTERM" }), { outcome: "unavailable", reason: "signal" });
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, exitCode: 2 }), { outcome: "unavailable", reason: "exit_code_other" });
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, exitCode: 124 }), { outcome: "unavailable", reason: "exit_code_other" });
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, stdinFailed: true }), { outcome: "unavailable", reason: "stdin_failed" });
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, stdoutTruncated: true }), { outcome: "unavailable", reason: "output_too_large" });
    assert.deepEqual(dmClassifyProcess(cli, { ...ok, stdoutClosed: false }), { outcome: "unavailable", reason: "stdout_not_closed" });
  }
  const huge = { ...select, rationale: "x".repeat(DM_LAUNCH_OUTPUT_MAX_BYTES) };
  assert.deepEqual(dmClassifyProcess("codex", codexOk({ outputFile: file({ output: huge }) })), { outcome: "unavailable", reason: "output_too_large" });
});

test("closed vocabularies, and what the broker submits for each outcome", () => {
  assert.equal(new Set(DM_LAUNCH_REFUSALS).size, DM_LAUNCH_REFUSALS.length);
  assert.equal(new Set(DM_LAUNCH_UNAVAILABLE_REASONS).size, DM_LAUNCH_UNAVAILABLE_REASONS.length);
  assert.equal(dmAppResultKindFor({ outcome: "output", raw: "{}" }), "output");
  assert.equal(dmAppResultKindFor({ outcome: "timeout" }), "timeout");
  assert.equal(dmAppResultKindFor({ outcome: "unavailable", reason: "exit_code_1" }), "unavailable");
  assert.equal(dmAppResultKindFor({ outcome: "refused", refusals: ["transmit_intent_missing"] }), "unavailable");
});
