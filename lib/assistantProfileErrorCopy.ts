/**
 * Server refusal code -> the copy key that explains it, for the assistant
 * profile screens.
 *
 * The editor used to render `notice.detail` -- the server's own `error`
 * string -- whenever a save failed. Those strings are written for operators
 * and only exist in English, so a Korean user unticking their last model got
 * `Invalid request payload.`: a sentence in the wrong language, naming no
 * field, offering no next step. Every other failure on the screen had the
 * same shape, because the client never looked at the `code` sitting beside
 * the message.
 *
 * So the mapping lives here, the screens resolve a key rather than a
 * sentence, and adding a refusal to those routes without adding its copy is a
 * failing test rather than a leaked English string. Pure: a code in, a
 * translation key out. The caller resolves the key, so every locale gets the
 * same coverage.
 *
 * This is the same shape as `lib/chatAttachmentErrorCopy.ts`, deliberately:
 * two tables that answer "what do we say about this code" would drift, and
 * the knowledge panel's own inline chain was the start of the second one.
 */

/** Keys under the `assistantProfiles.` namespace in `locales/*.ts`. */
export const ASSISTANT_PROFILE_ERROR_COPY_KEYS: Readonly<
    Record<string, string>
> = {
    // -- What the owner sent ------------------------------------------------
    //
    // `ASSISTANT_PROFILE_INVALID` is a field the server refused;
    // `INVALID_REQUEST` and `INVALID_JSON` are a body it could not read at
    // all, which is this client's own bug rather than the user's. They share
    // a sentence because the *user's* next step is identical -- look at what
    // is in the form -- and inventing a second one would only ask them to
    // tell two failures apart that they cannot act on differently.
    ASSISTANT_PROFILE_INVALID: "assistantProfiles.noticeInvalid",
    INVALID_REQUEST: "assistantProfiles.noticeInvalid",
    INVALID_JSON: "assistantProfiles.noticeInvalid",
    REQUEST_BODY_TOO_LARGE: "assistantProfiles.noticeTooLarge",

    // -- Models -------------------------------------------------------------
    //
    // One sentence for "that model is gone" and "your plan no longer includes
    // it", as the server has one code: from the owner's side they are one
    // problem with one fix, and the copy names both ways out (choose another,
    // or follow the account default).
    ASSISTANT_PROFILE_MODEL_UNAVAILABLE:
        "assistantProfiles.noticeModelUnavailable",

    // -- The profile itself -------------------------------------------------
    ASSISTANT_PROFILE_NOT_FOUND: "assistantProfiles.noticeNotFound",
    ASSISTANT_PROFILE_VERSION_STALE: "assistantProfiles.noticeStale",
    // Both reuse the sentence the list screen already shows for the same
    // state, rather than saying the same thing twice in different words.
    ASSISTANT_PROFILE_QUOTA_EXCEEDED: "assistantProfiles.atCapacity",
    ASSISTANT_PROFILES_DISABLED: "assistantProfiles.disabled",

    // -- Knowledge files ----------------------------------------------------
    //
    // The upload panel's own refusals live here rather than in a chain inside
    // it: it shares these routes' guards, so a profile that is gone or an
    // account at its rate limit reach it too, and a second table would answer
    // those differently from the editor two sections above it. Codes with no
    // entry (a forbidden upload key, say) keep the panel's own "could not add
    // the file" -- there is no useful sentence to write about a mismatch the
    // reader did not cause and cannot act on.
    ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED: "assistantProfiles.knowledgeQuotaExceeded",
    ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE: "assistantProfiles.knowledgeUnsupported",
    ASSISTANT_KNOWLEDGE_DISABLED: "assistantProfiles.knowledgeDisabled",

    // -- Operational --------------------------------------------------------
    API_RATE_LIMITED: "assistantProfiles.noticeRateLimited",
    // Not a server code: a 401 answers `{ error: "Unauthorized" }` with no
    // `code` at all, so the client names the case itself. Worth naming --
    // it is the one failure where "try again" is actively wrong advice.
    //
    // Two readers see it, and the copy has to be true for both. A session can
    // expire mid-edit, but the create screen also renders for somebody who
    // never signed in at all -- only the save is refused -- so the sentence
    // says "you are not signed in" rather than claiming a session ended. It
    // also promises what the screen actually does: the form still holds what
    // they typed.
    UNAUTHENTICATED: "assistantProfiles.noticeSignedOut",
};

/**
 * The copy key for a refusal, or `null` when the code is one these screens
 * have no specific sentence for -- the caller then falls back to its own
 * generic message rather than showing a code, or the server's English.
 */
export const assistantProfileErrorCopyKey = (code?: string | null) =>
    (code && ASSISTANT_PROFILE_ERROR_COPY_KEYS[code]) || null;
