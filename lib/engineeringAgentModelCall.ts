/**
 * The engineering agent's model call: what goes into the model, the one tool
 * the model gets, and what may come back.
 *
 * docs/policy/engineering-agent.md §6 and §8 are the contract.
 *
 * - External text is cut to fixed limits and normalised deterministically
 *   before it reaches the model; the whole original is never stored.
 * - The model has exactly one tool, `read_file`, over the tracked files of a
 *   fresh clone. It cannot run anything: this module imports no process,
 *   evaluation or worker API, and a test reads its syntax tree to keep it so.
 * - The request goes to one fixed host. The key travels only in a header; the
 *   module never reads the environment, so nothing else can leak into a
 *   request body.
 * - The answer is two fields, `manifest` and `patch`, with size limits. A
 *   failure is a failure, never "no change".
 *
 * Raw HTTP rather than the SDK: the drafting service's entry point imports only
 * the runtime and dependency-free core (policy §8), because it clones a
 * repository whose dependencies it must never install.
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------------- */
/* External text                                                              */
/* ------------------------------------------------------------------------- */

const KB = 1024;

/** Proposed limits (design §4.2a); fixed by policy revision before shadow. */
export const INPUT_LIMITS = {
  issueTitle: 512,
  executionBrief: { total: 16 * KB, head: 12 * KB, tail: 4 * KB },
  registrationItem: 8 * KB,
  registrationRound: 64 * KB,
  ciLog: { total: 32 * KB, head: 4 * KB, tail: 28 * KB },
  dependabotBody: 8 * KB,
  workRunTotal: 48 * KB,
} as const;

export type NormalisedInput =
  | { ok: true; text: string; originalBytes: number; digest: string; truncated: boolean }
  | { ok: false; reason: "input_rejected"; detail: "invalid_utf8" | "nul_byte" };

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Control characters other than newline and tab, after decoding. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Backs a cut position off any UTF-8 continuation byte, so no character is split. */
const headBoundary = (bytes: Uint8Array, length: number) => {
  let cut = Math.min(length, bytes.length);
  while (cut > 0 && cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
};
const tailBoundary = (bytes: Uint8Array, length: number) => {
  let start = Math.max(0, bytes.length - length);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return start;
};

const normaliseText = (bytes: Uint8Array): string => {
  // Callers have already decoded the whole input once with a fatal decoder;
  // the pieces cut on character boundaries decode cleanly.
  return utf8.decode(bytes).replace(CONTROL, "").normalize("NFC");
};

/**
 * Validates, cuts and normalises one input. The digest is of the original
 * bytes, before anything was cut. A cut leaves a single marker line naming how
 * many bytes were dropped and the original's digest, so the model can tell the
 * text is partial and a reviewer can match it to its source.
 */
export const prepareInput = (
  raw: Uint8Array,
  limit: number | { total: number; head: number; tail: number },
): NormalisedInput => {
  if (raw.includes(0)) return { ok: false, reason: "input_rejected", detail: "nul_byte" };
  try {
    utf8.decode(raw);
  } catch {
    return { ok: false, reason: "input_rejected", detail: "invalid_utf8" };
  }
  const digest = sha256(raw);
  const total = typeof limit === "number" ? limit : limit.total;
  if (raw.length <= total) {
    return { ok: true, text: normaliseText(raw), originalBytes: raw.length, digest, truncated: false };
  }
  if (typeof limit === "number") {
    return {
      ok: true,
      text: normaliseText(raw.subarray(0, headBoundary(raw, limit))),
      originalBytes: raw.length,
      digest,
      truncated: true,
    };
  }
  const head = raw.subarray(0, headBoundary(raw, limit.head));
  const tail = raw.subarray(tailBoundary(raw, limit.tail));
  const dropped = raw.length - head.length - tail.length;
  return {
    ok: true,
    text: `${normaliseText(head)}\n[truncated ${dropped} bytes, sha256 ${digest}]\n${normaliseText(tail)}`,
    originalBytes: raw.length,
    digest,
    truncated: true,
  };
};

/**
 * A work run's external inputs, each cut to its own limit, then cut further to
 * the run total -- the CI log first, the dependabot body second -- because the
 * card brief is the work and the rest is evidence.
 */
export const prepareWorkRunInputs = (inputs: {
  executionBrief: Uint8Array;
  ciLog?: Uint8Array;
  dependabotBody?: Uint8Array;
}):
  | { ok: true; brief: string; ciLog: string | null; dependabotBody: string | null; truncated: string[] }
  | { ok: false; source: string; detail: string } => {
  const brief = prepareInput(inputs.executionBrief, INPUT_LIMITS.executionBrief);
  if (!brief.ok) return { ok: false, source: "executionBrief", detail: brief.detail };
  let ciLog: string | null = null;
  let dependabotBody: string | null = null;
  const truncated: string[] = brief.truncated ? ["executionBrief"] : [];
  if (inputs.ciLog) {
    const prepared = prepareInput(inputs.ciLog, INPUT_LIMITS.ciLog);
    if (!prepared.ok) return { ok: false, source: "ciLog", detail: prepared.detail };
    ciLog = prepared.text;
    if (prepared.truncated) truncated.push("ciLog");
  }
  if (inputs.dependabotBody) {
    const prepared = prepareInput(inputs.dependabotBody, INPUT_LIMITS.dependabotBody);
    if (!prepared.ok) return { ok: false, source: "dependabotBody", detail: prepared.detail };
    dependabotBody = prepared.text;
    if (prepared.truncated) truncated.push("dependabotBody");
  }

  const size = (text: string | null) => (text === null ? 0 : encoder.encode(text).length);
  let over = size(brief.text) + size(ciLog) + size(dependabotBody) - INPUT_LIMITS.workRunTotal;
  const shrink = (text: string | null, source: string): string | null => {
    if (text === null || over <= 0) return text;
    const bytes = encoder.encode(text);
    const keep = Math.max(0, bytes.length - over);
    const cut = bytes.subarray(tailBoundary(bytes, keep));
    over -= bytes.length - cut.length;
    if (!truncated.includes(source)) truncated.push(source);
    return new TextDecoder().decode(cut);
  };
  ciLog = shrink(ciLog, "ciLog");
  dependabotBody = shrink(dependabotBody, "dependabotBody");
  if (over > 0) return { ok: false, source: "executionBrief", detail: "exceeds_run_total" };
  return { ok: true, brief: brief.text, ciLog, dependabotBody, truncated };
};

/**
 * A registration round's items: each cut to its own limit, and items beyond the
 * round total deferred to the next round rather than cut again.
 */
export const prepareRegistrationRound = <T extends { key: string; raw: Uint8Array }>(
  items: readonly T[],
): { offered: Array<T & { text: string }>; deferred: string[]; rejected: string[] } => {
  const offered: Array<T & { text: string }> = [];
  const deferred: string[] = [];
  const rejected: string[] = [];
  let used = 0;
  for (const item of items) {
    const prepared = prepareInput(item.raw, INPUT_LIMITS.registrationItem);
    if (!prepared.ok) {
      rejected.push(item.key);
      continue;
    }
    const bytes = encoder.encode(prepared.text).length;
    if (used + bytes > INPUT_LIMITS.registrationRound) {
      deferred.push(item.key);
      continue;
    }
    used += bytes;
    offered.push({ ...item, text: prepared.text });
  }
  return { offered, deferred, rejected };
};

/* ------------------------------------------------------------------------- */
/* read_file                                                                  */
/* ------------------------------------------------------------------------- */

export const READ_FILE_TOOL = {
  name: "read_file",
  description:
    "Read one tracked file of the repository at the base commit, by its repository-relative path. Returns the file's text.",
  strict: true,
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "Repository-relative path, as git ls-files prints it." } },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

/** The filesystem operations `read_file` needs, injected so tests need no disk. */
export type ReadFilePorts = {
  realpath: (absolute: string) => Promise<string>;
  lstatIsSymlink: (absolute: string) => Promise<boolean>;
  lstatIsFile: (absolute: string) => Promise<boolean>;
  readFile: (absolute: string) => Promise<Uint8Array>;
};

const DENIED_BASENAMES = [/^\.env$/, /^\.env\..+$/, /^\.npmrc$/, /^\.netrc$/];
const DENIED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks"];

/** Paths `read_file` refuses even when tracked. */
export const readFileDenied = (path: string, secretFixturePaths: ReadonlySet<string>) => {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (DENIED_BASENAMES.some((pattern) => pattern.test(base))) return true;
  if (DENIED_EXTENSIONS.some((extension) => base.endsWith(extension))) return true;
  if (base.includes("id_rsa") || base.includes("id_ed25519")) return true;
  if (lower.split("/").includes(".git")) return true;
  return secretFixturePaths.has(path);
};

export type ReadFileResult =
  | { ok: true; text: string; bytes: number }
  | {
      ok: false;
      reason:
        | "not_tracked"
        | "denied"
        | "outside_clone"
        | "symlink"
        | "not_a_file"
        | "not_text"
        | "budget_exhausted";
    };

/**
 * One `read_file` call. The path must be exactly a tracked path; every
 * component is checked for symlinks, the real path must stay inside the clone,
 * the target must be a regular file, and the denylist applies to tracked files
 * too. Bytes read count against the session budget.
 */
export const readTrackedFile = async (input: {
  cloneRoot: string;
  trackedPaths: ReadonlySet<string>;
  secretFixturePaths: ReadonlySet<string>;
  requested: unknown;
  ports: ReadFilePorts;
  budgetRemaining: number;
}): Promise<ReadFileResult> => {
  const requested = input.requested;
  if (typeof requested !== "string" || !input.trackedPaths.has(requested)) {
    return { ok: false, reason: "not_tracked" };
  }
  if (readFileDenied(requested, input.secretFixturePaths)) return { ok: false, reason: "denied" };
  const root = input.cloneRoot.replace(/[\\/]+$/, "");
  const segments = requested.split("/");
  for (let i = 1; i <= segments.length; i += 1) {
    const partial = `${root}/${segments.slice(0, i).join("/")}`;
    if (await input.ports.lstatIsSymlink(partial)) return { ok: false, reason: "symlink" };
  }
  const absolute = `${root}/${requested}`;
  const real = (await input.ports.realpath(absolute)).replace(/\\/g, "/");
  const realRoot = (await input.ports.realpath(root)).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!real.startsWith(`${realRoot}/`)) return { ok: false, reason: "outside_clone" };
  if (!(await input.ports.lstatIsFile(absolute))) return { ok: false, reason: "not_a_file" };
  const bytes = await input.ports.readFile(absolute);
  if (bytes.length > input.budgetRemaining) return { ok: false, reason: "budget_exhausted" };
  if (bytes.includes(0)) return { ok: false, reason: "not_text" };
  try {
    return { ok: true, text: utf8.decode(bytes), bytes: bytes.length };
  } catch {
    return { ok: false, reason: "not_text" };
  }
};

/* ------------------------------------------------------------------------- */
/* The request                                                                */
/* ------------------------------------------------------------------------- */

/** The one host this module talks to. */
export const MODEL_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-opus-5";
/** Server-side refusal fallback, routed by category (opt-in; enabled by default). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Proposed session limits; fixed by policy revision before shadow. */
export const SESSION_LIMITS = {
  maxTurns: 24,
  maxOutputTokens: 32_000,
  maxToolBytes: 256 * KB,
  requestTimeoutMs: 8 * 60 * 1000,
} as const;

export type ModelMessage = { role: "user" | "assistant"; content: unknown };

export type Transport = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<{ status: number; json: unknown }>;

/**
 * The HTTP request, fully determined by its inputs. The key goes into one
 * header and nowhere else.
 */
export const buildModelRequest = (input: {
  apiKey: string;
  model: string;
  system: string;
  messages: readonly ModelMessage[];
}) => ({
  url: MODEL_ENDPOINT,
  headers: {
    "content-type": "application/json",
    "x-api-key": input.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": FALLBACK_BETA,
  },
  body: JSON.stringify({
    model: input.model,
    max_tokens: SESSION_LIMITS.maxOutputTokens,
    system: input.system,
    tools: [READ_FILE_TOOL],
    fallbacks: "default",
    messages: input.messages,
  }),
  timeoutMs: SESSION_LIMITS.requestTimeoutMs,
});

/* ------------------------------------------------------------------------- */
/* The answer                                                                 */
/* ------------------------------------------------------------------------- */

export const RESULT_LIMITS = {
  patchBytes: 64 * KB,
  summaryBytes: 2 * KB,
  maxTests: 20,
} as const;

export type ModelResult = {
  manifest: { summary: string; tests: string[] };
  patch: string;
};

/**
 * The model's answer: one JSON object with exactly `manifest` and `patch`.
 * Anything else -- prose around it, extra fields, oversize values -- is
 * `schema_invalid`. An empty patch is `no_change`, which is an outcome of its
 * own, not a failure to be retried.
 */
export const parseModelResult = (
  text: string,
): { ok: true; result: ModelResult } | { ok: false; reason: "schema_invalid" | "no_change" } => {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return { ok: false, reason: "schema_invalid" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "schema_invalid" };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "manifest,patch") return { ok: false, reason: "schema_invalid" };
  const manifest = record.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, reason: "schema_invalid" };
  }
  const m = manifest as Record<string, unknown>;
  if (Object.keys(m).sort().join(",") !== "summary,tests") return { ok: false, reason: "schema_invalid" };
  if (typeof m.summary !== "string" || encoder.encode(m.summary).length > RESULT_LIMITS.summaryBytes) {
    return { ok: false, reason: "schema_invalid" };
  }
  if (
    !Array.isArray(m.tests) ||
    m.tests.length > RESULT_LIMITS.maxTests ||
    !m.tests.every((test) => typeof test === "string" && test.length <= 256)
  ) {
    return { ok: false, reason: "schema_invalid" };
  }
  if (typeof record.patch !== "string" || encoder.encode(record.patch).length > RESULT_LIMITS.patchBytes) {
    return { ok: false, reason: "schema_invalid" };
  }
  if (record.patch.trim() === "") return { ok: false, reason: "no_change" };
  return {
    ok: true,
    result: { manifest: { summary: m.summary, tests: m.tests as string[] }, patch: record.patch },
  };
};

/* ------------------------------------------------------------------------- */
/* The session                                                                */
/* ------------------------------------------------------------------------- */

export type SessionOutcome =
  | { ok: true; result: ModelResult; turns: number; toolBytes: number }
  | {
      ok: false;
      reason:
        | "provider_error"
        | "refused"
        | "output_limit"
        | "turn_limit"
        | "tool_budget_exceeded"
        | "unexpected_response"
        | "schema_invalid"
        | "no_change";
      status?: number;
    };

type ContentBlock = { type: string; [key: string]: unknown };

/**
 * The tool loop. Each assistant turn goes back in full -- thinking blocks
 * included -- and every `read_file` call in a turn is answered in one user
 * message. Any stop other than a finished turn or a tool call ends the session
 * as a failure; a failure is never read as "no change" (policy §13-8).
 */
export const runModelSession = async (input: {
  apiKey: string;
  model?: string;
  system: string;
  userContent: string;
  transport: Transport;
  readFile: (path: unknown, budgetRemaining: number) => Promise<ReadFileResult>;
}): Promise<SessionOutcome> => {
  const messages: ModelMessage[] = [{ role: "user", content: input.userContent }];
  let toolBytes = 0;
  for (let turn = 1; turn <= SESSION_LIMITS.maxTurns; turn += 1) {
    let response: { status: number; json: unknown };
    try {
      response = await input.transport(
        buildModelRequest({ apiKey: input.apiKey, model: input.model ?? DEFAULT_MODEL, system: input.system, messages }),
      );
    } catch {
      return { ok: false, reason: "provider_error" };
    }
    if (response.status !== 200) return { ok: false, reason: "provider_error", status: response.status };
    const body = response.json as { stop_reason?: unknown; content?: unknown };
    if (!body || !Array.isArray(body.content)) return { ok: false, reason: "unexpected_response" };
    const content = body.content as ContentBlock[];

    switch (body.stop_reason) {
      case "refusal":
        return { ok: false, reason: "refused" };
      case "max_tokens":
        return { ok: false, reason: "output_limit" };
      case "end_turn": {
        const text = content
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("");
        const parsed = parseModelResult(text);
        return parsed.ok
          ? { ok: true, result: parsed.result, turns: turn, toolBytes }
          : { ok: false, reason: parsed.reason };
      }
      case "tool_use": {
        messages.push({ role: "assistant", content });
        const results: unknown[] = [];
        for (const block of content) {
          if (block.type !== "tool_use") continue;
          const id = block.id;
          if (typeof id !== "string") return { ok: false, reason: "unexpected_response" };
          if (block.name !== READ_FILE_TOOL.name) {
            results.push({ type: "tool_result", tool_use_id: id, is_error: true, content: "unknown tool" });
            continue;
          }
          const path = (block.input as { path?: unknown } | undefined)?.path;
          const read = await input.readFile(path, SESSION_LIMITS.maxToolBytes - toolBytes);
          if (!read.ok && read.reason === "budget_exhausted") return { ok: false, reason: "tool_budget_exceeded" };
          if (read.ok) toolBytes += read.bytes;
          results.push(
            read.ok
              ? { type: "tool_result", tool_use_id: id, content: read.text }
              : { type: "tool_result", tool_use_id: id, is_error: true, content: `read_file refused: ${read.reason}` },
          );
        }
        if (results.length === 0) return { ok: false, reason: "unexpected_response" };
        messages.push({ role: "user", content: results });
        continue;
      }
      default:
        return { ok: false, reason: "unexpected_response" };
    }
  }
  return { ok: false, reason: "turn_limit" };
};
