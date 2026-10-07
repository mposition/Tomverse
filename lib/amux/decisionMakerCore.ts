import { z } from "zod";

import { detectSecretsInFields } from "../engineeringAgentSecretPatterns.ts";

/**
 * Deterministic core of the AMUX Decision Maker (DM), policy version 1.
 *
 * docs/policy/amux-decision-maker.md. Version 1 is proposal-only: a DM drafts
 * an answer to a worker's typed ask and nothing reaches the worker before the
 * operator confirms it in Admin. This module decides, without an LLM, whether
 * a question goes to a DM for a proposal (section 3), which instance gets it
 * (section 7), whether snapshot inputs are well formed (section 5), and
 * whether a DM output is valid (section 6). It has no I/O.
 */

export const DM_POLICY_VERSION = 1;

/** The seven `ask_type`s a local AMUX typed ask accepts (`ASK_TYPES`). */
export const AMUX_ASK_TYPES = [
  "budget",
  "customer_outbound",
  "decision",
  "access",
  "credential",
  "external",
  "judgment",
] as const;

/** Section 0-1: the six types a DM may draft for. `customer_outbound` is never one. */
export const DM_ALLOWED_ASK_TYPES = [
  "decision",
  "judgment",
  "budget",
  "credential",
  "access",
  "external",
] as const;

/** Section 3-4: these types carry a `resolution`; only `decision_only` reaches a DM. */
export const DM_RESOLUTION_ASK_TYPES = ["credential", "access", "external"] as const;
export const DM_RESOLUTIONS = [
  "needs_secret",
  "needs_permission_change",
  "needs_contact",
  "decision_only",
] as const;

/** Section 7: the DM serves the vendor that is not the asking worker's. */
export const DM_INSTANCE_FOR_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  claude: "decision-maker-openai",
  codex: "decision-maker-anthropic",
});

/** Own keys only: an inherited name such as `toString` is not a provider. */
export const dmInstanceForProvider = (provider: string): string | null =>
  Object.hasOwn(DM_INSTANCE_FOR_PROVIDER, provider) ? DM_INSTANCE_FOR_PROVIDER[provider] : null;

/** Section 3-6. */
export const DM_THROUGHPUT_PER_HOUR = 20;
export const DM_THROUGHPUT_PER_DAY = 100;

/** Section 5. */
export const DM_CARD_TEXT_MAX_BYTES = 16 * 1024;
export const DM_CONTEXT_PATHS_MAX = 64;
export const DM_SNAPSHOT_FILE_MAX_BYTES = 256 * 1024;
export const DM_SNAPSHOT_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
export const DM_REPOSITORY_PATH_MAX_BYTES = 200;

/** Section 10: body field caps, which also bound the DM output (section 6). */
export const DM_ANSWER_MAX_BYTES = 8 * 1024;
export const DM_RATIONALE_MAX_BYTES = 4 * 1024;
export const DM_ESCALATION_MAX_BYTES = 1024;

/**
 * Section 3-3, the v1 term list. A hit sends the question to the operator
 * without a DM. Korean terms match as substrings; English terms match whole
 * words, case-insensitively. A false positive only costs the operator a draft,
 * so the list errs wide. Changing it is a policy version change.
 */
export const DM_IRREVERSIBLE_TERMS: ReadonlyArray<{
  category: string;
  korean: readonly string[];
  english: readonly string[];
}> = [
  { category: "main_merge", korean: ["main 병합", "main에 병합", "main으로 병합"], english: ["merge to main", "merge into main", "merge main"] },
  { category: "release", korean: ["배포", "릴리스", "프로덕션", "운영 환경"], english: ["ship", "release", "deploy", "deployment", "production", "prod"] },
  { category: "destroy", korean: ["삭제", "덮어쓰", "초기화"], english: ["delete", "drop", "truncate", "overwrite", "force push", "force-push", "wipe", "purge"] },
  { category: "migration", korean: ["마이그레이션"], english: ["migration", "migrate"] },
  { category: "money", korean: ["결제", "환불", "청구"], english: ["payment", "refund", "charge", "invoice"] },
  { category: "outbound", korean: ["게시", "발송", "연락"], english: ["publish", "post to", "send to", "send email", "send an email", "email the", "tweet", "notify", "contact"] },
  { category: "secret", korean: ["비밀번호", "비밀값", "토큰", "API 키"], english: ["secret", "token", "password", "api key", "apikey", "credential"] },
  { category: "access", korean: ["권한", "접근 설정"], english: ["permission", "permissions", "access control"] },
  { category: "gate", korean: ["정책 변경", "정책 개정", "정책을 바꾸", "정책을 고치", "워크플로"], english: ["policy change", "change the policy", "amend the policy", "workflow", "workflows", "branch protection"] },
];

const englishTermPatterns = DM_IRREVERSIBLE_TERMS.map((entry) => ({
  category: entry.category,
  korean: entry.korean,
  english: entry.english.map(
    (term) => new RegExp(`(?<![A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[ -]")}(?![A-Za-z0-9_])`, "i"),
  ),
}));

/** The categories of the term list that a text hits, in list order. Never the text. */
export const irreversibleTermCategories = (text: string): string[] =>
  englishTermPatterns
    .filter((entry) => entry.korean.some((term) => text.includes(term)) || entry.english.some((pattern) => pattern.test(text)))
    .map((entry) => entry.category);

/** The structured fields of a typed ask that a DM may read (section 5). */
export type DmCard = {
  askType: string;
  resolution: string | null;
  type: string;
  tags: readonly string[];
  title: string;
  question: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  unblocks: string;
  context: string;
  contextPaths: readonly string[];
};

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** Every card string a DM would receive, context paths included, in a fixed order. */
const cardTextFields = (card: DmCard): Record<string, string> => {
  const fields: Record<string, string> = {
    type: card.type,
    title: card.title,
    question: card.question,
    unblocks: card.unblocks,
    context: card.context,
  };
  card.tags.forEach((tag, index) => {
    fields[`tag.${index}`] = tag;
  });
  card.options.forEach((option, index) => {
    fields[`option.${index}.id`] = option.id;
    fields[`option.${index}.label`] = option.label;
  });
  card.contextPaths.forEach((path, index) => {
    fields[`contextPath.${index}`] = path;
  });
  return fields;
};

export const dmCardTextBytes = (card: DmCard): number =>
  Object.values(cardTextFields(card)).reduce((total, value) => total + utf8Bytes(value), 0);

export type DmRoutingInput = {
  /** `null` when the setting could not be read. */
  killSwitch: boolean | null;
  /** The assigned instance's switch; `null` when unreadable or unset. */
  instanceMode: "off" | "proposal" | null;
  card: DmCard;
  /** The asking worker's provider id. */
  askingProvider: string;
  /** Requests already routed to the instance in the trailing hour and day. */
  throughput: { lastHour: number; lastDay: number };
};

export type DmRoutingRefusal =
  | "kill_switch_on"
  | "settings_unreadable"
  | "instance_off"
  | "ask_type_not_allowed"
  | "irreversible_term"
  | "resolution_not_decision_only"
  | "provider_unverified"
  | "throughput_exceeded"
  | "input_limit_exceeded"
  | "card_secret_detected";

export type DmRoutingDecision =
  | { route: "dm_proposal"; instance: string; refusals: [] }
  | { route: "operator"; instance: string | null; refusals: DmRoutingRefusal[]; termCategories: string[] };

/**
 * Section 3. Every check runs, and any hit routes to the operator; the
 * decision records all of them so a refusal is never explained by only the
 * first reason. There is no autonomous route in policy version 1.
 */
export const routeDmQuestion = (input: DmRoutingInput): DmRoutingDecision => {
  const refusals: DmRoutingRefusal[] = [];
  const instance = dmInstanceForProvider(input.askingProvider);
  const { card } = input;

  if (input.killSwitch === null || (instance !== null && input.instanceMode === null)) {
    refusals.push("settings_unreadable");
  }
  if (input.killSwitch === true) refusals.push("kill_switch_on");
  if (instance !== null && input.instanceMode === "off") refusals.push("instance_off");

  if (!(DM_ALLOWED_ASK_TYPES as readonly string[]).includes(card.askType)) {
    refusals.push("ask_type_not_allowed");
  }

  const termCategories = irreversibleTermCategories(
    [card.type, ...card.tags, card.title, card.question, ...card.options.map((option) => option.label), card.unblocks, card.context].join("\n"),
  );
  if (termCategories.length > 0) refusals.push("irreversible_term");

  if ((DM_RESOLUTION_ASK_TYPES as readonly string[]).includes(card.askType) && card.resolution !== "decision_only") {
    refusals.push("resolution_not_decision_only");
  }

  if (instance === null) refusals.push("provider_unverified");

  if (input.throughput.lastHour >= DM_THROUGHPUT_PER_HOUR || input.throughput.lastDay >= DM_THROUGHPUT_PER_DAY) {
    refusals.push("throughput_exceeded");
  }

  if (
    dmCardTextBytes(card) > DM_CARD_TEXT_MAX_BYTES ||
    card.contextPaths.length > DM_CONTEXT_PATHS_MAX ||
    card.contextPaths.some((path) => repositoryPathRefusal(path) !== null)
  ) {
    refusals.push("input_limit_exceeded");
  }

  if (detectSecretsInFields(cardTextFields(card)).length > 0) refusals.push("card_secret_detected");

  if (refusals.length === 0 && instance !== null) {
    return { route: "dm_proposal", instance, refusals: [] };
  }
  return { route: "operator", instance, refusals, termCategories };
};

export type RepositoryPathRefusal =
  | "empty"
  | "too_long"
  | "absolute"
  | "dot_segment"
  | "empty_segment"
  | "backslash"
  | "url_syntax"
  | "control_character";

/**
 * Section 5: the `repositoryPaths` grammar of docs/policy/amux-intake.md
 * (relative to the repository root, 200 bytes, no `..`, no absolute path),
 * plus no `.` or empty segment, no backslash, no `%`, `?` or `#`, and no
 * control character. `null` means the path is acceptable.
 */
export const repositoryPathRefusal = (path: string): RepositoryPathRefusal | null => {
  if (path.length === 0) return "empty";
  if (utf8Bytes(path) > DM_REPOSITORY_PATH_MAX_BYTES) return "too_long";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control_character";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "absolute";
  if (path.includes("\\")) return "backslash";
  if (/[%?#]/.test(path)) return "url_syntax";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) return "empty_segment";
  if (segments.some((segment) => segment === "." || segment === "..")) return "dot_segment";
  return null;
};

/** The URL path of a checked repository path, one percent-encoded segment at a time. */
export const encodeRepositoryPath = (path: string): string => {
  if (repositoryPathRefusal(path) !== null) throw new Error("repository_path_refused");
  return path.split("/").map(encodeURIComponent).join("/");
};

/**
 * Section 5, the v1 secret path list. Each pattern is matched against the
 * file name, and `*secret*` and `*credential*` also against every directory
 * name, case-insensitively.
 */
export const DM_SECRET_PATH_PATTERNS = [
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_*",
  "*secret*",
  "*credential*",
  ".npmrc",
  ".netrc",
  ".pgpass",
] as const;

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
const secretNamePatterns = DM_SECRET_PATH_PATTERNS.map(globToRegExp);
const secretSegmentPatterns = ["*secret*", "*credential*"].map(globToRegExp);

export const isSecretRepositoryPath = (path: string): boolean => {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  return (
    secretNamePatterns.some((pattern) => pattern.test(name)) ||
    segments.slice(0, -1).some((segment) => secretSegmentPatterns.some((pattern) => pattern.test(segment)))
  );
};

/** Section 5: a snapshot target is a full lowercase commit id, nothing else. */
export const isSnapshotTargetSha = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);

/** Section 5: only regular files are fetched; directories, symlinks and submodules never are. */
export const isFetchableTreeMode = (mode: string): boolean => mode === "100644" || mode === "100755";

const boundedText = (max: number) =>
  z.string().min(1).refine((value) => utf8Bytes(value) <= max, { message: "too_long" });

/** Section 6: exactly one strict value of one of three kinds. */
export const dmOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("select"),
      optionId: z.string().min(1).max(200),
      rationale: boundedText(DM_RATIONALE_MAX_BYTES),
      irreversible: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("free_text"),
      answer: boundedText(DM_ANSWER_MAX_BYTES),
      rationale: boundedText(DM_RATIONALE_MAX_BYTES),
      irreversible: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("escalate"),
      reason: boundedText(DM_ESCALATION_MAX_BYTES),
    })
    .strict(),
]);

export type DmOutput = z.infer<typeof dmOutputSchema>;

export type DmOutputValidationFailure = "schema" | "unknown_option" | "secret_detected";

export type DmOutputVerdict =
  | { outcome: "proposal"; output: Extract<DmOutput, { kind: "select" | "free_text" }>; irreversible: boolean }
  | { outcome: "escalate"; output: Extract<DmOutput, { kind: "escalate" }> }
  | { outcome: "validation_failure"; failure: DmOutputValidationFailure };

/**
 * Section 6. Only a schema violation, an unknown option id or a secret hit is
 * a validation failure, which counts towards the off latch. An escalation is
 * not a failure, and `irreversible: true` still stores the proposal: the
 * operator sees the flag first.
 */
export const validateDmOutput = (raw: unknown, optionIds: readonly string[]): DmOutputVerdict => {
  const parsed = dmOutputSchema.safeParse(raw);
  if (!parsed.success) return { outcome: "validation_failure", failure: "schema" };
  const output = parsed.data;

  const texts: Record<string, string> =
    output.kind === "escalate"
      ? { reason: output.reason }
      : output.kind === "select"
        ? { rationale: output.rationale }
        : { answer: output.answer, rationale: output.rationale };
  if (detectSecretsInFields(texts).length > 0) return { outcome: "validation_failure", failure: "secret_detected" };

  if (output.kind === "escalate") return { outcome: "escalate", output };
  if (output.kind === "select" && !optionIds.includes(output.optionId)) {
    return { outcome: "validation_failure", failure: "unknown_option" };
  }
  return { outcome: "proposal", output, irreversible: output.irreversible };
};
