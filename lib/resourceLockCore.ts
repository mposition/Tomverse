/**
 * Resource identity for password locks (Release B, slice B5a).
 *
 * docs/policy/external-conversation-import-and-memory.md §7.
 *
 * Release A locked exactly one kind of thing, so a grant could be named by an
 * id alone. Release B adds imported conversations, and the two id spaces are
 * both cuids from the same generator — nothing stops one from equalling the
 * other. A grant named by id alone would then unlock whichever resource
 * happened to share the string.
 *
 * So a grant is bound to **type and id, in both places it could be forged**:
 * the cookie name it is stored under, and the material its signature covers.
 * Getting only one of those right is not enough — a shared cookie name with
 * different signed material would still let a browser present the wrong grant
 * and get a signature failure that looks like tampering, and shared signed
 * material under different names would still verify if the names ever
 * collided.
 *
 * **The `conversation` namespace is byte-for-byte what Release A shipped.**
 * Its cookie name and signed material are unchanged, so grants a browser is
 * already holding keep working across this deploy. The external namespace is
 * additive: new prefix, new material, no overlap.
 */

export const LOCK_RESOURCE_TYPES = [
    "conversation",
    "external_conversation",
] as const;

export type LockResourceType = (typeof LOCK_RESOURCE_TYPES)[number];

const UNLOCK_COOKIE_PREFIX = "tomverse_unlock";

/**
 * Identifiers a lock may be keyed by.
 *
 * Enforced rather than assumed, and that is the point: both the cookie name
 * and the signed material below are built by concatenation, so an identifier
 * containing a separator could forge another identity. A user id of
 * `alice:conv-1:1700000000` would otherwise produce the same signed material
 * as a different (user, conversation) pair. Account and conversation ids are
 * cuids and satisfy this trivially; the check exists so the property does not
 * depend on that staying true somewhere else.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

const assertLockIdentifier = (value: string, label: string): string => {
    if (!SAFE_IDENTIFIER.test(value)) {
        throw new Error(`Unsafe lock ${label}: must match [A-Za-z0-9_-]{1,128}`);
    }
    return value;
};

/**
 * Cookie name per resource type.
 *
 * `conversation` keeps the bare `tomverse_unlock_<id>` it has always had.
 * Other types use `tomverse_unlock.<type>.<id>`, and the separator is what
 * makes the split structural: the character right after `tomverse_unlock` is
 * `_` for a conversation and `.` for anything else, and identifiers cannot
 * contain `.`, so no id can carry a resource across the boundary. An infix
 * inside the same separator — `tomverse_unlock_ext_<id>` — would NOT do this:
 * a conversation whose id began with `ext_` would collide exactly.
 */
export const unlockCookieNameFor = (
    resourceType: LockResourceType,
    resourceId: string
): string => {
    assertLockIdentifier(resourceId, "resource id");
    return resourceType === "conversation"
        ? `${UNLOCK_COOKIE_PREFIX}_${resourceId}`
        : `${UNLOCK_COOKIE_PREFIX}.${resourceType}.${resourceId}`;
};

/**
 * The string an unlock grant's HMAC covers.
 *
 * `conversation` keeps Release A's exact material (`user:id:expiry:print`), so
 * an outstanding cookie still verifies. Other types interpose their type name,
 * which is what makes a grant non-transferable across types even when the ids
 * match: the signature is over a different string, so it simply does not
 * verify.
 */
export const unlockGrantMaterial = (input: {
    resourceType: LockResourceType;
    userId: string;
    resourceId: string;
    expiresAt: number;
    fingerprint: string;
}): string => {
    assertLockIdentifier(input.userId, "user id");
    assertLockIdentifier(input.resourceId, "resource id");
    return input.resourceType === "conversation"
        ? `${input.userId}:${input.resourceId}:${input.expiresAt}:${input.fingerprint}`
        : `${input.userId}:${input.resourceType}:${input.resourceId}:${input.expiresAt}:${input.fingerprint}`;
};

export const isLockResourceType = (
    value: unknown
): value is LockResourceType =>
    typeof value === "string" &&
    (LOCK_RESOURCE_TYPES as readonly string[]).includes(value);
