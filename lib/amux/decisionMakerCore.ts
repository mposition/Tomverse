import { z } from "zod";

import { detectSecretsInFields } from "../engineeringAgentSecretPatterns.ts";

/**
 * Deterministic core of the AMUX Decision Maker (DM), policy version 2.
 *
 * docs/policy/amux-decision-maker.md. The policy is proposal-only: a DM drafts
 * an answer to a worker's typed ask and nothing reaches the worker before the
 * operator confirms it in Admin. This module decides, without an LLM, whether
 * a question goes to a DM for a proposal (section 3), which instance gets it
 * (section 7), whether the card and snapshot inputs are well formed (sections
 * 4 and 5), and whether a DM output is valid (section 6). It has no I/O.
 */

/**
 * The policy version a request row records as a section 9 binding value.
 * Version 2 (approved 2026-10-17) changed only the fixed execution conditions
 * of sections 5 and 5a; the routing, the effect classes, the card and the
 * output schema here read the same in both versions. A row keeps the version
 * it was routed under, and a result binds to that stored value, not to this
 * constant. Raised from 1 on 2026-10-18 (stage S2-2b1).
 */
export const DM_POLICY_VERSION = 2;

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

/**
 * Section 0-1: the types a DM may draft for. `customer_outbound` is never one:
 * a message to a customer leaves Tomverse, and the DM approver (§0a-1) would
 * otherwise apply it without a person.
 */
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

/**
 * The one generous per-tick count of the Decision Maker's card services
 * (owner direction 2026-11-16: "넉넉한 값 하나로"): the cards each service hands
 * the relay per tick -- a v22 worker's questions, result reviews, owner
 * settlements, engineering T2 drafts, idea card closes -- each was 3. A
 * service's scan of pending rows reads `AMUX_DM_PENDING_SCAN`, so rows that
 * cannot be filed never hide the rest. The relay reads the sync answer up to
 * its cap (dm_relay/flow.rs, `V22QuestionSync`), which holds this many cards
 * at the card's one cap, six bytes a byte as JSON.
 */
export const AMUX_DM_TICK_LIMIT = 25;
export const AMUX_DM_PENDING_SCAN = AMUX_DM_TICK_LIMIT * 8;

/** Section 7: the DM serves the vendor that is not the asking worker's. */
export const DM_INSTANCE_FOR_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  claude: "decision-maker-openai",
  codex: "decision-maker-anthropic",
});

/** Own keys only: an inherited name such as `toString` is not a provider. */
export const dmInstanceForProvider = (provider: string): string | null =>
  Object.hasOwn(DM_INSTANCE_FOR_PROVIDER, provider) ? DM_INSTANCE_FOR_PROVIDER[provider] : null;


/**
 * Section 5: a card's one size cap, on its whole card text (`dmCardText`), in
 * UTF-8 bytes. Owner decision 2026-11-15 ("4000자 제한도 없애주세요"): no card
 * field has a length cap of its own any more -- the question, the context, the
 * labels, the number of context paths -- and the evidence a card is about goes
 * to the DM's workspace whole (lib/amux/decisionMakerWorkspaceCore.ts), not
 * into the card. What remains is the real limit behind it: the card is the
 * vendor CLI's prompt, read whole on stdin, and 256 KiB (64-90k tokens) leaves
 * most of the smaller vendor context window for what the DM reads in its
 * workspace. The body store's `card_text` row has the same cap (migration
 * 20261115140000_amux_dm_card_text_cap). It replaces 16 KiB, which §5 set when
 * the card was all a DM could read.
 */
export const DM_CARD_TEXT_MAX_BYTES = 256 * 1024;
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

/**
 * Section 4's effect classes, in the table's order. The worker declares one
 * per option, and a class that changes files names the repository paths it
 * would change, 1 to 50 of them. The list is the policy's table, so changing
 * it is a change of the policy; section 1 also names the vocabulary among what
 * a DM cannot change.
 */
export const DM_EFFECT_CLASSES = [
  "choice_only",
  "wait_or_defer",
  "branch_code_change",
  "docs_change",
  "test_change",
  "other",
] as const;
export type DmEffectClass = (typeof DM_EFFECT_CLASSES)[number];

/** The classes that change files on the worker's branch, and so name paths. */
export const DM_CHANGE_EFFECT_CLASSES = ["branch_code_change", "docs_change", "test_change"] as const;
export const DM_CHANGE_PATHS_MIN = 1;
export const DM_CHANGE_PATHS_MAX = 50;

/**
 * An option's effect declaration in the form local AMUX records it (stage
 * S2-1, `recorded_effect` in vendor/amux/crates/amux-server/src/db/dm_ask.rs):
 * one of the six classes, with paths exactly when the class is a change class
 * -- 1 to 50 of them, each passing the repository path grammar of section 5,
 * none repeated -- and no path otherwise. Local AMUX never refuses a
 * declaration: a missing or malformed one is recorded as `other` with no paths
 * (section 4's `other` row), so every option it relays is in this form.
 *
 * The router does not route on which class an option declares (section 4: "v1에서
 * 이 선언은 라우팅에 쓰지 않는다", unchanged in version 2), so any well-formed
 * declaration routes the same. An option outside the form was not written by
 * that recording, and the router sends its card to the operator as an input it
 * does not take (section 3-7, as for an option id outside the grammar); it
 * never rewrites the option into `other` itself, because the card text the body
 * store keeps must be the card the router decided on.
 */
export const dmOptionEffectWellFormed = (option: { effect: string; paths: readonly string[] }): boolean => {
  if (!(DM_EFFECT_CLASSES as readonly string[]).includes(option.effect)) return false;
  if (!(DM_CHANGE_EFFECT_CLASSES as readonly string[]).includes(option.effect)) return option.paths.length === 0;
  return (
    option.paths.length >= DM_CHANGE_PATHS_MIN &&
    option.paths.length <= DM_CHANGE_PATHS_MAX &&
    option.paths.every((path) => repositoryPathRefusal(path) === null) &&
    new Set(option.paths).size === option.paths.length
  );
};

/**
 * Section 10: body field caps, which also bound the DM output (section 6).
 * Owner decision 2026-11-15: a DM's answer is never refused for its length.
 * Each text field's cap is the whole output's (DM_LAUNCH_OUTPUT_MAX_BYTES in
 * lib/amux/decisionMakerLauncherCore.ts, the results route's body), so an
 * output the launcher returns can never fail validation on a field's size.
 * They were 8 KiB, 4 KiB and 1 KiB.
 */
export const DM_OUTPUT_TEXT_MAX_BYTES = 256 * 1024;
export const DM_ANSWER_MAX_BYTES = DM_OUTPUT_TEXT_MAX_BYTES;
export const DM_RATIONALE_MAX_BYTES = DM_OUTPUT_TEXT_MAX_BYTES;
export const DM_ESCALATION_MAX_BYTES = DM_OUTPUT_TEXT_MAX_BYTES;

/**
 * Section 3-3's term list. A hit sends the question to the operator without a
 * DM. Korean terms match as substrings; English terms match whole words,
 * case-insensitively.
 *
 * The DM approver applies a DM proposal without the operator (§0a-1), so this
 * list is the deterministic check that keeps §0a-4's human boundaries with a
 * person: money, deletion, a main merge, production, a secret, an external
 * post or send, an access grant and a gate change. Owner direction 2026-11-16
 * dropped the migration category and the broad words that only looked like a
 * boundary ("ship", "release", "deploy", "배포", "덮어쓰", "초기화",
 * "overwrite", a bare "drop"). The secret check of the card's text
 * (`card_secret_detected`) is a separate check and stays.
 */
/**
 * The only clauses the exception admits, whole from the clause's start (after
 * the last comma) to the sentence's end: "(목록은) Free·Pro·Max 권한을
 * 구분합니다" and "(플랜) 권한에 따라 문구가 다릅니다". Anything else after the
 * describing word -- "구분 없이 지급합니다" -- is not one.
 */
const PLAN_DESCRIPTION_CLAUSE = new RegExp(
  "^\\s*(?:(?:[가-힣A-Za-z]+\\s+){0,2}[가-힣A-Za-z]+(?:은|는)\\s+)?" +
  "(?:(?:(?:free|pro|max|guest|plus|team)\\s*[·,/]?\\s*)+(?:플랜\\s*)?|(?:플랜|요금제)\\s*)(?:별\\s*)?권한" +
  "(?:(?:을|를)\\s*(?:구분|비교)(?:합니다|해요|한다|됩니다)|에\\s*따라\\s*[가-힣]+(?:이|가)\\s*(?:다릅니다|달라집니다))\\s*$",
  "i",
);
/** A request or question, whatever its verb. */
const REQUEST_FORM = /까요|까\s|할지|될지|해도|하면|하시겠|주세요|해\s*주|합시다|하자|드릴/;
/** Stems of granting, changing, switching or taking away; wide on purpose ("줄" also hits "줄이다"). */
const ACCESS_CHANGE_STEM =
  /주|줘|줄|준|부여|변경|바꾸|바꿔|바꿀|바뀌|수정|설정|추가|삭제|제거|회수|열|올리|올려|올릴|높|낮|상승|승격|격상|허용|받|얻|요청|필요|빼|넓|확대|축소|위임|할당|박탈|해제|풀|없애|활성|비활성|켜|켤|끄|꺼|끌|적용|전환|승인|부활|복구|차단|제한/;

/**
 * Whether a text's Korean "권한" names access. Every one does, except a
 * clause that is exactly a plan description (`PLAN_DESCRIPTION_CLAUSE`) in a
 * sentence that is not a request or question and has no changing verb
 * ("플랜별 목록은 Free·Pro·Max 권한을 구분합니다."). The exception is narrow on
 * purpose: five independent review rounds each found an access change that a
 * looser rule let through.
 */
export function koreanAccessTermHit(text: string): boolean {
  for (let at = text.indexOf("권한"); at !== -1; at = text.indexOf("권한", at + 2)) {
    const head = text.slice(0, at);
    const start = Math.max(...[".", "?", "!", "\n", "。"].map((mark) => head.lastIndexOf(mark))) + 1;
    const rest = text.slice(at + 2);
    const end = rest.search(/[.?!\n。]/);
    const after = end === -1 ? rest : rest.slice(0, end);
    const sentence = text.slice(start, at) + after;
    const question = end !== -1 && rest[end] === "?";
    const clauseStart = Math.max(start, head.lastIndexOf(",") + 1);
    const clause = text.slice(clauseStart, at) + "권한" + after;
    const planDescription = PLAN_DESCRIPTION_CLAUSE.test(clause) &&
      !question && !REQUEST_FORM.test(sentence) && !ACCESS_CHANGE_STEM.test(sentence);
    if (!planDescription) return true;
  }
  return false;
}

export const DM_IRREVERSIBLE_TERMS: ReadonlyArray<{
  category: string;
  korean: readonly string[];
  /** A Korean hit a substring cannot say (the access entry's "권한" rule). */
  koreanTest?: (text: string) => boolean;
  english: readonly string[];
}> = [
  { category: "main_merge", korean: ["main 병합", "main에 병합", "main으로 병합"], english: ["merge to main", "merge into main", "merge main"] },
  { category: "release", korean: ["프로덕션", "운영 환경", "운영 배포"], english: ["production", "prod"] },
  { category: "destroy", korean: ["삭제"], english: ["delete", "drop table", "drop database", "truncate", "wipe", "purge", "force push", "force-push"] },
  { category: "money", korean: ["결제", "환불", "청구"], english: ["payment", "refund", "charge", "invoice"] },
  { category: "outbound", korean: ["게시", "발송", "연락"], english: ["publish", "post to", "send to", "send email", "send an email", "email the", "tweet", "notify", "contact"] },
  { category: "secret", korean: ["비밀번호", "비밀값", "토큰", "API 키"], english: ["secret", "token", "password", "api key", "apikey", "credential"] },
  // Every Korean "권한" is still a hit, with one exception (owner decision
  // 2026-11-14, AMUX-PRICINGCOPY-002): a plan's entitlement -- "권한" right after
  // a plan name ("Free·Pro·Max 권한을 구분합니다") -- whose sentence has no
  // verb that grants, changes or takes it away. Two independent reviews showed
  // that listing the access-change forms instead always misses one.
  { category: "access", korean: ["접근 설정"], koreanTest: (text) => koreanAccessTermHit(text), english: ["permission", "permissions", "access control"] },
  { category: "gate", korean: ["정책 변경", "정책 개정", "정책을 바꾸", "정책을 고치", "워크플로"], english: ["policy change", "change the policy", "amend the policy", "workflow", "workflows", "branch protection"] },
];

const englishTermPatterns = DM_IRREVERSIBLE_TERMS.map((entry) => ({
  category: entry.category,
  korean: entry.korean,
  koreanTest: entry.koreanTest ?? (() => false),
  english: entry.english.map(
    (term) => new RegExp(`(?<![A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[ -]")}(?![A-Za-z0-9_])`, "i"),
  ),
}));

/**
 * The operational incident for a DM run that ended `unavailable` (owner
 * decision 2026-11-14). That result is a failed process -- a CLI that could not
 * start, sign in or write its output -- not a judgment, yet the question still
 * goes to the operator as if the DM had looked at it. On 2026-11-14 the
 * anthropic instance's first run in six days exited 1 within two seconds, and
 * every codex worker's question routes to that instance (§7). The incident
 * names the instance and request only; the reason is in the box's broker
 * journal (`amux_dm_broker_request`).
 */
export const dmRunUnavailableIncident = (instance: unknown, requestId: unknown) => ({
  code: "AMUX_DM_RUN_UNAVAILABLE",
  title: "AMUX Decision Maker run failed before judging",
  error: "The Decision Maker process ended without a result; its question went to the operator. Check the instance's CLI sign-in on the AMUX box.",
  severity: "warning" as const,
  context: {
    instance: typeof instance === "string" ? instance.slice(0, 64) : null,
    requestId: typeof requestId === "string" ? requestId.slice(0, 64) : null,
  },
});

/** The categories of the term list that a text hits, in list order. Never the text. */
export const irreversibleTermCategories = (text: string): string[] =>
  englishTermPatterns
    .filter((entry) => entry.korean.some((term) => text.includes(term)) ||
      entry.koreanTest(text) || entry.english.some((pattern) => pattern.test(text)))
    .map((entry) => entry.category);

/**
 * One option of a card. `effect` and `paths` are section 4's declaration as
 * local AMUX recorded it; the router checks the form (`dmOptionEffectWellFormed`).
 */
export type DmCardOption = {
  id: string;
  label: string;
  effect: string;
  paths: readonly string[];
};

/**
 * The structured fields of a typed ask that a DM may read (section 5: type,
 * question, options with their effect classes and paths, resolution, unblocks,
 * the worker's context and its context paths).
 *
 * The names are the app's camelCase. Local AMUX stores the extension in
 * snake_case (`context_paths`, vendor/amux/crates/amux-server/src/db/dm_ask.rs);
 * the bridge relay renames it, and an option's four keys (`id`, `label`,
 * `effect`, `paths`) are the same words on both sides.
 */
export type DmCard = {
  askType: string;
  resolution: string | null;
  type: string;
  tags: readonly string[];
  title: string;
  question: string;
  options: ReadonlyArray<DmCardOption>;
  unblocks: string;
  context: string;
  contextPaths: readonly string[];
};

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * The card text: the one serialization of a card that the body store keeps
 * as its `card_text` (docs/policy/amux-decision-maker.md §10: "질문 카드
 * 텍스트"), so Admin can show the operator the question and the
 * option wording the request was routed with. Added 2026-10-09; before it no
 * writer stored the card at all.
 *
 * It is the JSON text of one object whose keys are, in this order, `format`
 * (always `DM_CARD_TEXT_FORMAT`), then every field of `DmCard` -- §5's card
 * fields a DM receives: `askType`, `resolution`, `type`, `tags`, `title`,
 * `question`, `options` (each `{ id, label, effect, paths }`, in the card's
 * order and with its paths in the order the worker wrote them), `unblocks`,
 * `context` and `contextPaths`. `JSON.stringify` is fully
 * specified (ECMA-262), so the same card is the same bytes on every run; a
 * string is always quoted with `"` and `\` escaped, so no field's text can
 * end a field or start another, and the escaping of control characters and
 * lone surrogates leaves well-formed text without NUL, which PostgreSQL TEXT
 * can hold. Changing the layout is a new `format` value.
 *
 * §5's cap (`DM_CARD_TEXT_MAX_BYTES`) is measured on these bytes (`dmCardTextBytes`), never on the
 * sum of the fields: the stored text is what the cap is about, and a card the
 * body store could not hold is never routed to a DM. The effect classes and
 * paths count towards it, as section 5 lists them among the card's fields.
 *
 * Format `amux-dm-card-text-v2` (2026-10-18, stage S2-2b1) added each option's
 * `effect` and `paths`. The v1 layout, whose options were `{ id, label }`, is
 * not read back: its only writer was a routing route that never wrote it, and a stored text this module
 * cannot read is shown as unreadable, never as a card.
 */
export const DM_CARD_TEXT_FORMAT = "amux-dm-card-text-v2";

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
    options: card.options.map((option) => ({
      id: option.id,
      label: option.label,
      effect: option.effect,
      paths: [...option.paths],
    })),
    unblocks: card.unblocks,
    context: card.context,
    contextPaths: [...card.contextPaths],
  });

/** The UTF-8 bytes of the card text, which §5's one cap holds. */
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
        Object.keys(option).length === 4 &&
        typeof option.id === "string" &&
        typeof option.label === "string" &&
        typeof option.effect === "string" &&
        isStringList(option.paths),
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
    options: (value.options as DmCardOption[]).map(({ id, label, effect, paths }) => ({ id, label, effect, paths })),
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
    fields[`option.${index}.effect`] = option.effect;
    option.paths.forEach((path, pathIndex) => {
      fields[`option.${index}.path.${pathIndex}`] = path;
    });
  });
  card.contextPaths.forEach((path, index) => {
    fields[`contextPath.${index}`] = path;
  });
  return fields;
};

/**
 * Owner decision 2026-11-14 (AMUX process audit bundle 2, AMUXFLOW/B2): the
 * section 3-3 terms judge what the card asks -- its fixed question, options
 * and context -- not the evidence a system card carries for the DM to read (a
 * run's findings, a diff), where words such as "delete" or "token" are code,
 * not a request. A system card wraps that evidence in these markers; with
 * TOMVERSE_AMUX_DM_TERMS_FIXED_TEXT_ONLY=enabled the term check skips it. The
 * secret check still reads the whole card. Off by default.
 */
export const DM_EVIDENCE_OPEN = "[evidence]";
export const DM_EVIDENCE_CLOSE = "[/evidence]";
export const DM_TERMS_FIXED_TEXT_ONLY_ENV = "TOMVERSE_AMUX_DM_TERMS_FIXED_TEXT_ONLY";
export const dmTermsFixedTextOnlyEnabled = (value: string | undefined) => value?.trim() === "enabled";

/** The text the term check reads: every evidence block left out, when exempt. */
export const dmTermCheckText = (text: string, evidenceExempt: boolean) => {
  if (!evidenceExempt) return text;
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf(DM_EVIDENCE_OPEN, at);
    if (open < 0) return out + text.slice(at);
    const close = text.indexOf(DM_EVIDENCE_CLOSE, open + DM_EVIDENCE_OPEN.length);
    // An unclosed block is read whole: nothing hides behind a lone marker.
    if (close < 0) return out + text.slice(at);
    out += text.slice(at, open);
    at = close + DM_EVIDENCE_CLOSE.length;
  }
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
  /**
   * Skip evidence blocks in the term check (AMUXFLOW/B2): true only for a
   * card the app filed itself (an owner settlement card, by its recorded
   * local card) while its switch is on. Absent: every word is read.
   */
  evidenceTermsExempt?: boolean;
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
 * first reason. There is no autonomous route in policy version 1 or 2.
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

  // Section 3-3's inputs. An option's effect class and paths are not among
  // them: they are section 4's declaration, which the router does not route on,
  // and a path is no more prose than a context path, which is not read either.
  // Only a card the app itself filed earns the exemption (the caller proves
  // it); a worker's markers are plain text here.
  const evidenceExempt = input.evidenceTermsExempt === true;
  const termCategories = irreversibleTermCategories(
    [card.type, ...card.tags, card.title, dmTermCheckText(card.question, evidenceExempt),
      ...card.options.map((option) => option.label), card.unblocks,
      dmTermCheckText(card.context, evidenceExempt)].join("\n"),
  );
  if (termCategories.length > 0) refusals.push("irreversible_term");

  if ((DM_RESOLUTION_ASK_TYPES as readonly string[]).includes(card.askType) && card.resolution !== "decision_only") {
    refusals.push("resolution_not_decision_only");
  }

  if (instance === null) refusals.push("provider_unverified");

  // §3-6's throughput cap (20 an hour, 100 a day) is gone (owner decision
  // 2026-11-15: "내부 개발용 Flow입니다. 제한을 줄 이유가 없습니다"). The counts
  // stay in the input for the record; `throughput_exceeded` is no longer made.

  // §5's one cap on the card text the body store keeps (`dmCardText()`), so a
  // card routed to a DM always fits its `card_text` row (§10).
  // `resolution` is a closed list for every ask type, so a free-form value can
  // never ride into the stored card text on a type that skips the §3-4 check.
  // An option's effect declaration must be in the form local AMUX records
  // (`dmOptionEffectWellFormed`): section 4's classes, and section 5's path
  // grammar on the paths a change option declares.
  const cardText = dmCardText(card);
  if (
    (card.resolution !== null && !(DM_RESOLUTIONS as readonly string[]).includes(card.resolution)) ||
    utf8Bytes(cardText) > DM_CARD_TEXT_MAX_BYTES ||
    card.contextPaths.some((path) => repositoryPathRefusal(path) !== null) ||
    !dmCardOptionsWellFormed(card.options) ||
    !card.options.every(dmOptionEffectWellFormed)
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
