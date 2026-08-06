/**
 * Per-conversation memory mode (policy §8.1, invariant 1).
 *
 * Three stored values and only two effective ones. `inherit` is the default
 * and means "whatever the account says"; `on` and `off` are the user
 * overriding it for this conversation alone. The distinction has to survive
 * in storage, because collapsing `inherit` into today's account default would
 * silently freeze the conversation against a later account change — the user
 * set a default, not a copy of it.
 *
 * The resolution direction is deliberate and is the one place a mistake is
 * dangerous. An unreadable stored value resolves to the account default, and
 * only the exact string `off` disables memory. The column is a string, so a
 * value nobody anticipated must not silently switch a control the user
 * believes is on — and the opposite failure, an unreadable value leaving
 * memory enabled, is contained by the account toggle, the rollout flag and
 * the approved-pair gate that all sit above it (§8.1's "mode must not bypass"
 * clause). Turning something off by accident is worse here than leaving it
 * on, because the layers above still refuse.
 *
 * Pure. The caller supplies the stored value and the account default.
 */

export const CONVERSATION_MEMORY_MODES = ["inherit", "on", "off"] as const;

export type ConversationMemoryMode = (typeof CONVERSATION_MEMORY_MODES)[number];

/** What the injection gate takes: the mode with `inherit` already resolved. */
export type EffectiveMemoryMode = "on" | "off";

export const DEFAULT_CONVERSATION_MEMORY_MODE: ConversationMemoryMode =
    "inherit";

export function isConversationMemoryMode(
    value: unknown
): value is ConversationMemoryMode {
    return (
        typeof value === "string" &&
        (CONVERSATION_MEMORY_MODES as readonly string[]).includes(value)
    );
}

/**
 * The mode this conversation actually runs under.
 *
 * `accountDefault` is `UserMemorySettings.defaultConversationMode`, itself a
 * string column, so it is normalized the same way rather than trusted.
 */
export function resolveConversationMemoryMode(
    storedMode: string | null | undefined,
    accountDefault: string | null | undefined
): EffectiveMemoryMode {
    if (storedMode === "off") return "off";
    if (storedMode === "on") return "on";
    // `inherit`, null, and anything unrecognized: the account decides.
    return accountDefault === "off" ? "off" : "on";
}

/**
 * Whether a stored mode overrides the account rather than following it. Used
 * to tell a user their conversation differs from their default, and to tell
 * §22's proxy that a user turned memory *off here*, which is a decision about
 * this conversation rather than a change of mind about the feature.
 */
export function overridesAccountDefault(storedMode: string | null | undefined) {
    return storedMode === "on" || storedMode === "off";
}
