import "server-only";

import { createUnsubscribeToken, readUnsubscribeKeyring } from "@/lib/unsubscribeToken";

/**
 * The `List-Unsubscribe` headers, and who gets them.
 *
 * Contract: docs/policy/email-notifications.md §5.1 C5, C10.
 *
 * C5 requires them on marketing mail: the major mailbox providers expect
 * one-click unsubscribe from bulk senders, and RFC 8058 is how it is offered.
 *
 * C10 forbids them everywhere else, and that half matters more. Several mail
 * clients surface `List-Unsubscribe` as a prominent button; on a login code
 * that button unsubscribes somebody from their own authentication. The rule is
 * therefore keyed on the template's own `requiresUnsubscribe` flag, which the
 * database holds as a CHECK against the classification -- so a message can only
 * carry these headers if the classification it was registered under says it
 * must.
 */

export type UnsubscribeTarget = {
  requiresUnsubscribe: boolean;
  userId: string | null;
  purpose: string | null;
  deliveryId: string;
  appUrl: string;
};

/**
 * Why a message that needs an unsubscribe link cannot have one.
 *
 * A named refusal rather than a thrown error, because the drain's outer
 * try/catch turned the throw into `EMAIL_RENDER_FAILED` -- and "the unsubscribe
 * key is missing" reported as "rendering failed" is the difference between an
 * operator setting one environment variable and an operator reading a template
 * (EM-10).
 */
export type UnsubscribeRefusal = "unsubscribe_keys_missing";

export type UnsubscribeLink =
  | { ok: true; url: string | null }
  | { ok: false; refusal: UnsubscribeRefusal; message: string };

/**
 * The one-click URL, or null for a message that has no unsubscribe at all.
 *
 * Split out so the footer link and the `List-Unsubscribe` header are the same
 * URL rather than two independently built ones. A footer that unsubscribes from
 * a different thing than the header does is worse than either alone: whichever
 * one the recipient uses, they have reason to believe the other worked too.
 *
 * `{ ok: true, url: null }` and `{ ok: false }` are different answers and the
 * caller must keep them apart: the first is a transactional message that
 * correctly has no unsubscribe, the second is a marketing message that must not
 * be sent at all.
 */
export const unsubscribeUrl = (input: UnsubscribeTarget): UnsubscribeLink => {
  if (!input.requiresUnsubscribe || !input.userId || !input.purpose) {
    return { ok: true, url: null };
  }

  const keyring = readUnsubscribeKeyring(process.env);
  if (!keyring) {
    // A marketing message with no working unsubscribe link is one that must not
    // be sent at all, so this is a refusal rather than a message without
    // headers.
    return {
      ok: false,
      refusal: "unsubscribe_keys_missing",
      message:
        "EMAIL_UNSUBSCRIBE_KEYS is not configured, so no unsubscribe link can be " +
        "generated. Marketing mail cannot be sent without one.",
    };
  }

  const token = createUnsubscribeToken(
    { userId: input.userId, purpose: input.purpose, deliveryId: input.deliveryId },
    keyring
  );
  return {
    ok: true,
    url: `${input.appUrl}/unsubscribe?t=${encodeURIComponent(token)}`,
  };
};

/**
 * The headers for a link already resolved by `unsubscribeUrl`.
 *
 * Takes the URL rather than resolving it again so the header and the footer
 * cannot disagree, and so a refusal is handled once by the caller instead of
 * twice here.
 */
export const unsubscribeHeaders = (
  url: string | null
): Record<string, string> => {
  if (!url) return {};

  return {
    // The URL form rather than a mailto: the one-click POST goes to the API
    // route, and a mailto would put the burden on a human reading an inbox.
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
};
