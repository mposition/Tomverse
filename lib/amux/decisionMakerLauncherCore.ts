import { createHash, timingSafeEqual } from "node:crypto";

import { amuxCanonicalJson } from "./boardImportCore.ts";
import { dmPayloadDigest } from "./decisionMakerBodyCore.ts";
import { isDmDigest, isDmRequestId } from "./decisionMakerRequestCore.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker's dedicated launcher, its deterministic core:
 * docs/policy/amux-decision-maker.md policy version 2, §5 (execution, request
 * directory deletion, hard timeout) and §5a (the fixed execution conditions
 * measured in S0), stage S2-3a.
 *
 * Pure: the fixed executables, argv, environment and state-deletion lists of
 * §5a; the execution plan for one request; the execution digest (canonical
 * JSON `amux-json-v1`, sha256); the check that the command about to start is
 * byte-for-byte the planned one; the transmission-intent evidence check (no
 * DM process starts without a recorded intent whose payload digest is the
 * digest of the exact bytes on stdin, §2-4, §10); and the classification of a
 * finished process into one closed result. The filesystem half is
 * lib/amux/decisionMakerLauncherFs.ts and the process half is
 * lib/amux/decisionMakerLauncherProcess.ts.
 *
 * Every value marked §5a is the policy's and is compared with the policy text
 * by tests/amuxDecisionMakerLauncherCore.test.mjs: changing the policy without
 * this file, or this file without the policy, fails that test. The values in
 * "Installation" below are not in the policy text -- §5a names them only as
 * "root 소유 경로" -- and are the launcher's own constants, which §5a lets it
 * have ("계산은 S2-3 launcher 코드의 상수"). They enter the execution digest,
 * so changing one changes the pinned digest.
 *
 * This module never sends anything. A DM output is returned to the caller
 * (the broker), which takes it to the app route; nothing here reaches a worker
 * or a card (§1, §2-5).
 */

/** The policy version whose §5a these values are. */
export const DM_LAUNCHER_POLICY_VERSION = 2;

export type DmLauncherCli = "codex" | "claude";

// ---------------------------------------------------------------------------
// §5a: the fixed execution conditions
// ---------------------------------------------------------------------------

/** §5a's argv placeholders, verbatim. The two per-request paths stay placeholders in the digest. */
export const DM_ARGV_REQUEST_DIRECTORY = "<요청 디렉터리>";
export const DM_ARGV_OUTPUT_FILE = "<요청별 출력 파일>";
export const DM_ARGV_SCHEMA_FILE = "<스키마 파일>";
export const DM_ARGV_SCHEMA_JSON = "<스키마 JSON>";

/**
 * §5a "고정 argv", after the program name, in order. A token is a literal or
 * one of the four placeholders above. "Bytes other than the two paths must be
 * exactly these."
 */
const CODEX_ARGV = Object.freeze([
  "-a", "never", "--no-daemon", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config",
  "--skip-git-repo-check", "-s", "read-only", "--json", "--output-schema", DM_ARGV_SCHEMA_FILE,
  "-o", DM_ARGV_OUTPUT_FILE, "-m", "gpt-6-astra", "-C", DM_ARGV_REQUEST_DIRECTORY,
  "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "unified_exec_tty", "--disable", "shell_snapshot",
  "--disable", "code_mode_host", "--disable", "write_stdin_approval", "--disable", "sleep_tool", "--disable", "browser_use",
  "--disable", "browser_use_external", "--disable", "browser_use_full_cdp_access", "--disable", "browser_annotation_api",
  "--disable", "computer_use", "--disable", "in_app_browser", "--disable", "apps", "--disable", "plugins",
  "--disable", "plugin_sharing", "--disable", "remote_plugin", "--disable", "hooks",
  "--disable", "skill_mcp_dependency_install", "--disable", "skill_search", "--disable", "tool_suggest",
  "--disable", "workspace_dependencies", "--disable", "tool_call_mcp_elicitation", "--disable", "multi_agent",
  "--disable", "worktrees", "--disable", "goals", "--disable", "in_app_local_automation",
  "--disable", "image_generation", "--disable", "view_image", "--disable", "daemon_auto_start",
  "--disable", "in_app_updates", "--disable", "system_proxy_fallback", "--disable", "unbounded_connection_retries",
  "--disable", "realtime_conversation", "-",
] as const);

const CLAUDE_ARGV = Object.freeze([
  "-p", "--tools", "", "--restricted", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands",
  "--no-session-persistence", "--permission-prompts", "none", "--output-format", "json",
  "--json-schema", DM_ARGV_SCHEMA_JSON, "--model", "claude-fable-5-1",
] as const);

/**
 * §5a "거부 argv": what the launcher's tests must show is refused when mixed
 * in. The launcher refuses anything that is not the fixed argv exactly, so
 * this list is the tests' reference and the diagnostic `dmForbiddenArgv()`
 * names, not the gate. A two-token entry is a flag and its value.
 */
export const DM_CODEX_REFUSED_ARGV = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "--add-dir",
  "-s workspace-write", "-s danger-full-access", "--worktree", "--enable", "-p", "--profile", "--oss",
  "--local-provider", "--cyber-access-program", "-i", "--image", "-c", "--search", "--remote",
  "--remote-auth-token-env", "resume", "fork", "review",
] as const);

/** §5a: `--tools` is refused with any value other than `""`, `--permission-mode` with any value. */
export const DM_CLAUDE_REFUSED_ARGV = Object.freeze([
  "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode", "--add-dir",
  "--allowedTools", "--allowed-tools", "--tools", "-w", "--worktree", "--tmux", "--mcp-config", "--plugin-dir",
  "--plugin-url", "--agents", "--agent", "--file", "--chrome", "--cloud", "--environment", "--remote-control", "--ide",
  "--desktop", "--brief", "--bg", "--background", "-r", "--resume", "-c", "--continue", "--fork-session",
  "--session-id", "--teleport", "--from-pr", "--fallback-model", "--betas", "--system-prompt", "--bare", "--settings",
  "-d", "--debug", "--debug-file", "--verbose",
] as const);

/** §5a "고정 환경": these four and nothing else. HOME is the vendor account's home. */
export const DM_FIXED_PATH = "/usr/bin:/bin";
export const DM_FIXED_LOCALE = "C.UTF-8";

/**
 * §5a "공급사 계정 홈의 상태": what is deleted after every request, and the
 * one file kept (the CLI's authentication). Written as the policy writes them;
 * a trailing `/` is a directory. A kept file sits inside a deleted directory.
 */
const CODEX_STATE_DELETE = Object.freeze(["~/.codex/"] as const);
const CODEX_STATE_KEEP = Object.freeze(["~/.codex/auth.json"] as const);
const CLAUDE_STATE_DELETE = Object.freeze(["~/.claude/", "~/.claude.json", "~/.cache/claude/", "~/.local/state/claude/"] as const);
const CLAUDE_STATE_KEEP = Object.freeze(["~/.claude/.credentials.json"] as const);

// ---------------------------------------------------------------------------
// Installation (not in the policy text; see the module comment)
// ---------------------------------------------------------------------------

/**
 * The root-owned copies of the two CLIs (§5a: "공급사 계정의 홈이 아니라 root
 * 소유 경로"). The version is in the directory so a new CLI version is a new
 * path, a new sha256 and a new digest. The program's own name stays the
 * CLI's name. Proposed by S2-3a; the operator installs here, or the path
 * changes here first.
 */
export const DM_CODEX_EXECUTABLE_PATH = "/opt/tomverse-amux-dm/codex-cli-0.162.1/codex";
export const DM_CLAUDE_EXECUTABLE_PATH = "/opt/tomverse-amux-dm/claude-code-2.1.296/claude";

/** §5a "<스키마 파일>은 root 소유의 고정 파일": where the installer puts `DM_OUTPUT_SCHEMA_JSON`. */
export const DM_OUTPUT_SCHEMA_PATH = "/opt/tomverse-amux-dm/dm-output-schema-v1.json";

/**
 * The vendor accounts' homes, as S0 created them
 * (docs/ops/amux/decision-maker-s0-records/2026-10-13__a3f51403afccf147442f7c2ca7eeb4ccf97b8068.md:
 * `useradd --system --create-home --home-dir "/home/$u"`).
 */
export const DM_OPENAI_HOME = "/home/amux-dm-openai";
export const DM_ANTHROPIC_HOME = "/home/amux-dm-anthropic";

/**
 * §5a: "broker는 시작 전에 managed settings 파일이 없음을 확인한다. 그 경로는
 * S2-3에서 공급사 문서로 정한다." Claude Code's documentation names, for Linux,
 * `/etc/claude-code/managed-settings.json`, the drop-in directory
 * `/etc/claude-code/managed-settings.d/` beside it, and
 * `/etc/claude-code/managed-mcp.json` (code.claude.com/docs/en/admin-setup,
 * code.claude.com/docs/en/managed-mcp, read 2026-10-17). The launcher refuses
 * while `/etc/claude-code` exists at all, so a managed source added there
 * later is refused too. Server-managed settings are fetched by the CLI from
 * claude.ai and cannot be checked as a file; §5a's network allowlist is what
 * bounds them.
 */
export const DM_CLAUDE_MANAGED_SETTINGS_DIRECTORY = "/etc/claude-code";

// ---------------------------------------------------------------------------
// §6's output schema, as the CLIs receive it
// ---------------------------------------------------------------------------

/**
 * §5a: "<스키마 JSON>은 그 파일의 바이트 그대로다(§6의 출력 스키마. 내용은
 * S2-3 launcher의 상수이며 그 sha256이 실행 digest에 들어간다)".
 *
 * §6's value is one of three objects (`dmOutputSchema` in
 * lib/amux/decisionMakerCore.ts). Both CLIs need an object at the root --
 * codex sends the schema as OpenAI's strict `json_schema`, whose root may not
 * be `anyOf`, and claude implements `--json-schema` as a tool whose input is an
 * object -- so the three are one `anyOf` under a single `output` property, and
 * `dmUnwrappedOutput()` takes that property's value as the DM output. Only the
 * keywords S0 used, plus `anyOf`, appear: no `minLength`, `maxLength` or
 * `pattern`, which strict mode may refuse. The byte caps and the option-id
 * grammar stay the app's check (§6), never the schema's.
 */
export const DM_OUTPUT_SCHEMA_JSON =
  '{"type":"object","additionalProperties":false,"required":["output"],"properties":{"output":{"anyOf":[' +
  '{"type":"object","additionalProperties":false,"required":["kind","optionId","rationale","irreversible"],' +
  '"properties":{"kind":{"type":"string","enum":["select"]},"optionId":{"type":"string"},' +
  '"rationale":{"type":"string"},"irreversible":{"type":"boolean"}}},' +
  '{"type":"object","additionalProperties":false,"required":["kind","answer","rationale","irreversible"],' +
  '"properties":{"kind":{"type":"string","enum":["free_text"]},"answer":{"type":"string"},' +
  '"rationale":{"type":"string"},"irreversible":{"type":"boolean"}}},' +
  '{"type":"object","additionalProperties":false,"required":["kind","reason"],' +
  '"properties":{"kind":{"type":"string","enum":["escalate"]},"reason":{"type":"string"}}}]}}}';

const sha256Hex = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const DM_OUTPUT_SCHEMA_SHA256 = sha256Hex(Buffer.from(DM_OUTPUT_SCHEMA_JSON, "utf8"));

/** The one property of the schema's root object. */
export const DM_OUTPUT_WRAPPER_KEY = "output";

// ---------------------------------------------------------------------------
// The two instances
// ---------------------------------------------------------------------------

export type DmLauncherSpec = {
  instance: DmInstanceScope;
  cli: DmLauncherCli;
  /** §5a's table: the version the sha256 was measured for. */
  cliVersion: string;
  /** §5a's table, as the operator reported it on 2026-10-17. */
  executableSha256: string;
  executablePath: string;
  home: string;
  /** After the program name; placeholders unresolved. */
  argv: readonly string[];
  stateDelete: readonly string[];
  stateKeep: readonly string[];
  /** §5a: claude applies managed settings even under `--restricted`. */
  managedSettingsDirectory: string | null;
};

export const DM_LAUNCHER_SPECS: Readonly<Record<DmInstanceScope, DmLauncherSpec>> = Object.freeze({
  "decision-maker-openai": Object.freeze({
    instance: "decision-maker-openai",
    cli: "codex",
    cliVersion: "codex-cli 0.162.1",
    executableSha256: "628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1",
    executablePath: DM_CODEX_EXECUTABLE_PATH,
    home: DM_OPENAI_HOME,
    argv: CODEX_ARGV,
    stateDelete: CODEX_STATE_DELETE,
    stateKeep: CODEX_STATE_KEEP,
    managedSettingsDirectory: null,
  }),
  "decision-maker-anthropic": Object.freeze({
    instance: "decision-maker-anthropic",
    cli: "claude",
    cliVersion: "2.1.296",
    executableSha256: "24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de",
    executablePath: DM_CLAUDE_EXECUTABLE_PATH,
    home: DM_ANTHROPIC_HOME,
    argv: CLAUDE_ARGV,
    stateDelete: CLAUDE_STATE_DELETE,
    stateKeep: CLAUDE_STATE_KEEP,
    managedSettingsDirectory: DM_CLAUDE_MANAGED_SETTINGS_DIRECTORY,
  }),
} satisfies Record<DmInstanceScope, DmLauncherSpec>);

export const isDmLauncherInstance = (value: unknown): value is DmInstanceScope =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(DM_LAUNCHER_SPECS, value);

/** §5a "고정 환경", in a fixed order. */
export const dmFixedEnvironment = (instance: DmInstanceScope): ReadonlyArray<readonly [string, string]> =>
  Object.freeze([
    ["HOME", DM_LAUNCHER_SPECS[instance].home],
    ["PATH", DM_FIXED_PATH],
    ["LANG", DM_FIXED_LOCALE],
    ["LC_ALL", DM_FIXED_LOCALE],
  ] as const);

// ---------------------------------------------------------------------------
// The execution digest (§5a "실행 digest")
// ---------------------------------------------------------------------------

/** The program's argv with the schema resolved and the two per-request paths left as placeholders. */
const digestArgv = (spec: DmLauncherSpec): string[] => [
  spec.executablePath,
  ...spec.argv.map((token) =>
    token === DM_ARGV_SCHEMA_FILE ? DM_OUTPUT_SCHEMA_PATH : token === DM_ARGV_SCHEMA_JSON ? DM_OUTPUT_SCHEMA_JSON : token,
  ),
];

/**
 * §5a: "인스턴스, 실행 파일 경로와 sha256, 스키마 파일의 sha256, 요청마다 바뀌는
 * 두 경로를 자리표시자로 둔 argv 배열, 고정 환경, 아래 상태 삭제 목록". The
 * argv starts with the program, as the process receives it.
 */
export const dmExecutionDigestInput = (instance: DmInstanceScope) => {
  const spec = DM_LAUNCHER_SPECS[instance];
  return {
    instance: spec.instance,
    executable: { path: spec.executablePath, sha256: spec.executableSha256 },
    schemaSha256: DM_OUTPUT_SCHEMA_SHA256,
    argv: digestArgv(spec),
    environment: Object.fromEntries(dmFixedEnvironment(instance)),
    stateDeletion: { delete: [...spec.stateDelete], keep: [...spec.stateKeep] },
  };
};

export const dmExecutionDigestCanonical = (instance: DmInstanceScope): string =>
  amuxCanonicalJson(dmExecutionDigestInput(instance));

export const dmExecutionDigest = (instance: DmInstanceScope): string =>
  sha256Hex(Buffer.from(dmExecutionDigestCanonical(instance), "utf8"));

/**
 * §5a: "broker는 ... 실행 digest(§5a)를 정책 버전에 기록된 값과 대조한다", and
 * "그 값은 launcher 테스트가 고정한다". The recorded values; the preflight
 * refuses when the computed digest differs.
 */
export const DM_RECORDED_EXECUTION_DIGESTS: Readonly<Record<DmInstanceScope, string>> = Object.freeze({
  "decision-maker-openai": "298a51e122f436d683baebd465179f8c8ffc216fadbb5b9223f8c4212ea4a82a",
  "decision-maker-anthropic": "9c96b86efbac49a52903b4edcc1f4cc253a36b4678a9394a20ea01d91a3744f4",
});

// ---------------------------------------------------------------------------
// Closed vocabularies: refusals, results, residue
// ---------------------------------------------------------------------------

/** Why the launcher did not start a process. Nothing was sent to a vendor. */
export const DM_LAUNCH_REFUSALS = [
  "instance_unknown",
  "request_paths_invalid",
  "request_directories_unusable",
  "execution_digest_mismatch",
  "executable_unreadable",
  "executable_sha256_mismatch",
  "schema_unreadable",
  "schema_sha256_mismatch",
  "managed_settings_present",
  "managed_settings_unverifiable",
  "cli_state_residue",
  "transmit_intent_missing",
  "transmit_intent_mismatch",
  "executable_not_fixed",
  "argv_not_fixed",
  "environment_not_fixed",
] as const;
export type DmLaunchRefusal = (typeof DM_LAUNCH_REFUSALS)[number];

/**
 * §5a "실패 판정": a process that ran produced an output, timed out (the hard
 * timeout killed it) or is "DM 불가" (§9) for one of these reasons.
 */
export const DM_LAUNCH_UNAVAILABLE_REASONS = [
  "spawn_failed",
  "stdin_failed",
  "signal",
  "exit_code_1",
  "exit_code_other",
  "turn_failed",
  "is_error",
  "event_stream_unreadable",
  "result_missing",
  "result_unreadable",
  "output_too_large",
  "stdout_not_closed",
  "launcher_fault",
] as const;
export type DmLaunchUnavailableReason = (typeof DM_LAUNCH_UNAVAILABLE_REASONS)[number];

export type DmLaunchResult =
  | { outcome: "refused"; refusals: DmLaunchRefusal[] }
  | { outcome: "output"; raw: string }
  | { outcome: "timeout" }
  | { outcome: "unavailable"; reason: DmLaunchUnavailableReason };

export const DM_LAUNCH_OUTCOMES = ["refused", "output", "timeout", "unavailable"] as const;

/**
 * What the broker submits to the results route for each outcome (§6, §9): an
 * output is the app's to classify (proposal, escalation or validation
 * failure); a refusal started nothing and is "DM 불가".
 */
export const dmAppResultKindFor = (result: DmLaunchResult): "output" | "timeout" | "unavailable" =>
  result.outcome === "output" ? "output" : result.outcome === "timeout" ? "timeout" : "unavailable";

/** §5 / §5a: what was found where nothing may remain. Any of these is `cleanup_unknown`. */
export const DM_CLEANUP_RESIDUE_KINDS = [
  "instance_unknown",
  "request_paths_invalid",
  "request_path_present",
  "request_path_unreadable",
  "state_entry_present",
  "state_keep_not_regular_file",
  "state_root_not_directory",
  "state_ancestor_not_directory",
  "state_unreadable",
  "home_not_directory",
] as const;
export type DmCleanupResidueKind = (typeof DM_CLEANUP_RESIDUE_KINDS)[number];
export type DmCleanupResidue = { kind: DmCleanupResidueKind; path: string };

export type DmCleanupOutcome = { status: "verified" } | { status: "cleanup_unknown"; residue: DmCleanupResidue[] };

/**
 * Caps; not in the policy. The largest DM output the launcher returns, in UTF-8 bytes: the results
 * route refuses a larger body outright (its `MAX_BODY_BYTES`), so a larger
 * output could never be recorded.
 */
export const DM_LAUNCH_OUTPUT_MAX_BYTES = 256 * 1024;
/** stdout kept in memory; beyond it the stream is drained and the run is `output_too_large`. */
export const DM_LAUNCH_STDOUT_MAX_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The execution plan
// ---------------------------------------------------------------------------

export type DmRequestPaths = {
  /** The broker's request directory (§5): read-only to the vendor account. */
  requestDirectory: string;
  /** The vendor account's per-request temporary directory (§5), empty at start. */
  temporaryDirectory: string;
  /** codex only: `-o`, a direct child of the temporary directory. Null for claude. */
  outputFile: string | null;
};

export type DmExecutionPlan = {
  instance: DmInstanceScope;
  cli: DmLauncherCli;
  executable: string;
  /** The process's whole argv, the program first. */
  argv: string[];
  environment: Array<[string, string]>;
  /** §5a: claude's working directory is the request directory; codex gets the same, as `-C` names it. */
  workingDirectory: string;
  paths: DmRequestPaths;
};

const PATH_MAX_BYTES = 4096;

/** An absolute POSIX path in its one spelling: no empty, `.` or `..` segment, no trailing `/`, no control byte. */
export const isDmAbsolutePath = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.startsWith("/") || value.length < 2) return false;
  if (Buffer.byteLength(value, "utf8") > PATH_MAX_BYTES || !value.isWellFormed()) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return value
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const isInside = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`);

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * The request's paths, if they can be used at all. Both directories are
 * deleted whole after the request, so neither may be, or hold, the account's
 * home (its kept authentication file), the root-owned executable or schema,
 * or the other directory.
 */
export const dmRequestPathsRefusal = (spec: DmLauncherSpec, paths: unknown): "request_paths_invalid" | null => {
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) return "request_paths_invalid";
  const record = paths as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "outputFile,requestDirectory,temporaryDirectory") return "request_paths_invalid";
  const { requestDirectory, temporaryDirectory, outputFile } = record;
  if (!isDmAbsolutePath(requestDirectory) || !isDmAbsolutePath(temporaryDirectory)) return "request_paths_invalid";
  if (isInside(requestDirectory, temporaryDirectory) || isInside(temporaryDirectory, requestDirectory)) {
    return "request_paths_invalid";
  }
  const protectedPaths = [spec.home, spec.executablePath, DM_OUTPUT_SCHEMA_PATH];
  if (protectedPaths.some((path) => isInside(path, requestDirectory) || isInside(path, temporaryDirectory))) {
    return "request_paths_invalid";
  }
  if (spec.cli === "claude") return outputFile === null ? null : "request_paths_invalid";
  if (!isDmAbsolutePath(outputFile) || parentOf(outputFile) !== temporaryDirectory) return "request_paths_invalid";
  return null;
};

/**
 * §5a: the one command a request may start. The schema's two placeholders
 * become the root-owned file and its bytes, the two per-request ones become
 * the broker's paths; nothing else varies.
 */
export const dmExecutionPlan = (
  instance: unknown,
  paths: unknown,
): { ok: true; plan: DmExecutionPlan } | { ok: false; refusal: "instance_unknown" | "request_paths_invalid" } => {
  if (!isDmLauncherInstance(instance)) return { ok: false, refusal: "instance_unknown" };
  const spec = DM_LAUNCHER_SPECS[instance];
  if (dmRequestPathsRefusal(spec, paths) !== null) return { ok: false, refusal: "request_paths_invalid" };
  const request = paths as DmRequestPaths;
  const substitute = (token: string) => {
    switch (token) {
      case DM_ARGV_SCHEMA_FILE:
        return DM_OUTPUT_SCHEMA_PATH;
      case DM_ARGV_SCHEMA_JSON:
        return DM_OUTPUT_SCHEMA_JSON;
      case DM_ARGV_REQUEST_DIRECTORY:
        return request.requestDirectory;
      case DM_ARGV_OUTPUT_FILE:
        return request.outputFile as string;
      default:
        return token;
    }
  };
  return {
    ok: true,
    plan: {
      instance,
      cli: spec.cli,
      executable: spec.executablePath,
      argv: [spec.executablePath, ...spec.argv.map(substitute)],
      environment: dmFixedEnvironment(instance).map(([name, value]) => [name, value]),
      workingDirectory: request.requestDirectory,
      paths: {
        requestDirectory: request.requestDirectory,
        temporaryDirectory: request.temporaryDirectory,
        outputFile: request.outputFile,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// The command about to start
// ---------------------------------------------------------------------------

export type DmCommand = {
  executable: string;
  argv: readonly string[];
  environment: ReadonlyArray<readonly [string, string]>;
};

/**
 * §5: "실행 파일·argv·환경 가운데 하나라도 기록과 다르면 시작을 거부한다".
 * The exact comparison is the gate; `dmForbiddenArgv()` only names what was
 * mixed in.
 */
export const dmCommandRefusals = (plan: DmExecutionPlan, command: DmCommand): DmLaunchRefusal[] => {
  const refusals: DmLaunchRefusal[] = [];
  if (command.executable !== plan.executable) refusals.push("executable_not_fixed");
  const argvFixed =
    command.argv.length === plan.argv.length && command.argv.every((token, index) => token === plan.argv[index]);
  if (!argvFixed) refusals.push("argv_not_fixed");
  const expected = new Map(plan.environment);
  const names = command.environment.map(([name]) => name);
  const environmentFixed =
    command.environment.length === expected.size &&
    new Set(names).size === names.length &&
    command.environment.every(([name, value]) => expected.get(name) === value);
  if (!environmentFixed) refusals.push("environment_not_fixed");
  return refusals;
};

const matchesFlag = (token: string, flag: string) => {
  if (token === flag) return true;
  if (flag.startsWith("--")) return token.startsWith(`${flag}=`);
  // A single-letter flag with its value attached: `-cfoo`, `-c=foo`.
  return flag.length === 2 && flag.startsWith("-") && token.startsWith(flag) && !token.startsWith("--");
};

/**
 * Which of §5a's refused entries appear in an argv (diagnostic only). The
 * program name is skipped. Claude's `--tools ""` and codex's `-s read-only`
 * are the fixed argv's own and are not reported.
 */
export const dmForbiddenArgv = (cli: DmLauncherCli, argv: readonly string[]): string[] => {
  const list: readonly string[] = cli === "codex" ? DM_CODEX_REFUSED_ARGV : DM_CLAUDE_REFUSED_ARGV;
  const found = new Set<string>();
  const tokens = argv.slice(1);
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    for (const entry of list) {
      const [flag, value] = entry.split(" ");
      if (value !== undefined) {
        if ((token === flag && next === value) || token === `${flag}${value}` || token === `${flag}=${value}`) {
          found.add(entry);
        }
        continue;
      }
      if (cli === "claude" && flag === "--tools") {
        if ((token === "--tools" && next !== "") || (token.startsWith("--tools=") && token !== "--tools=")) {
          found.add(entry);
        }
        continue;
      }
      if (matchesFlag(token, flag)) found.add(entry);
    }
  });
  return list.filter((entry) => found.has(entry));
};

// ---------------------------------------------------------------------------
// The transmission intent (§2-4, §10)
// ---------------------------------------------------------------------------

/**
 * What the broker hands the launcher after the transmissions route answered:
 * the request and instance it recorded for, the route's answer (`recorded`
 * and the event id), and the input payload digest it sent.
 */
export type DmTransmitIntentEvidence = {
  requestId: string;
  instance: string;
  recorded: true;
  eventId: string;
  inputPayloadDigest: string;
};

const EVIDENCE_KEYS = ["eventId", "inputPayloadDigest", "instance", "recorded", "requestId"];

/**
 * §10: "전송 의도를 기록하고 그 응답을 받은 뒤에만 시작한다", and §2-4:
 * "그 바이트 그대로". The evidence must be the route's recorded answer for
 * this instance, and its payload digest must be the request-keyed digest
 * (`dmPayloadDigest`, the app's own function) of the exact bytes the process
 * would read on stdin. A caller-made boolean is not evidence.
 */
export const dmTransmitIntentRefusal = (
  instance: DmInstanceScope,
  evidence: unknown,
  requestKey: unknown,
  payload: Uint8Array,
): "transmit_intent_missing" | "transmit_intent_mismatch" | null => {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return "transmit_intent_missing";
  const record = evidence as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== EVIDENCE_KEYS.join(",")) return "transmit_intent_missing";
  if (record.recorded !== true || !isDmRequestId(record.requestId) || !isDmRequestId(record.eventId)) {
    return "transmit_intent_missing";
  }
  if (!isDmDigest(record.inputPayloadDigest)) return "transmit_intent_missing";
  if (!Buffer.isBuffer(requestKey) || requestKey.length !== 32) return "transmit_intent_missing";
  if (record.instance !== instance) return "transmit_intent_mismatch";
  const actual = Buffer.from(dmPayloadDigest(requestKey, payload), "hex");
  const recorded = Buffer.from(record.inputPayloadDigest, "hex");
  return timingSafeEqual(actual, recorded) ? null : "transmit_intent_mismatch";
};

// ---------------------------------------------------------------------------
// Results (§5a "결과를 읽는 곳은 하나다", "실패 판정")
// ---------------------------------------------------------------------------

export type DmOutputFileRead =
  | { state: "absent" }
  | { state: "too_large" }
  | { state: "unreadable" }
  | { state: "read"; bytes: Uint8Array };

export type DmProcessObservation = {
  spawned: boolean;
  /** The hard timeout fired and the launcher killed the process. */
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  stdinFailed: boolean;
  stdout: Uint8Array;
  stdoutTruncated: boolean;
  stdoutClosed: boolean;
  /** codex's `-o` file, read before cleanup; null for claude. */
  outputFile: DmOutputFileRead | null;
};

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The DM output inside §6's wrapper. A value that is not exactly the wrapper
 * is returned whole, so the app records the schema violation as a validation
 * failure (§6) rather than the launcher deciding it.
 */
export const dmUnwrappedOutput = (value: unknown): string =>
  isPlainObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, DM_OUTPUT_WRAPPER_KEY)
    ? JSON.stringify(value[DM_OUTPUT_WRAPPER_KEY])
    : JSON.stringify(value);

const output = (raw: string): DmLaunchResult =>
  Buffer.byteLength(raw, "utf8") > DM_LAUNCH_OUTPUT_MAX_BYTES
    ? { outcome: "unavailable", reason: "output_too_large" }
    : { outcome: "output", raw };

const unavailable = (reason: DmLaunchUnavailableReason): DmLaunchResult => ({ outcome: "unavailable", reason });

const codexResult = (observation: DmProcessObservation): DmLaunchResult => {
  const stream = decodeUtf8(observation.stdout);
  if (stream === null) return unavailable("event_stream_unreadable");
  for (const line of stream.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return unavailable("event_stream_unreadable");
    }
    if (isPlainObject(event) && event.type === "turn.failed") return unavailable("turn_failed");
  }
  const file = observation.outputFile;
  if (file === null || file.state === "absent") return unavailable("result_missing");
  if (file.state === "too_large") return unavailable("output_too_large");
  if (file.state === "unreadable") return unavailable("result_unreadable");
  const text = decodeUtf8(file.bytes);
  if (text === null) return unavailable("result_unreadable");
  if (text.trim() === "") return unavailable("result_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the app records it as a schema violation.
    return output(text);
  }
  return output(dmUnwrappedOutput(parsed));
};

const claudeResult = (observation: DmProcessObservation): DmLaunchResult => {
  const text = decodeUtf8(observation.stdout);
  if (text === null) return unavailable("result_unreadable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return unavailable("result_unreadable");
  }
  if (!isPlainObject(parsed) || parsed.type !== "result" || typeof parsed.is_error !== "boolean") {
    return unavailable("result_unreadable");
  }
  if (parsed.is_error) return unavailable("is_error");
  if (!Object.hasOwn(parsed, "structured_output") || parsed.structured_output === null) {
    return unavailable("result_missing");
  }
  return output(dmUnwrappedOutput(parsed.structured_output));
};

/**
 * §5a: codex fails on exit code 1 or a `turn.failed` event, claude on exit
 * code 1 or `is_error: true`; either one means no result. A hard-timeout kill
 * is a timeout. Every other exit that is not a clean 0 is also no result
 * (fail-closed). The result is read from one place only: codex's `-o` file,
 * claude's `structured_output` -- never the event stream's messages or
 * claude's `result` string.
 */
export const dmClassifyProcess = (cli: DmLauncherCli, observation: DmProcessObservation): DmLaunchResult => {
  if (!observation.spawned) return unavailable("spawn_failed");
  if (observation.timedOut) return { outcome: "timeout" };
  if (!observation.stdoutClosed) return unavailable("stdout_not_closed");
  if (observation.signal !== null) return unavailable("signal");
  if (observation.exitCode === 1) return unavailable("exit_code_1");
  if (observation.exitCode !== 0) return unavailable("exit_code_other");
  if (observation.stdinFailed) return unavailable("stdin_failed");
  if (observation.stdoutTruncated) return unavailable("output_too_large");
  return cli === "codex" ? codexResult(observation) : claudeResult(observation);
};

// ---------------------------------------------------------------------------
// State deletion targets (§5a "요청마다 지운다")
// ---------------------------------------------------------------------------

export type DmStateTarget =
  /** A directory whose every entry but `keep` is deleted. */
  | { kind: "directory_keeping"; path: string; keep: readonly string[] }
  /** A file or directory deleted whole. */
  | { kind: "whole"; path: string };

const homeRelative = (entry: string) => {
  if (!entry.startsWith("~/")) throw new Error(`AMUX Decision Maker state entry is not under ~: ${entry}`);
  return entry.slice(2).replace(/\/$/, "");
};

/**
 * §5a's lists as filesystem targets under the account's home: a deleted
 * directory that holds a kept file keeps that file, every other target goes
 * whole. Paths are home-relative.
 */
export const dmStateTargets = (instance: DmInstanceScope): DmStateTarget[] => {
  const spec = DM_LAUNCHER_SPECS[instance];
  const keep = spec.stateKeep.map(homeRelative);
  return spec.stateDelete.map((entry) => {
    const path = homeRelative(entry);
    const kept = keep.filter((file) => parentOf(`/${file}`) === `/${path}`).map((file) => file.slice(path.length + 1));
    return kept.length > 0 ? { kind: "directory_keeping", path, keep: kept } : { kind: "whole", path };
  });
};
