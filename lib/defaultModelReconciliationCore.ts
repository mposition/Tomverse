// Pure decision logic for moving stored *selection* state off one model id and
// onto another -- today gpt-5-4-mini -> gpt-5-6-luna.
//
// Prisma-free and side-effect free so the rules can be unit tested directly.
// scripts/run-default-model-reconciliation.mjs is the only thing that turns
// these decisions into writes.
//
// What this may touch: UserSettings.defaultModel and
// Conversation.selectedModels -- mutable selection state that describes what a
// user wants to happen next.
//
// What this must never touch: Message.modelId, ChatCreditReservation,
// UsageBucket, the credit ledger, or any other record of something that
// already happened. A historical model id and the pricing snapshot frozen
// beside it are the evidence for a charge that was already made; rewriting
// them would falsify billing history.

/** The largest selection any caller is allowed to end up with. */
export const DEFAULT_MAX_SELECTED_MODELS = 3;

export type SelectedModelsRewrite =
  | { status: "unchanged" }
  /** Stored value is not a JSON array of strings. Reported, never rewritten. */
  | { status: "malformed"; reason: string }
  | {
      status: "rewritten";
      models: string[];
      /** Serialized form to store back, matching how the column is written. */
      value: string;
      /** Non-fatal anomaly worth surfacing in the run report. */
      warning?: string;
    };

export type DefaultModelRewrite =
  | { status: "unchanged" }
  | { status: "rewritten"; value: string };

/**
 * Exact-match replacement for a single stored model id.
 *
 * Deliberately an equality test rather than a substring or prefix match: ids
 * like `gpt-5-4-mini` are primary keys, and a looser match would also catch a
 * future `gpt-5-4-mini-something` that is a different model.
 */
export const rewriteDefaultModel = (
  storedModelId: string,
  { from, to }: { from: string; to: string }
): DefaultModelRewrite =>
  storedModelId === from ? { status: "rewritten", value: to } : { status: "unchanged" };

/**
 * Rewrites a `Conversation.selectedModels` payload.
 *
 * Parsed as JSON and compared entry by entry -- never a string replace. A
 * naive `replace("gpt-5-4-mini", ...)` on the raw column would also corrupt
 * any id that merely contains the old one, and would happily produce invalid
 * JSON out of a value it did not understand.
 *
 * Rules, in order:
 *   1. Anything that is not a JSON array of strings is reported as malformed
 *      and left exactly as it was found. Destroying a value nobody can explain
 *      is worse than carrying it forward for a human to look at.
 *   2. Each entry equal to `from` becomes `to`, in place, so the user's
 *      existing ordering survives.
 *   3. Duplicates are collapsed keeping the FIRST occurrence, which is what
 *      makes step 2 safe when `to` was already selected alongside `from`.
 *   4. Every other id is passed through untouched.
 *
 * The result can never be longer than the input (a 1:1 replacement followed by
 * deduplication), so this cannot push a conversation over the selection limit.
 * A value that was ALREADY over the limit before this ran is reported as a
 * warning rather than silently truncated: trimming someone's selection is a
 * separate decision from this migration, and doing it here would hide it.
 */
export const rewriteSelectedModels = (
  rawValue: string,
  {
    from,
    to,
    maxSelectedModels = DEFAULT_MAX_SELECTED_MODELS,
  }: { from: string; to: string; maxSelectedModels?: number }
): SelectedModelsRewrite => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return { status: "malformed", reason: "not_valid_json" };
  }
  if (!Array.isArray(parsed)) {
    return { status: "malformed", reason: "not_a_json_array" };
  }
  if (!parsed.every((entry): entry is string => typeof entry === "string")) {
    return { status: "malformed", reason: "contains_non_string_entry" };
  }

  const original: string[] = parsed;
  if (!original.includes(from)) return { status: "unchanged" };

  const rewritten: string[] = [];
  for (const modelId of original) {
    const mapped = modelId === from ? to : modelId;
    if (!rewritten.includes(mapped)) rewritten.push(mapped);
  }

  // Possible when `from` was the only duplicate removed but the stored value
  // still matches -- e.g. ["a"] with from === to. Nothing to write.
  const value = JSON.stringify(rewritten);
  if (value === rawValue) return { status: "unchanged" };

  return {
    status: "rewritten",
    models: rewritten,
    value,
    ...(rewritten.length > maxSelectedModels
      ? {
          warning: `selection holds ${rewritten.length} models, above the limit of ${maxSelectedModels}; left at its stored length rather than truncated`,
        }
      : {}),
  };
};

/**
 * The third stored selection state, and the one the reconciliation script has
 * never touched.
 *
 * `UserSettings.newConversationModelIds` is the source of truth for what a
 * signed-in account's next conversation starts with
 * (docs/policy/default-model-luna-migration.md §1.2), and
 * lib/newConversationModels.ts says in as many words that persisting a change
 * to it is "only ever an explicit user save or an approved retirement
 * reconciliation". The reconciliation did not do it, so a retirement moved
 * `defaultModel` and left this column pointing at the retired id -- which makes
 * a "we changed your settings" notice untrue for the field users actually see
 * on a new conversation.
 *
 * Takes the parsed JSON rather than a string: this column is `Json?`, unlike
 * `Conversation.selectedModels`, which is TEXT holding JSON.
 */
export type NewConversationModelsRewrite =
  | { status: "unset" }
  | { status: "unchanged" }
  | { status: "malformed"; reason: "not_a_non_empty_string_array" }
  | {
      status: "rewritten";
      models: string[];
      /** True when the rewrite changed which model leads the combination. */
      leadChanged: boolean;
      warning?: string;
    };

export const rewriteNewConversationModelIds = (
  raw: unknown,
  {
    from,
    to,
    maxSelectedModels = DEFAULT_MAX_SELECTED_MODELS,
  }: { from: string; to: string; maxSelectedModels?: number }
): NewConversationModelsRewrite => {
  // NULL means "[defaultModel]" and is not stale: it follows whatever
  // defaultModel becomes, so a retirement has nothing to rewrite here.
  if (raw === null || raw === undefined) return { status: "unset" };

  if (!Array.isArray(raw) || raw.length === 0) {
    return { status: "malformed", reason: "not_a_non_empty_string_array" };
  }
  const original: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      // Reported, never repaired. A value the parser cannot understand is a
      // value whose intent we do not know.
      return { status: "malformed", reason: "not_a_non_empty_string_array" };
    }
    original.push(entry.trim());
  }
  if (!original.includes(from)) return { status: "unchanged" };

  const rewritten: string[] = [];
  for (const modelId of original) {
    const mapped = modelId === from ? to : modelId;
    // Collapsing a duplicate is the point: a combination that already held the
    // replacement would otherwise end up naming it twice.
    if (!rewritten.includes(mapped)) rewritten.push(mapped);
  }

  return {
    status: "rewritten",
    models: rewritten,
    leadChanged: original[0] !== rewritten[0],
    ...(rewritten.length > maxSelectedModels
      ? {
          warning: `holds ${rewritten.length} models, above the ${maxSelectedModels} the picker allows`,
        }
      : {}),
  };
};

/**
 * Whether a stored combination and a stored `defaultModel` still agree after a
 * rewrite, and the two are supposed to.
 *
 * Reported rather than corrected. The lead of the combination is a user's
 * choice about which model speaks first, and a reconciliation that reordered it
 * to match `defaultModel` would be making that choice for them -- which is the
 * opposite of what a retirement pass is for.
 */
export const leadOutOfSync = (
  storedModelIds: readonly string[] | null,
  defaultModel: string
): boolean =>
  storedModelIds !== null &&
  storedModelIds.length > 0 &&
  storedModelIds[0] !== defaultModel;

export type ReconciliationCounts = {
  scanned: number;
  rewritten: number;
  unchanged: number;
  malformed: number;
};

export const emptyCounts = (): ReconciliationCounts => ({
  scanned: 0,
  rewritten: 0,
  unchanged: 0,
  malformed: 0,
});
