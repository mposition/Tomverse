/**
 * The `around` parameter of the continuation timeline read: the id of one
 * imported message the page should be centred on (a search hit).
 *
 * A scroll position, never evidence of access: the server resolves the id
 * inside the snapshot the caller may already read, and an id it cannot find
 * there answers exactly like one that does not exist. The id alphabet is the
 * one Prisma's `cuid()` produces; anything else is refused rather than
 * forwarded into a query.
 */
const MESSAGE_ID = /^[a-z0-9]{1,64}$/;

/** The raw `ExternalMessage.id`, or `null` for anything that is not one. */
export function parseAroundMessageId(value: string | null | undefined): string | null {
    return value && MESSAGE_ID.test(value) ? value : null;
}
