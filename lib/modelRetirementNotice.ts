/**
 * Why a model cannot answer, said in the reader's language.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md EM-15.
 *
 * The notice used to be one English sentence stored per model --
 * `ModelRegistryEntry.userVisibleNote`, "This model was retired and replaced by
 * Gemini 3.6 Flash." -- returned verbatim to everybody. Korean and Chinese
 * accounts read English, while the retirement *email* for the same event is
 * written in seven languages. Two notices about one fact, disagreeing about
 * what language the reader speaks.
 *
 * Nine of the ten stored sentences said exactly what `replacementModelId`
 * already says. So they are not stored any more: the sentence is derived from
 * the registry and rendered by the client, the same way every other chat
 * refusal is (`lib/chatAttachmentErrorCopy.ts`). A code and a parameter travel;
 * the words are chosen where the locale is known.
 *
 * The `MODEL_RETIRED` branch of the chat route already worked this way -- it
 * sends `replacementModelName` as data and the client renders
 * `chat.modelRetiredWithReplacement`. Those keys are reused rather than
 * duplicated; only the genuinely-temporary case needed a new sentence, and it
 * needed a separate one because "no longer available, pick another" is the
 * wrong thing to tell somebody whose model is coming back.
 *
 * ## What a stored note is still for
 *
 * The tenth said something the registry cannot derive -- that a model left one
 * *product* and where to go instead. An operator writing that is stating
 * something no field holds, and this module does not overrule them: a stored
 * note wins, and travels as text. It cannot be translated, and the shape below
 * says so out loud rather than letting a caller assume the sentence it received
 * is in the reader's language.
 *
 * Pure. The registry lookup belongs to the caller, so a rule about wording can
 * be tested without a database.
 */

/** Keys under the `chat.` namespace in `locales/*.ts`. */
export const MODEL_NOTICE_COPY_KEYS = {
    retired_replaced: "chat.modelRetiredWithReplacement",
    retired: "chat.modelRetired",
    unavailable: "chat.modelTemporarilyUnavailable",
} as const;

export type ModelNoticeKind = keyof typeof MODEL_NOTICE_COPY_KEYS;

/**
 * A notice the client renders, or one an operator wrote.
 *
 * Two shapes rather than one string, because they are not the same kind of
 * thing. `localised` is a fact the registry holds and this app knows how to say
 * in seven languages. `operatorText` is prose somebody typed, in whatever
 * language they typed it, and pretending otherwise is how the English sentence
 * survived translation work in the first place.
 */
export type ModelNotice =
    | {
          source: "localised";
          kind: ModelNoticeKind;
          copyKey: string;
          /**
           * The replacement's display name, for the one key that takes it.
           * A brand name, so it is not translated -- it is interpolated.
           */
          replacementModelName?: string;
      }
    | { source: "operator"; text: string };

export type ModelNoticeInput = {
    /** The stored note, if an operator wrote one. */
    userVisibleNote?: string | null;
    /** The replacement's display name, resolved by the caller. */
    replacementModelName?: string | null;
    /** Whether the model can answer at all right now. */
    unavailable: boolean;
};

/**
 * The notice for one model, or null when there is nothing to say.
 *
 * An operator's note is returned whether or not the model can answer -- a note
 * explaining that a working model is throttled is the case that shape is for.
 * A derived one is not: deriving "retired and replaced by X" for a model that
 * is answering would state something untrue about it, so the derivation only
 * runs once availability says it cannot.
 */
export const modelNotice = (input: ModelNoticeInput): ModelNotice | null => {
    const stored = input.userVisibleNote?.trim();
    if (stored) return { source: "operator", text: stored };
    if (!input.unavailable) return null;

    const replacement = input.replacementModelName?.trim();
    if (replacement) {
        return {
            source: "localised",
            kind: "retired_replaced",
            copyKey: MODEL_NOTICE_COPY_KEYS.retired_replaced,
            replacementModelName: replacement,
        };
    }
    // Deliberately not "retired": a model can be unavailable for an outage, a
    // provider incident or an admin switch, and telling somebody their model is
    // gone when it is coming back is the more expensive of the two mistakes.
    return {
        source: "localised",
        kind: "unavailable",
        copyKey: MODEL_NOTICE_COPY_KEYS.unavailable,
    };
};

/**
 * The English rendering, for places that have no locale to work with.
 *
 * Structured log lines, operator tooling, and the error `message` field that
 * older clients read before they learned to resolve a copy key. Never the
 * primary path: a caller that has a locale renders from the key instead.
 */
export const modelNoticeFallbackText = (notice: ModelNotice | null): string => {
    if (!notice) return "";
    if (notice.source === "operator") return notice.text;
    switch (notice.kind) {
        case "retired_replaced":
            return `This model is no longer available. Please select ${notice.replacementModelName} or another current model.`;
        case "retired":
            return "This model is no longer available. Please select another current model.";
        case "unavailable":
            return "This model is temporarily unavailable.";
    }
};
