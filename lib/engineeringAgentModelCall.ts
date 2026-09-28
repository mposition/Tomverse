/**
 * The engineering agent's model call: what goes into the model, the one tool
 * the model gets, and what may come back.
 *
 * docs/policy/engineering-agent.md §6 and §8 are the contract.
 *
 * - External text is cut to fixed limits and normalised deterministically
 *   before it reaches the model; the whole original is never stored.
 * - The model has exactly one tool, `read_file`, over the tracked files of a
 *   fresh clone. It cannot run anything: this module imports only a hash, names
 *   no network, process, evaluation or reflection API, and indexes only by
 *   number; a test reads its syntax tree and types to keep it so.
 * - The request goes to one fixed host through the transport the caller
 *   passes in. The key travels only in a header; the module never reads the
 *   environment, so nothing else can leak into a request body.
 * - No provider-side fallback: a refusal comes back as a refusal and ends the
 *   session (policy §13-8), rather than being answered by another model.
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

/** Proposed limits (docs/policy/engineering-agent.md §6); fixed by policy revision before shadow. */
export const INPUT_LIMITS = {
  issueTitle: 512,
  executionBrief: { total: 16 * KB, head: 12 * KB, tail: 4 * KB },
  registrationItem: 8 * KB,
  registrationRound: 64 * KB,
  ciLog: { total: 32 * KB, head: 4 * KB, tail: 28 * KB },
  dependabotBody: 8 * KB,
  workRunTotal: 48 * KB,
} as const;

type HeadTailLimit = { total: number; head: number; tail: number };

/**
 * One prepared input. `text` is what the model sees and is never longer than
 * the limit in UTF-8 bytes, marker included; `digest` and `originalBytes` are
 * of the bytes as received, before anything was removed or cut.
 */
export type PreparedText = { text: string; originalBytes: number; digest: string; truncated: boolean };

export type NormalisedInput =
  | ({ ok: true } & PreparedText)
  | { ok: false; reason: "input_rejected"; detail: "invalid_utf8" | "nul_byte" };

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Control characters other than newline and tab, after decoding. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Backs a cut position off any UTF-8 continuation byte, so no character is split. */
const headBoundary = (bytes: Uint8Array, length: number) => {
  let cut = Math.max(0, Math.min(length, bytes.length));
  while (cut > 0 && cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
};
const tailBoundary = (bytes: Uint8Array, length: number) => {
  let start = Math.max(0, bytes.length - Math.max(0, length));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return start;
};

/** An input decoded, stripped of control characters and NFC-normalised, whole. */
type Cleaned = { ok: true; bytes: Uint8Array; originalBytes: number; digest: string };

/**
 * Normalisation happens before cutting, so the limit applies to the text the
 * model receives: removing control characters shrinks it and NFC can grow it,
 * and either would otherwise move the result past the limit.
 */
const clean = (raw: Uint8Array): Cleaned | { ok: false; reason: "input_rejected"; detail: "invalid_utf8" | "nul_byte" } => {
  if (raw.includes(0)) return { ok: false, reason: "input_rejected", detail: "nul_byte" };
  let decoded: string;
  try {
    decoded = utf8.decode(raw);
  } catch {
    return { ok: false, reason: "input_rejected", detail: "invalid_utf8" };
  }
  return {
    ok: true,
    bytes: encoder.encode(decoded.replace(CONTROL, "").normalize("NFC")),
    originalBytes: raw.length,
    digest: sha256(raw),
  };
};

/** Keeps the start only: titles, registration items, dependabot bodies. */
const cutHead = (input: Cleaned, total: number): PreparedText => {
  const truncated = input.bytes.length > total;
  const kept = truncated ? input.bytes.subarray(0, headBoundary(input.bytes, total)) : input.bytes;
  return { text: utf8.decode(kept), originalBytes: input.originalBytes, digest: input.digest, truncated };
};

const marker = (dropped: number, digest: string) => `\n[truncated ${dropped} bytes, sha256 ${digest}]\n`;

/**
 * Keeps the start and the end with one marker line between them naming how
 * many bytes were dropped and the original's digest. The marker comes out of
 * the start's share, sized for the widest count this input could need, so the
 * result never exceeds `limit.total`. Null when the limit cannot hold even the
 * marker.
 */
const cutHeadTail = (input: Cleaned, limit: HeadTailLimit): PreparedText | null => {
  if (input.bytes.length <= limit.total) {
    return { text: utf8.decode(input.bytes), originalBytes: input.originalBytes, digest: input.digest, truncated: false };
  }
  const widest = encoder.encode(marker(input.bytes.length, input.digest)).length;
  const headRoom = limit.head - widest;
  if (headRoom < 0) return null;
  const tailRoom = limit.total - limit.head;
  const head = input.bytes.subarray(0, headBoundary(input.bytes, headRoom));
  const tail = input.bytes.subarray(tailBoundary(input.bytes, tailRoom));
  return {
    text: `${utf8.decode(head)}${marker(input.bytes.length - head.length - tail.length, input.digest)}${utf8.decode(tail)}`,
    originalBytes: input.originalBytes,
    digest: input.digest,
    truncated: true,
  };
};

/** The same proportions as `limit`, at a smaller total. */
const scaled = (limit: HeadTailLimit, total: number): HeadTailLimit => {
  const head = Math.floor((total * limit.head) / limit.total);
  return { total, head, tail: total - head };
};

/**
 * Validates, normalises and cuts one input. A number limit keeps the start; a
 * head-and-tail limit keeps both ends around a marker line.
 */
export const prepareInput = (raw: Uint8Array, limit: number | HeadTailLimit): NormalisedInput => {
  const cleaned = clean(raw);
  if (!cleaned.ok) return cleaned;
  const prepared = typeof limit === "number" ? cutHead(cleaned, limit) : cutHeadTail(cleaned, limit);
  // Every limit in INPUT_LIMITS holds its marker; one that cannot is a programming error.
  if (prepared === null) throw new Error("the limit cannot hold the truncation marker");
  return { ok: true, ...prepared };
};

export type WorkRunSource = "executionBrief" | "ciLog" | "dependabotBody";

const utf8Length = (prepared: PreparedText | null) => (prepared === null ? 0 : encoder.encode(prepared.text).length);

/**
 * A work run's external inputs, each cut to its own limit, then cut further to
 * the run total -- the CI log first, the dependabot body second -- because the
 * card brief is the work and the rest is evidence. Each source keeps the digest
 * and size of what was received, which the run records as `input_truncated`.
 */
export const prepareWorkRunInputs = (inputs: {
  executionBrief: Uint8Array;
  ciLog?: Uint8Array;
  dependabotBody?: Uint8Array;
}):
  | {
      ok: true;
      brief: PreparedText;
      ciLog: PreparedText | null;
      dependabotBody: PreparedText | null;
      truncated: WorkRunSource[];
    }
  | { ok: false; source: WorkRunSource; detail: string } => {
  const cleanedBrief = clean(inputs.executionBrief);
  if (!cleanedBrief.ok) return { ok: false, source: "executionBrief", detail: cleanedBrief.detail };
  const cleanedCi = inputs.ciLog ? clean(inputs.ciLog) : null;
  if (cleanedCi !== null && !cleanedCi.ok) return { ok: false, source: "ciLog", detail: cleanedCi.detail };
  const cleanedDependabot = inputs.dependabotBody ? clean(inputs.dependabotBody) : null;
  if (cleanedDependabot !== null && !cleanedDependabot.ok) {
    return { ok: false, source: "dependabotBody", detail: cleanedDependabot.detail };
  }

  const brief = cutHeadTail(cleanedBrief, INPUT_LIMITS.executionBrief);
  if (brief === null) return { ok: false, source: "executionBrief", detail: "limit_below_marker" };
  let ciLog = cleanedCi === null ? null : cutHeadTail(cleanedCi, INPUT_LIMITS.ciLog);
  if (cleanedCi !== null && ciLog === null) return { ok: false, source: "ciLog", detail: "limit_below_marker" };
  let dependabotBody = cleanedDependabot === null ? null : cutHead(cleanedDependabot, INPUT_LIMITS.dependabotBody);

  const over = () => utf8Length(brief) + utf8Length(ciLog) + utf8Length(dependabotBody) - INPUT_LIMITS.workRunTotal;
  if (over() > 0 && cleanedCi !== null && ciLog !== null) {
    const total = utf8Length(ciLog) - over();
    ciLog = total > 0 ? cutHeadTail(cleanedCi, scaled(INPUT_LIMITS.ciLog, total)) : null;
    if (ciLog === null) return { ok: false, source: "ciLog", detail: "exceeds_run_total" };
  }
  if (over() > 0 && cleanedDependabot !== null && dependabotBody !== null) {
    const total = utf8Length(dependabotBody) - over();
    if (total < 0) return { ok: false, source: "dependabotBody", detail: "exceeds_run_total" };
    dependabotBody = cutHead(cleanedDependabot, total);
  }
  if (over() > 0) return { ok: false, source: "executionBrief", detail: "exceeds_run_total" };

  const truncated: WorkRunSource[] = [];
  if (brief.truncated) truncated.push("executionBrief");
  if (ciLog?.truncated) truncated.push("ciLog");
  if (dependabotBody?.truncated) truncated.push("dependabotBody");
  return { ok: true, brief, ciLog, dependabotBody, truncated };
};

/**
 * A registration round's items: each cut to its own limit, and items beyond the
 * round total deferred to the next round rather than cut again. An offered item
 * carries the digest of its original, which is what the registration records.
 */
export const prepareRegistrationRound = <T extends { key: string; raw: Uint8Array }>(
  items: readonly T[],
): { offered: Array<T & PreparedText>; deferred: string[]; rejected: string[] } => {
  const offered: Array<T & PreparedText> = [];
  const deferred: string[] = [];
  const rejected: string[] = [];
  let used = 0;
  for (const item of items) {
    const cleaned = clean(item.raw);
    if (!cleaned.ok) {
      rejected.push(item.key);
      continue;
    }
    const prepared = cutHead(cleaned, INPUT_LIMITS.registrationItem);
    const bytes = utf8Length(prepared);
    if (used + bytes > INPUT_LIMITS.registrationRound) {
      deferred.push(item.key);
      continue;
    }
    used += bytes;
    offered.push({ ...item, ...prepared });
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
        | "clone_root_not_canonical"
        | "outside_clone"
        | "symlink"
        | "not_a_file"
        | "not_text"
        | "budget_exhausted";
    };

/** Separators as forward slashes, no trailing one. Case is left alone. */
const slashed = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * One `read_file` call. The clone root must already be its own real path --
 * the runner passes the path it created, resolved -- so a root that is, or sits
 * under, a symlink or junction is refused rather than followed. Case is not
 * folded: on a case-insensitive filesystem a root spelled differently from its
 * real path is refused, which costs availability, never containment.
 *
 * The path must be exactly a tracked path; every component below the root is
 * checked for symlinks, the real path must stay inside the clone, the target
 * must be a regular file, and the denylist applies to tracked files too. Bytes
 * read count against the session budget.
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
  const root = slashed(input.cloneRoot);
  if (root === "" || slashed(await input.ports.realpath(input.cloneRoot)) !== root) {
    return { ok: false, reason: "clone_root_not_canonical" };
  }
  const segments = requested.split("/");
  for (let i = 1; i <= segments.length; i += 1) {
    const partial = `${root}/${segments.slice(0, i).join("/")}`;
    if (await input.ports.lstatIsSymlink(partial)) return { ok: false, reason: "symlink" };
  }
  const absolute = `${root}/${requested}`;
  const real = slashed(await input.ports.realpath(absolute));
  if (!real.startsWith(`${root}/`)) return { ok: false, reason: "outside_clone" };
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
/**
 * Proposed session limits; fixed by policy revision before shadow.
 *
 * docs/policy/engineering-agent.md §6: the input limit covers the system prompt, the external text and
 * the tool results together, and the tool budget plus the rest must fit inside
 * it. `maxRequestBytes` is that limit, checked on every request body: a token
 * is at least one byte of the text it encodes, so the byte limit bounds the
 * input tokens too. What is left after the three fixed parts is room for the
 * model's own turns coming back, which the same check covers.
 */
export const SESSION_LIMITS = {
  maxTurns: 24,
  maxOutputTokens: 32_000,
  maxSystemBytes: 16 * KB,
  /** The larger of a work run's and a registration round's external text, plus framing. */
  maxUserContentBytes: INPUT_LIMITS.registrationRound + 4 * KB,
  maxToolBytes: 256 * KB,
  maxRequestBytes: 512 * KB,
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
  },
  body: JSON.stringify({
    model: input.model,
    max_tokens: SESSION_LIMITS.maxOutputTokens,
    system: input.system,
    tools: [READ_FILE_TOOL],
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
    !m.tests.every((test: unknown) => typeof test === "string" && test.length <= 256)
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
        | "input_too_large"
        | "request_too_large"
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
  if (
    encoder.encode(input.system).length > SESSION_LIMITS.maxSystemBytes ||
    encoder.encode(input.userContent).length > SESSION_LIMITS.maxUserContentBytes
  ) {
    return { ok: false, reason: "input_too_large" };
  }
  const messages: ModelMessage[] = [{ role: "user", content: input.userContent }];
  let toolBytes = 0;
  for (let turn = 1; turn <= SESSION_LIMITS.maxTurns; turn += 1) {
    const request = buildModelRequest({
      apiKey: input.apiKey,
      model: input.model ?? DEFAULT_MODEL,
      system: input.system,
      messages,
    });
    if (encoder.encode(request.body).length > SESSION_LIMITS.maxRequestBytes) {
      return { ok: false, reason: "request_too_large" };
    }
    let response: { status: number; json: unknown };
    try {
      response = await input.transport(request);
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
