// What actually fails together (G3 in
// docs/policy/tomverse-chat-model-capability-inventory.md).
//
// The routing policy prefers a fallback candidate in a different failure domain
// from the primary, so that a fallback is not simply a second attempt at the
// same broken thing. Until now `provider` was the only proxy available.
//
// Measured against today's catalogue, provider is an accurate proxy: 11
// providers, 11 distinct hosts, 11 distinct credentials, and no credential
// shared across providers. But it is *accidentally* accurate. Nothing keeps it
// that way, and two changes would break it quietly:
//
//   - an OpenAI-compatible gateway put in front of several vendors, which makes
//     one host the thing that fails while the labels stay distinct;
//   - one credential reused across providers, where a revoked or exhausted key
//     takes every model with it however healthy each vendor is.
//
// So the domain is derived from the mechanism rather than the label. Today it
// partitions models exactly as provider does -- pinned by a test -- and when
// that stops being true the Router follows what shares fate rather than what
// shares a name.

export type FailureDomainInput = {
  provider: string;
  /** Explicit endpoint, when the model does not use its SDK's default host. */
  apiBaseUrl?: string | null;
  /** Environment variable holding the credential this model authenticates with. */
  apiKeyEnvName?: string | null;
};

const hostOf = ({ provider, apiBaseUrl }: FailureDomainInput) => {
  if (!apiBaseUrl) return `sdk:${provider}`;
  try {
    return new URL(apiBaseUrl).host.toLowerCase();
  } catch {
    // An unparseable base URL is still a distinct configuration, and treating
    // it as the SDK default would silently merge it with models that really do
    // use the default.
    return `raw:${apiBaseUrl}`;
  }
};

const credentialOf = ({ provider, apiKeyEnvName }: FailureDomainInput) =>
  apiKeyEnvName ? apiKeyEnvName : `default:${provider}`;

/**
 * A stable identifier for the set of models that fail together.
 *
 * Host and credential, not provider: those are the two things a real outage
 * runs through. A shared host fails as one endpoint; a shared credential fails
 * as one account. When neither is set explicitly, both fall back to values
 * derived from the provider, so a catalogue that names no endpoints partitions
 * exactly by provider -- which is what today's does.
 */
export const failureDomainOf = (model: FailureDomainInput) =>
  `${hostOf(model)}|${credentialOf(model)}`;

/**
 * Whether a fallback candidate would share fate with the attempt it is
 * replacing. A candidate in the same domain is not a fallback, it is a retry.
 */
export const sharesFailureDomain = (left: FailureDomainInput, right: FailureDomainInput) =>
  failureDomainOf(left) === failureDomainOf(right);

/**
 * Groups models by failure domain. Useful for asserting the partition and for
 * ordering fallback candidates so a different domain is preferred first.
 */
export const groupByFailureDomain = <T extends FailureDomainInput>(models: readonly T[]) => {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const domain = failureDomainOf(model);
    const bucket = groups.get(domain) ?? [];
    bucket.push(model);
    groups.set(domain, bucket);
  }
  return groups;
};
