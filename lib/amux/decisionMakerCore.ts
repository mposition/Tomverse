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

/**
 * A card's option id: a short token, never prose. The worker writes it, the
 * DM's `select` names it, and the stored proposal keeps it beside the
 * ledger (stage S1d), so the grammar is what stops an id from carrying free
 * text: letters, digits, `_` and `-`, 32 characters at most, starting with a
 * letter or digit. A card whose option ids break it, or repeat one, is an
 * input the router does not send to a DM (section 3-7). Added 2026-10-08 with
 * the S1d review; migration 20261008120000_amux_decision_maker_body_store holds
 * the same pattern as a CHECK.
 */
export const DM_OPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const isDmOptionId = (value: unknown): value is string =>
  typeof value === "string" && DM_OPTION_ID_PATTERN.test(value);

/** Every option id follows the grammar and none repeats. */
export const dmCardOptionsWellFormed = (options: ReadonlyArray<{ id: string }>): boolean =>
  options.every((option) => isDmOptionId(option.id)) && new Set(options.map((option) => option.id)).size === options.length;

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

/**
 * The card text: the one serialization of a card that the body store keeps
 * as its `card_text` (docs/policy/amux-decision-maker.md §10: "질문 카드
 * 텍스트(16 KiB)"), so Admin can show the operator the question and the
 * option wording the request was routed with. Added 2026-10-09; before it no
 * writer stored the card at all.
 *
 * It is the JSON text of one object whose keys are, in this order, `format`
 * (always `DM_CARD_TEXT_FORMAT`), then every field of `DmCard` -- §5's card
 * fields a DM receives: `askType`, `resolution`, `type`, `tags`, `title`,
 * `question`, `options` (each `{ id, label }`, in the card's order),
 * `unblocks`, `context` and `contextPaths`. `JSON.stringify` is fully
 * specified (ECMA-262), so the same card is the same bytes on every run; a
 * string is always quoted with `"` and `\` escaped, so no field's text can
 * end a field or start another, and the escaping of control characters and
 * lone surrogates leaves well-formed text without NUL, which PostgreSQL TEXT
 * can hold. Changing the layout is a new `format` value.
 *
 * §5's 16 KiB is measured on these bytes (`dmCardTextBytes`), never on the
 * sum of the fields: the stored text is what the cap is about, and a card the
 * body store could not hold is never routed to a DM.
 */
export const DM_CARD_TEXT_FORMAT = "amux-dm-card-text-v1";

/** The order of the card text's keys, `format` first. */
export const DM_CARD_TEXT_KEYS = [
  "format",
  "askType",
  "resolution",
  "type",
  "tags",
  "title",
  "question",
  "options",
  "unblocks",
  "context",
  "contextPaths",
] as const;

export const dmCardText = (card: DmCard): string =>
  JSON.stringify({
    format: DM_CARD_TEXT_FORMAT,
    askType: card.askType,
    resolution: card.resolution,
    type: card.type,
    tags: [...card.tags],
    title: card.title,
    question: card.question,
    options: card.options.map((option) => ({ id: option.id, label: option.label })),
    unblocks: card.unblocks,
    context: card.context,
    contextPaths: [...card.contextPaths],
  });

/** The UTF-8 bytes of the card text, which §5's 16 KiB caps. */
export const dmCardTextBytes = (card: DmCard): number => utf8Bytes(dmCardText(card));

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The card a stored card text holds, for Admin. Null unless the text is
 * exactly what `dmCardText()` makes of that card -- the keys in order, the
 * format, the types, and the same bytes again -- so a text this module did
 * not write is never shown as a card.
 */
export const parseDmCardText = (text: unknown): DmCard | null => {
  if (typeof text !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== DM_CARD_TEXT_KEYS.length || !keys.every((key, index) => key === DM_CARD_TEXT_KEYS[index])) {
    return null;
  }
  if (
    value.format !== DM_CARD_TEXT_FORMAT ||
    typeof value.askType !== "string" ||
    (value.resolution !== null && typeof value.resolution !== "string") ||
    typeof value.type !== "string" ||
    !isStringList(value.tags) ||
    typeof value.title !== "string" ||
    typeof value.question !== "string" ||
    !Array.isArray(value.options) ||
    !value.options.every(
      (option) =>
        isPlainRecord(option) &&
        Object.keys(option).length === 2 &&
        typeof option.id === "string" &&
        typeof option.label === "string",
    ) ||
    typeof value.unblocks !== "string" ||
    typeof value.context !== "string" ||
    !isStringList(value.contextPaths)
  ) {
    return null;
  }
  const card: DmCard = {
    askType: value.askType,
    resolution: value.resolution as string | null,
    type: value.type,
    tags: value.tags,
    title: value.title,
    question: value.question,
    options: (value.options as Array<{ id: string; label: string }>).map(({ id, label }) => ({ id, label })),
    unblocks: value.unblocks,
    context: value.context,
    contextPaths: value.contextPaths,
  };
  return dmCardText(card) === text ? card : null;
};

/** Every card string a DM would receive, context paths included, in a fixed order. */
const cardTextFields = (card: DmCard): Record<string, string> => {
  const fields: Record<string, string> = {
    askType: card.askType,
    type: card.type,
    title: card.title,
    question: card.question,
    unblocks: card.unblocks,
    context: card.context,
  };
  if (card.resolution !== null) fields.resolution = card.resolution;
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

  // §5's 16 KiB on the card text the body store keeps (`dmCardText()`), so a
  // card routed to a DM always fits its `card_text` row (§10).
  // `resolution` is a closed list for every ask type, so a free-form value can
  // never ride into the stored card text on a type that skips the §3-4 check.
  const cardText = dmCardText(card);
  if (
    (card.resolution !== null && !(DM_RESOLUTIONS as readonly string[]).includes(card.resolution)) ||
    utf8Bytes(cardText) > DM_CARD_TEXT_MAX_BYTES ||
    card.contextPaths.length > DM_CONTEXT_PATHS_MAX ||
    card.contextPaths.some((path) => repositoryPathRefusal(path) !== null) ||
    !dmCardOptionsWellFormed(card.options)
  ) {
    refusals.push("input_limit_exceeded");
  }

  // Section 3-8: every field as the worker wrote it, and the card text as the
  // body store keeps it and scans it before storing (§10: "저장 전에 secret
  // 검사를 통과해야 한다"), so a card routed to a DM always passes that scan.
  if (detectSecretsInFields({ ...cardTextFields(card), cardText }).length > 0) refusals.push("card_secret_detected");

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
      optionId: z.string().regex(DM_OPTION_ID_PATTERN),
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
