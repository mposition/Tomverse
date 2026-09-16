/**
 * The domain a message actually went out from, read off the From header the
 * provider accepted.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.
 * Pure, so the parse is tested without a provider.
 */
export const sentDomainOf = (from: string | null | undefined): string | null => {
  if (!from) return null;
  const angle = from.match(/<([^<>]+)>\s*$/);
  const address = (angle ? angle[1] : from).trim();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]+$/.test(domain) ? domain : null;
};
