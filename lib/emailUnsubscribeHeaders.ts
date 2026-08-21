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

export const unsubscribeHeaders = (input: {
  requiresUnsubscribe: boolean;
  userId: string | null;
  purpose: string | null;
  deliveryId: string;
  appUrl: string;
}): Record<string, string> => {
  if (!input.requiresUnsubscribe || !input.userId || !input.purpose) return {};

  const keyring = readUnsubscribeKeyring(process.env);
  if (!keyring) {
    // A marketing message with no working unsubscribe link is one that must not
    // be sent at all, so this is a refusal rather than a message without
    // headers.
    throw new Error(
      "EMAIL_UNSUBSCRIBE_KEYS is not configured, so no unsubscribe link can be " +
        "generated. Marketing mail cannot be sent without one."
    );
  }

  const token = createUnsubscribeToken(
    { userId: input.userId, purpose: input.purpose, deliveryId: input.deliveryId },
    keyring
  );
  const url = `${input.appUrl}/unsubscribe?t=${encodeURIComponent(token)}`;

  return {
    // The URL form rather than a mailto: the one-click POST goes to the API
    // route, and a mailto would put the burden on a human reading an inbox.
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
};
